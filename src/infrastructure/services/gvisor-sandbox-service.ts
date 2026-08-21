import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const execAsync = promisify(exec);

export type SandboxLanguage = 'python' | 'javascript' | 'typescript' | 'bash' | 'sh' | 'node';

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  containerName: string;
}

export interface SandboxConfig {
  timeoutMs: number;
  memoryLimitMb: number;
  cpuPercent: number;
  networkEnabled: boolean;
  allowedLanguages: SandboxLanguage[];
  runtime: 'docker' | 'podman' | 'gvisor';
  blockInternalNetwork: boolean;
  containerPrefix: string;
}

const DEFAULT_CONFIG: SandboxConfig = {
  timeoutMs: 30000,
  memoryLimitMb: 512,
  cpuPercent: 50,
  networkEnabled: true,
  allowedLanguages: ['python', 'javascript', 'bash', 'node'],
  runtime: 'docker',
  blockInternalNetwork: true,
  containerPrefix: 'carcara-sandbox',
};

export class GVisorSandboxService {
  private config: SandboxConfig;
  private sandboxDir: string;
  private _runtimeAvailable: boolean | null = null;

  constructor(config: Partial<SandboxConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sandboxDir = path.join(process.cwd(), '.carcara', 'sandbox-runs');
    this.ensureDir().catch(() => {});
  }

  async detectRuntime(): Promise<boolean> {
    if (this._runtimeAvailable !== null) return this._runtimeAvailable;
    try {
      if (this.config.runtime === 'gvisor') {
        const { stdout } = await execAsync('which runsc');
        this._runtimeAvailable = !!stdout.trim();
      } else if (this.config.runtime === 'podman') {
        const { stdout } = await execAsync('podman --version');
        this._runtimeAvailable = !!stdout.trim();
      } else {
        const { stdout } = await execAsync('docker version --format "{{.Server.Version}}"');
        this._runtimeAvailable = !!stdout.trim();
      }
    } catch {
      this._runtimeAvailable = false;
    }
    logger.info({ runtime: this.config.runtime, available: this._runtimeAvailable }, 'Runtime detectado');
    return this._runtimeAvailable;
  }

  get runtimeAvailable(): boolean | null {
    return this._runtimeAvailable;
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.sandboxDir, { recursive: true });
  }

  async execute(code: string, language: SandboxLanguage, sessionId?: string, workspaceReadOnly: boolean = true): Promise<SandboxResult> {
    const runtimeOk = await this.detectRuntime();
    if (!runtimeOk) throw new Error(`${this.config.runtime} nao disponivel.`);
    if (!this.config.allowedLanguages.includes(language)) {
      throw new Error(`Linguagem '${language}' nao permitida.`);
    }

    const sid = sessionId || `sess_${Date.now()}`;
    const workDir = path.join(this.sandboxDir, sid);
    await fs.mkdir(workDir, { recursive: true });

    const { fileName, image, cmd } = this.getContainerConfig(language);
    const filePath = path.join(workDir, fileName);
    await fs.writeFile(filePath, code, 'utf-8');

    const containerName = `${this.config.containerPrefix}-${sid}-${language}`;
    const startTime = Date.now();

    const result = await this.runContainer(containerName, image, workDir, cmd, workspaceReadOnly);
    const durationMs = Date.now() - startTime;

    logger.info({ container: containerName, language, exitCode: result.exitCode, durationMs }, 'Execucao sandbox completa');
    return { ...result, durationMs, containerName };
  }

  private async runContainer(name: string, image: string, workDir: string, cmd: string[], workspaceReadOnly: boolean = true): Promise<SandboxResult> {
    const { runtime, memoryLimitMb, cpuPercent, networkEnabled, blockInternalNetwork } = this.config;

    const baseArgs: string[] = [];

    if (runtime === 'docker') {
      baseArgs.push('run', '--rm');
      if (blockInternalNetwork) {
        baseArgs.push('--network=none');
      } else if (!networkEnabled) {
        baseArgs.push('--network=none');
      }
      baseArgs.push(
        `--memory=${memoryLimitMb}m`,
        `--memory-swap=${memoryLimitMb}m`,
        `--cpus=${cpuPercent / 100}`,
        '--read-only',
        '--user=1000:1000',
        '--security-opt=no-new-privileges:true',
        '--cap-drop=ALL',
        '-v', `${workDir}:/sandbox:rw`,
        '-v', `${process.cwd()}:/workspace:${workspaceReadOnly ? 'ro' : 'rw'}`,
        '-w', '/sandbox',
        '--name', name,
        image,
        ...cmd
      );
      return this.execWithTimeout('docker', baseArgs);
    }

    if (runtime === 'podman') {
      baseArgs.push('run', '--rm');
      if (blockInternalNetwork || !networkEnabled) {
        baseArgs.push('--network=none');
      }
      baseArgs.push(
        `--memory=${memoryLimitMb}m`,
        `--cpus=${cpuPercent / 100}`,
        '--read-only',
        '--user=1000:1000',
        '--security-opt=no-new-privileges',
        '--cap-drop=ALL',
        '-v', `${workDir}:/sandbox:rw,Z`,
        '-v', `${process.cwd()}:/workspace:${workspaceReadOnly ? 'ro' : 'rw'},Z`,
        '-w', '/sandbox',
        '--name', name,
        image,
        ...cmd
      );
      return this.execWithTimeout('podman', baseArgs);
    }

    if (runtime === 'gvisor') {
      baseArgs.push('run', '--rm', '--runtime=runsc');
      if (blockInternalNetwork || !networkEnabled) {
        baseArgs.push('--network=none');
      }
      baseArgs.push(
        `--memory=${memoryLimitMb}m`,
        `--cpus=${cpuPercent / 100}`,
        '--read-only',
        '--user=1000:1000',
        '--security-opt=no-new-privileges:true',
        '--cap-drop=ALL',
        '-v', `${workDir}:/sandbox:rw`,
        '-v', `${process.cwd()}:/workspace:${workspaceReadOnly ? 'ro' : 'rw'}`,
        '-w', '/sandbox',
        '--name', name,
        image,
        ...cmd
      );
      return this.execWithTimeout('docker', baseArgs);
    }

    throw new Error(`Runtime nao suportado: ${runtime}`);
  }

  private execWithTimeout(command: string, args: string[]): Promise<SandboxResult> {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        timeout: this.config.timeoutMs,
        killSignal: 'SIGKILL',
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
        if (stdout.length > 1024 * 1024) {
          killed = true;
          try { process.kill(child.pid!, 9); } catch {}
        }
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (exitCode) => {
        if (!killed) {
          resolve({
            stdout: stdout.slice(0, 100000),
            stderr: stderr.slice(0, 100000),
            exitCode: exitCode ?? -1,
            durationMs: 0,
          });
        }
      });

      child.on('error', (err) => {
        if (!killed) {
          resolve({
            stdout: stdout.slice(0, 100000),
            stderr: stderr + '\n[ERROR] ' + err.message,
            exitCode: -1,
            durationMs: 0,
          });
        }
      });
    });
  }

  private getContainerConfig(lang: SandboxLanguage): { fileName: string; image: string; cmd: string[] } {
    switch (lang) {
      case 'python': return { fileName: 'main.py', image: 'python:3.11-alpine', cmd: ['python', '/sandbox/main.py'] };
      case 'javascript': return { fileName: 'main.js', image: 'node:20-alpine', cmd: ['node', '/sandbox/main.js'] };
      case 'typescript': return { fileName: 'main.ts', image: 'node:20-alpine', cmd: ['npx', 'tsx', '/sandbox/main.ts'] };
      case 'node': return { fileName: 'main.sh', image: 'node:20-alpine', cmd: ['sh', '/sandbox/main.sh'] };
      case 'bash':
      case 'sh': return { fileName: 'main.sh', image: 'alpine:3.19', cmd: ['sh', '/sandbox/main.sh'] };
      default: throw new Error(`Linguagem nao suportada: ${lang}`);
    }
  }

  setConfig(cfg: Partial<SandboxConfig>): void {
    this.config = { ...this.config, ...cfg };
    this._runtimeAvailable = null;
  }

  getConfig(): SandboxConfig {
    return { ...this.config };
  }

  async getActiveContainers(): Promise<string[]> {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    try {
      const { stdout } = await execAsync(`docker ps --filter "name=${this.config.containerPrefix}" --format "{{.Names}}" 2>/dev/null || podman ps --filter "name=${this.config.containerPrefix}" --format "{{.Names}}" 2>/dev/null`);
      return stdout.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}
