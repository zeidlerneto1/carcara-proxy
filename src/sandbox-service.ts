import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import pino from 'pino';

const logger = pino({ level: 'info' });

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

/**
 * SandboxService - Executa código em containers Docker isolados.
 * 
 * Arquitetura:
 *   1. Recebe código + linguagem
 *   2. Escreve em arquivo temporário
 *   3. Executa via `docker run` com flags de segurança
 *   4. Captura stdout/stderr/exitCode
 *   5. Limpa container e arquivo
 * 
 * Segurança:
 *   --network=none (sem internet)
 *   --read-only (filesystem read-only)
 *   --memory=256m (limite de RAM)
 *   --cpus=0.5 (limite de CPU)
 *   --rm (auto-remove após execução)
 *   --user=1000:1000 (não roda como root)
 *   -v /tmp/sandbox:/sandbox:rw (só essa pasta é writable)
 */
export class SandboxService {
  private config: SandboxConfig;
  private sandboxDir: string;

  constructor(config: Partial<SandboxConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sandboxDir = path.join(process.cwd(), '.carcara', 'sandbox-runs');
    this.ensureDir().catch(() => {});
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.sandboxDir, { recursive: true });
  }

  // ==========================================================================
  // EXECUÇÃO PRINCIPAL
  // ==========================================================================

  async execute(code: string, language: SandboxLanguage): Promise<SandboxResult> {
    if (!this.config.allowedLanguages.includes(language)) {
      throw new Error(`Linguagem '${language}' nao permitida. Use: ${this.config.allowedLanguages.join(', ')}`);
    }

    const runId = `run_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const runDir = path.join(this.sandboxDir, runId);
    await fs.mkdir(runDir, { recursive: true });

    const { fileName, image, cmd } = this.getDockerConfig(language, runId);
    const filePath = path.join(runDir, fileName);
    await fs.writeFile(filePath, code, 'utf-8');

    logger.info({ runId, language, image }, 'Iniciando sandbox');

    const startTime = Date.now();
    const result = await this.runDocker(image, cmd, runDir);
    const durationMs = Date.now() - startTime;

    // Cleanup
    await this.cleanup(runDir, runId);

    logger.info({ runId, exitCode: result.exitCode, durationMs }, 'Sandbox completo');

    return {
      ...result,
      durationMs,
    };
  }

  // ==========================================================================
  // DOCKER RUN
  // ==========================================================================

  private runDocker(image: string, cmd: string[], hostDir: string): Promise<SandboxResult> {
    return new Promise((resolve) => {
      const args = [
        'run',
        '--rm',
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
        image,
        ...cmd,
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
      });

      docker.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      docker.on('error', (err) => {
        resolve({
          stdout,
          stderr: stderr || err.message,
          exitCode: -1,
          durationMs: 0,
          killed: false,
        });
      });

      docker.on('close', (code, signal) => {
        if (signal === 'SIGKILL' || signal === 'SIGTERM') {
          killed = true;
        }
        resolve({
          stdout,
          stderr,
          exitCode: code ?? -1,
          durationMs: 0,
          killed,
        });
      });
    });
  }

  // ==========================================================================
  // CONFIG POR LINGUAGEM
  // ==========================================================================

  private getDockerConfig(lang: SandboxLanguage, runId: string): { fileName: string; image: string; cmd: string[] } {
    switch (lang) {
      case 'python':
        return {
          fileName: 'main.py',
          image: 'python:3.11-alpine',
          cmd: ['python', '/sandbox/main.py'],
        };
      case 'javascript':
        return {
          fileName: 'main.js',
          image: 'node:20-alpine',
          cmd: ['node', '/sandbox/main.js'],
        };
      case 'typescript':
        return {
          fileName: 'main.ts',
          image: 'node:20-alpine',
          cmd: ['npx', 'tsx', '/sandbox/main.ts'],
        };
      case 'bash':
      case 'sh':
        return {
          fileName: 'main.sh',
          image: 'alpine:3.19',
          cmd: ['sh', '/sandbox/main.sh'],
        };
      default:
        throw new Error(`Linguagem nao suportada: ${lang}`);
    }
  }

  // ==========================================================================
  // CLEANUP
  // ==========================================================================

  private async cleanup(hostDir: string, runId: string): Promise<void> {
    try {
      // Mata container se ainda rodando
      spawn('docker', ['kill', runId]).unref();
    } catch {}

    try {
      // Remove pasta do host
      await fs.rm(hostDir, { recursive: true, force: true });
    } catch (e: any) {
      logger.warn({ error: e.message }, 'Falha ao limpar sandbox');
    }
  }

  // ==========================================================================
  // CONFIG
  // ==========================================================================

  setConfig(cfg: Partial<SandboxConfig>): void {
    this.config = { ...this.config, ...cfg };
  }

  getConfig(): SandboxConfig {
    return { ...this.config };
  }

  async isDockerAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const docker = spawn('docker', ['version']);
      docker.on('error', () => resolve(false));
      docker.on('close', (code) => resolve(code === 0));
    });
  }
}
