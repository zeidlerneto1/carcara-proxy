import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

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
}

const DEFAULT_CONFIG: SandboxConfig = {
  timeoutMs: 30000,
  memoryLimitMb: 256,
  cpuPercent: 50,
  networkEnabled: false,
  readOnlyRoot: true,
  allowedLanguages: ['python', 'javascript', 'bash'],
};

export class SandboxService {
  private config: SandboxConfig;
  private sandboxDir: string;
  private _dockerAvailable: boolean | null = null;

  constructor(config: Partial<SandboxConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sandboxDir = path.join(process.cwd(), '.carcara', 'sandbox-runs');
    this.ensureDir().catch(() => {});
  }

  /** Detecta Docker no startup. Retorna true se disponivel. */
  async detectDocker(): Promise<boolean> {
    if (this._dockerAvailable !== null) return this._dockerAvailable;
    this._dockerAvailable = await new Promise<boolean>((resolve) => {
      const docker = spawn('docker', ['version']);
      docker.on('error', () => resolve(false));
      docker.on('close', (code) => resolve(code === 0));
    });
    logger.info({ dockerAvailable: this._dockerAvailable }, 'Docker detectado');
    return this._dockerAvailable;
  }

  get dockerAvailable(): boolean | null {
    return this._dockerAvailable;
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.sandboxDir, { recursive: true });
  }

  async execute(code: string, language: SandboxLanguage): Promise<SandboxResult> {
    const dockerOk = await this.detectDocker();
    if (!dockerOk) {
      throw new Error('Docker nao disponivel. Sandbox desabilitado.');
    }

    if (!this.config.allowedLanguages.includes(language)) {
      throw new Error(`Linguagem '${language}' nao permitida. Use: ${this.config.allowedLanguages.join(', ')}`);
    }

    const runId = `run_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const runDir = path.join(this.sandboxDir, runId);
    await fs.mkdir(runDir, { recursive: true });

    const { fileName, image, cmd } = this.getDockerConfig(language, runId);
    const filePath = path.join(runDir, fileName);
    await fs.writeFile(filePath, code, 'utf-8');

    logger.info({ runId, language, image }, 'Iniciando sandbox Docker');

    const startTime = Date.now();
    const result = await this.runDocker(image, cmd, runDir);
    const durationMs = Date.now() - startTime;

    await this.cleanup(runDir, runId);

    logger.info({ runId, exitCode: result.exitCode, durationMs }, 'Sandbox completo');
    return { ...result, durationMs };
  }

  private runDocker(image: string, cmd: string[], hostDir: string): Promise<SandboxResult> {
    return new Promise((resolve) => {
      const args = [
        'run', '--rm',
        '--network=' + (this.config.networkEnabled ? 'bridge' : 'none'),
        '--memory=' + this.config.memoryLimitMb + 'm',
        '--memory-swap=' + this.config.memoryLimitMb + 'm',
        '--cpus=' + (this.config.cpuPercent / 100),
        '--read-only=' + (this.config.readOnlyRoot ? 'true' : 'false'),
        '--user=1000:1000',
        '--security-opt=no-new-privileges:true',
        '--cap-drop=ALL',
        '-v', `${hostDir}:/sandbox:rw`,
        '-w', '/sandbox',
        image, ...cmd,
      ];

      const docker = spawn('docker', args, {
        timeout: this.config.timeoutMs,
        killSignal: 'SIGKILL',
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      docker.stdout?.on('data', (data) => {
        stdout += data.toString();
        if (stdout.length > 1024 * 1024) {
          killed = true;
          try { process.kill(docker.pid!, 9); } catch {}
        }
      });

      docker.stderr?.on('data', (data) => { stderr += data.toString(); });

      docker.on('close', (exitCode) => {
        if (!killed) {
          resolve({
            stdout: stdout.slice(0, 100000),
            stderr: stderr.slice(0, 100000),
            exitCode: exitCode ?? -1,
            durationMs: 0,
            killed: false,
          });
        }
      });

      docker.on('error', (err) => {
        if (!killed) {
          resolve({
            stdout,
            stderr: stderr + '\n[ERROR] ' + err.message,
            exitCode: -1,
            durationMs: 0,
            killed: false,
          });
        }
      });
    });
  }

  private getDockerConfig(lang: SandboxLanguage, runId: string): { fileName: string; image: string; cmd: string[] } {
    switch (lang) {
      case 'python': return { fileName: 'main.py', image: 'python:3.11-alpine', cmd: ['python', '/sandbox/main.py'] };
      case 'javascript': return { fileName: 'main.js', image: 'node:20-alpine', cmd: ['node', '/sandbox/main.js'] };
      case 'typescript': return { fileName: 'main.ts', image: 'node:20-alpine', cmd: ['npx', 'tsx', '/sandbox/main.ts'] };
      case 'bash':
      case 'sh': return { fileName: 'main.sh', image: 'alpine:3.19', cmd: ['sh', '/sandbox/main.sh'] };
      default: throw new Error(`Linguagem nao suportada: ${lang}`);
    }
  }

  private async cleanup(hostDir: string, runId: string): Promise<void> {
    try { spawn('docker', ['kill', runId]).unref(); } catch {}
    try { await fs.rm(hostDir, { recursive: true, force: true }); } catch (e: any) {
      logger.warn({ error: e.message }, 'Falha ao limpar sandbox');
    }
  }

  setConfig(cfg: Partial<SandboxConfig>): void {
    this.config = { ...this.config, ...cfg };
  }

  getConfig(): SandboxConfig {
    return { ...this.config };
  }
}
