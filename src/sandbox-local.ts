import { exec, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import pino from 'pino';

const logger = pino({ level: 'info' });

export type LocalSandboxLanguage = 'python' | 'javascript' | 'bash' | 'sh' | 'cmd';

export interface LocalSandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  killed: boolean;
}

export interface LocalSandboxConfig {
  timeoutMs: number;
  memoryLimitMb: number;
  allowedLanguages: LocalSandboxLanguage[];
  workingDir: string;
}

const DEFAULT_CONFIG: LocalSandboxConfig = {
  timeoutMs: 30000,
  memoryLimitMb: 512,
  allowedLanguages: ['python', 'javascript', 'bash', 'sh', 'cmd'],
  workingDir: '',
};

/**
 * LocalSandboxService - Executa código localmente via child_process.
 * Útil quando Docker não está disponível (ex: VS Code no Windows).
 *
 * Segurança:
 *   - Timeout kill automático
 * - Sem acesso a variáveis de ambiente sensíveis
 * - Restrito às linguagens permitidas
 * - stdout/stderr capturados (não herda TTY)
 */
export class LocalSandboxService {
  private config: LocalSandboxConfig;

  constructor(config: Partial<LocalSandboxConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getConfig(): LocalSandboxConfig {
    return { ...this.config };
  }

  setConfig(partial: Partial<LocalSandboxConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  /**
   * Verifica se uma linguagem está disponível no sistema.
   */
  async isLanguageAvailable(language: LocalSandboxLanguage): Promise<boolean> {
    const checkCmd =
      language === 'python' ? 'python --version || python3 --version' :
      language === 'javascript' ? 'node --version' :
      language === 'bash' || language === 'sh' ? 'sh --version || echo ok' :
      language === 'cmd' ? 'echo ok' :
      'false';

    return new Promise((resolve) => {
      exec(checkCmd, { timeout: 5000 }, (err) => {
        resolve(!err);
      });
    });
  }

  /**
   * Executa código localmente.
   */
  async execute(code: string, language: LocalSandboxLanguage): Promise<LocalSandboxResult> {
    if (!this.config.allowedLanguages.includes(language)) {
      throw new Error(`Language "${language}" not allowed. Allowed: ${this.config.allowedLanguages.join(', ')}`);
    }

    const start = Date.now();
    const tempDir = path.join(process.cwd(), '.carcara', 'sandbox-local');
    await fs.mkdir(tempDir, { recursive: true });

    let fileName: string;
    let command: string;
    let args: string[];

    switch (language) {
      case 'python':
        fileName = `sandbox_${Date.now()}.py`;
        await fs.writeFile(path.join(tempDir, fileName), code, 'utf8');
        command = process.platform === 'win32' ? 'python' : 'python3';
        args = [path.join(tempDir, fileName)];
        break;
      case 'javascript':
        fileName = `sandbox_${Date.now()}.js`;
        await fs.writeFile(path.join(tempDir, fileName), code, 'utf8');
        command = 'node';
        args = [path.join(tempDir, fileName)];
        break;
      case 'bash':
      case 'sh':
        fileName = `sandbox_${Date.now()}.sh`;
        await fs.writeFile(path.join(tempDir, fileName), code, 'utf8');
        command = process.platform === 'win32' ? 'bash' : 'sh';
        args = [path.join(tempDir, fileName)];
        break;
      case 'cmd':
        fileName = `sandbox_${Date.now()}.bat`;
        await fs.writeFile(path.join(tempDir, fileName), code, 'utf8');
        command = 'cmd';
        args = ['/c', path.join(tempDir, fileName)];
        break;
      default:
        throw new Error(`Unsupported language: ${language}`);
    }

    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: this.config.workingDir || tempDir,
        env: {
          PATH: process.env.PATH || '',
          NODE_NO_WARNINGS: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      const timeout = setTimeout(() => {
        killed = true;
        try {
          process.kill(child.pid!, 9);
        } catch {}
        resolve({
          stdout,
          stderr: stderr + '\n[TIMEOUT] Execution exceeded ' + this.config.timeoutMs + 'ms',
          exitCode: -1,
          durationMs: this.config.timeoutMs,
          killed: true,
        });
      }, this.config.timeoutMs);

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
        // Kill se stdout muito grande (proteção contra spam)
        if (stdout.length > 1024 * 1024) {
          killed = true;
          try { process.kill(child.pid!, 9); } catch {}
        }
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (exitCode) => {
        clearTimeout(timeout);
        if (!killed) {
          resolve({
            stdout: stdout.slice(0, 100000),
            stderr: stderr.slice(0, 100000),
            exitCode: exitCode ?? -1,
            durationMs: Date.now() - start,
            killed: false,
          });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        if (!killed) {
          resolve({
            stdout,
            stderr: stderr + '\n[ERROR] ' + err.message,
            exitCode: -1,
            durationMs: Date.now() - start,
            killed: false,
          });
        }
      });
    });
  }
}
