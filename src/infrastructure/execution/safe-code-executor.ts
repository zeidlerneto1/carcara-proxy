import { runInNewContext } from 'vm';
import { exec } from 'child_process';
import { promisify } from 'util';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const execAsync = promisify(exec);

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface ExecutionConfig {
  timeoutMs: number;
  maxOutputLength: number;
  allowedJsGlobals: string[];
}

const DEFAULT_CONFIG: ExecutionConfig = {
  timeoutMs: 10000,
  maxOutputLength: 50000,
  allowedJsGlobals: ['Math', 'JSON', 'Date', 'Array', 'Object', 'String', 'Number', 'Boolean', 'console'],
};

export class SafeCodeExecutor {
  private config: ExecutionConfig;

  constructor(config: Partial<ExecutionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async execute(code: string, language: 'javascript' | 'python' | 'bash'): Promise<ExecutionResult> {
    const start = Date.now();
    try {
      switch (language) {
        case 'javascript':
          return await this._executeJs(code);
        case 'python':
          return await this._executePython(code);
        case 'bash':
          return await this._executeBash(code);
        default:
          throw new Error(`Linguagem nao suportada: ${language}`);
      }
    } catch (err: any) {
      return {
        stdout: '',
        stderr: err.message,
        exitCode: -1,
        durationMs: Date.now() - start,
      };
    }
  }

  private async _executeJs(code: string): Promise<ExecutionResult> {
    const start = Date.now();
    const sandbox: any = {};
    for (const g of this.config.allowedJsGlobals) {
      sandbox[g] = (globalThis as any)[g];
    }
    let output = '';
    sandbox.console = {
      log: (...args: any[]) => { output += args.join(' ') + '\n'; },
      error: (...args: any[]) => { output += '[ERROR] ' + args.join(' ') + '\n'; },
    };

    try {
      const result = runInNewContext(code, sandbox, { timeout: this.config.timeoutMs });
      const stdout = output + (result !== undefined ? String(result) : '');
      return {
        stdout: stdout.slice(0, this.config.maxOutputLength),
        stderr: '',
        exitCode: 0,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        stdout: output.slice(0, this.config.maxOutputLength),
        stderr: err.message,
        exitCode: 1,
        durationMs: Date.now() - start,
      };
    }
  }

  private async _executePython(code: string): Promise<ExecutionResult> {
    const start = Date.now();
    const escaped = code.replace(/"/g, '\"').replace(/\n/g, '\n');
    const cmd = `python3 -c "${escaped}"`;
    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: this.config.timeoutMs });
      return {
        stdout: stdout.slice(0, this.config.maxOutputLength),
        stderr: stderr.slice(0, this.config.maxOutputLength),
        exitCode: 0,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        stdout: (err.stdout || '').slice(0, this.config.maxOutputLength),
        stderr: (err.stderr || err.message).slice(0, this.config.maxOutputLength),
        exitCode: err.code || 1,
        durationMs: Date.now() - start,
      };
    }
  }

  private async _executeBash(code: string): Promise<ExecutionResult> {
    const start = Date.now();
    try {
      const { stdout, stderr } = await execAsync(code, { timeout: this.config.timeoutMs });
      return {
        stdout: stdout.slice(0, this.config.maxOutputLength),
        stderr: stderr.slice(0, this.config.maxOutputLength),
        exitCode: 0,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        stdout: (err.stdout || '').slice(0, this.config.maxOutputLength),
        stderr: (err.stderr || err.message).slice(0, this.config.maxOutputLength),
        exitCode: err.code || 1,
        durationMs: Date.now() - start,
      };
    }
  }
}
