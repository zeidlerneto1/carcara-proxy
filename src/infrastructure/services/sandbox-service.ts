import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import pino from 'pino';
import { DockerManager } from './docker-manager.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const execAsync = promisify(exec);

export type SandboxLanguage = 'python' | 'javascript' | 'typescript' | 'bash' | 'sh';

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  killed: boolean;
  memoryPeakMb?: number;
}

export interface SandboxConfig {
  timeoutMs: number;
  memoryLimitMb: number;
  cpuPercent: number;
  networkEnabled: boolean;
  readOnlyRoot: boolean;
  allowedLanguages: SandboxLanguage[];
  containerPrefix: string;
  sessionTimeoutMs: number;
}

const DEFAULT_CONFIG: SandboxConfig = {
  timeoutMs: 30000,
  memoryLimitMb: 256,
  cpuPercent: 50,
  networkEnabled: true,
  readOnlyRoot: true,
  allowedLanguages: ['python', 'javascript', 'bash'],
  containerPrefix: 'carcara-sandbox',
  sessionTimeoutMs: 10 * 60 * 1000,
};

interface PersistentContainer {
  name: string;
  sessionId: string;
  image: string;
  language: SandboxLanguage;
  createdAt: number;
  lastUsedAt: number;
  workDir: string;
}

/**
 * SandboxService com Docker Persistente e Cross-Platform Support.
 * 
 * - Usa DockerManager para detectar OS e estado do Docker
 * - Container nomeado por sessão (carcara-sandbox-{sessionId})
 * - Executa via docker exec (2-3s mais rápido)
 * - Auto-inicia Docker Desktop no Windows se necessário
 * - Estado persistente entre execuções
 * - Cleanup automático após timeout
 */
export class SandboxService {
  private config: SandboxConfig;
  private sandboxDir: string;
  private _dockerAvailable: boolean | null = null;
  private containers = new Map<string, PersistentContainer>();
  private cleanupTimers = new Map<string, NodeJS.Timeout>();
  private dockerManager: DockerManager;

  constructor(config: Partial<SandboxConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sandboxDir = path.join(process.cwd(), '.carcara', 'sandbox-runs');
    this.dockerManager = new DockerManager();
    this.ensureDir().catch(() => {});
    this._startGlobalCleanup();
  }

  /** 
   * Detecta Docker usando DockerManager (cross-platform).
   * No Windows, tenta auto-iniciar Docker Desktop.
   */
  async detectDocker(): Promise<boolean> {
    if (this._dockerAvailable !== null) return this._dockerAvailable;

    const status = await this.dockerManager.checkStatus();
    this._dockerAvailable = status.available && status.running;

    if (this._dockerAvailable) {
      logger.info({ 
        version: status.version, 
        os: status.os,
        wsl2: status.wsl2,
        dockerDesktop: status.dockerDesktop 
      }, 'Docker pronto');
    } else {
      logger.warn({ 
        os: status.os,
        error: status.error,
        hint: status.os === 'windows' 
          ? 'Instale Docker Desktop: https://www.docker.com/products/docker-desktop'
          : 'Instale Docker: sudo apt-get install docker.io'
      }, 'Docker não disponível');
    }

    return this._dockerAvailable;
  }

  get dockerAvailable(): boolean | null {
    return this._dockerAvailable;
  }

  getDockerManager(): DockerManager {
    return this.dockerManager;
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.sandboxDir, { recursive: true });
  }

  private async getOrCreateContainer(sessionId: string, language: SandboxLanguage): Promise<PersistentContainer> {
    const containerKey = `${sessionId}_${language}`;
    const existing = this.containers.get(containerKey);
    if (existing) {
      try {
        await execAsync(`docker inspect -f "{{.State.Running}}" ${existing.name}`);
        existing.lastUsedAt = Date.now();
        this._resetCleanupTimer(containerKey);
        logger.info({ container: existing.name }, 'Container persistente reutilizado');
        return existing;
      } catch {
        this.containers.delete(containerKey);
      }
    }

    const { image } = this.getDockerConfig(language);
    const containerName = `${this.config.containerPrefix}-${sessionId}-${language}`;
    const workDir = path.join(this.sandboxDir, sessionId);
    await fs.mkdir(workDir, { recursive: true });

    const dockerArgs = [
      'run', '-d',
      '--name', containerName,
      '--network=' + (this.config.networkEnabled ? 'bridge' : 'none'),
      '--memory=' + this.config.memoryLimitMb + 'm',
      '--memory-swap=' + this.config.memoryLimitMb + 'm',
      '--cpus=' + (this.config.cpuPercent / 100),
      '--read-only=' + (this.config.readOnlyRoot ? 'true' : 'false'),
      '--user=1000:1000',
      '--security-opt=no-new-privileges:true',
      '--cap-drop=ALL',
      '-v', `${workDir}:/sandbox:rw`,
      '-w', '/sandbox',
      image,
      'sh', '-c', 'mkdir -p /tmp/writable && tail -f /dev/null',
    ];

    logger.info({ containerName, language, image }, 'Criando container persistente');
    const { stderr } = await execAsync(`docker ${dockerArgs.join(' ')}`);
    if (stderr && !stderr.includes(containerName)) logger.warn({ stderr }, 'Docker run stderr');

    const container: PersistentContainer = {
      name: containerName, sessionId, image, language,
      createdAt: Date.now(), lastUsedAt: Date.now(), workDir,
    };
    this.containers.set(containerKey, container);
    this._resetCleanupTimer(containerKey);
    logger.info({ containerName, language }, 'Container persistente criado');
    return container;
  }

  async execute(code: string, language: SandboxLanguage, sessionId?: string): Promise<SandboxResult> {
    const dockerOk = await this.detectDocker();
    if (!dockerOk) {
      const env = this.dockerManager.getEnvironmentInfo();
      throw new Error(`Docker não disponível no ${env.os}. ${env.dockerStatus?.error || ''}`);
    }

    if (!this.config.allowedLanguages.includes(language)) {
      throw new Error(`Linguagem '${language}' não permitida.`);
    }

    const sid = sessionId || `session_${Date.now()}`;
    const container = await this.getOrCreateContainer(sid, language);
    const { fileName, cmd } = this.getDockerConfig(language);
    const filePath = path.join(container.workDir, fileName);
    await fs.writeFile(filePath, code, 'utf-8');

    logger.info({ container: container.name, language, sessionId: sid }, 'Executando via docker exec');
    const startTime = Date.now();
    const result = await this.execInContainer(container.name, cmd);
    const durationMs = Date.now() - startTime;
    container.lastUsedAt = Date.now();
    this._resetCleanupTimer(`${sid}_${language}`);
    logger.info({ container: container.name, exitCode: result.exitCode, durationMs }, 'Execução completa');
    return { ...result, durationMs };
  }

  private execInContainer(containerName: string, cmd: string[]): Promise<SandboxResult> {
    return new Promise((resolve) => {
      const docker = spawn('docker', ['exec', '--user=1000:1000', containerName, ...cmd], {
        timeout: this.config.timeoutMs, killSignal: 'SIGKILL',
      });
      let stdout = ''; let stderr = ''; let killed = false;
      docker.stdout?.on('data', (data) => {
        stdout += data.toString();
        if (stdout.length > 1024 * 1024) { killed = true; try { process.kill(docker.pid!, 9); } catch {} }
      });
      docker.stderr?.on('data', (data) => { stderr += data.toString(); });
      docker.on('close', (exitCode) => {
        if (!killed) resolve({ stdout: stdout.slice(0, 100000), stderr: stderr.slice(0, 100000), exitCode: exitCode ?? -1, durationMs: 0, killed: false });
      });
      docker.on('error', (err) => {
        if (!killed) resolve({ stdout, stderr: stderr + '\n[ERROR] ' + err.message, exitCode: -1, durationMs: 0, killed: false });
      });
    });
  }

  private getDockerConfig(lang: SandboxLanguage): { fileName: string; image: string; cmd: string[] } {
    switch (lang) {
      case 'python': return { fileName: 'main.py', image: 'python:3.11-alpine', cmd: ['python', '/sandbox/main.py'] };
      case 'javascript': return { fileName: 'main.js', image: 'node:20-alpine', cmd: ['node', '/sandbox/main.js'] };
      case 'typescript': return { fileName: 'main.ts', image: 'node:20-alpine', cmd: ['npx', 'tsx', '/sandbox/main.ts'] };
      case 'bash':
      case 'sh': return { fileName: 'main.sh', image: 'alpine:3.19', cmd: ['sh', '/sandbox/main.sh'] };
      default: throw new Error(`Linguagem não suportada: ${lang}`);
    }
  }

  private _resetCleanupTimer(containerKey: string): void {
    const existing = this.cleanupTimers.get(containerKey);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => { this._destroyContainer(containerKey); }, this.config.sessionTimeoutMs);
    this.cleanupTimers.set(containerKey, timer);
  }

  private async _destroyContainer(containerKey: string): Promise<void> {
    const container = this.containers.get(containerKey);
    if (!container) return;
    try {
      await execAsync(`docker kill ${container.name}`);
      await execAsync(`docker rm ${container.name}`);
      logger.info({ container: container.name }, 'Container destruído');
    } catch (err: any) {
      logger.warn({ error: err.message, container: container.name }, 'Erro ao destruir');
    }
    this.containers.delete(containerKey);
    this.cleanupTimers.delete(containerKey);
  }

  async cleanupAll(): Promise<void> {
    for (const [key] of this.containers) await this._destroyContainer(key);
    for (const timer of this.cleanupTimers.values()) clearTimeout(timer);
    this.cleanupTimers.clear();
    logger.info('Todos os containers destruídos');
  }

  async cleanupSession(sessionId: string): Promise<void> {
    for (const [key, container] of this.containers) {
      if (container.sessionId === sessionId) await this._destroyContainer(key);
    }
  }

  listContainers(): PersistentContainer[] {
    return Array.from(this.containers.values());
  }

  private _startGlobalCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [key, container] of this.containers) {
        if (now - container.lastUsedAt > this.config.sessionTimeoutMs) this._destroyContainer(key);
      }
    }, 5 * 60 * 1000);
  }

  setConfig(cfg: Partial<SandboxConfig>): void {
    this.config = { ...this.config, ...cfg };
  }

  getConfig(): SandboxConfig {
    return { ...this.config };
  }
}
