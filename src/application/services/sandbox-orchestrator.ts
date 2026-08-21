import { GVisorSandboxService, SandboxResult } from '../../infrastructure/services/gvisor-sandbox-service.js';
import pino from 'pino';
import path from 'path';
import os from 'os';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export interface SwarmTask {
  id: string;
  agentType: 'backend' | 'frontend' | 'qa';
  action: 'read' | 'write' | 'compile' | 'test' | 'typecheck';
  targetPath: string;
  content?: string;
  language?: string;
}

export interface SwarmResult {
  taskId: string;
  agentType: string;
  success: boolean;
  output: string;
  errors: string[];
  durationMs: number;
}

export class SandboxOrchestrator {
  private sandbox: GVisorSandboxService;
  private allowedPaths: Record<string, RegExp[]>;
  private workDir: string;

  constructor(sandbox: GVisorSandboxService) {
    this.sandbox = sandbox;
    this.workDir = path.join(os.tmpdir(), 'carcara-swarm-' + Date.now().toString(36));
    this.allowedPaths = {
      backend: [/^src\/(application|domain|infrastructure)\//, /^server\./, /^config\//],
      frontend: [/^src\/(presentation|components|pages)\//, /^public\//, /^styles\//],
      qa: [/^.*$/],
    };
  }

  async execute(task: SwarmTask): Promise<SwarmResult> {
    const start = Date.now();
    const errors: string[] = [];

    // Sanitiza targetPath: remove caracteres invalidos
    task.targetPath = task.targetPath
      .replace(/[*`"'<>|\?\x00-\x1f]/g, '')
      .replace(/\.\.+/, '.')
      .trim();

    if (!this._checkPermission(task.agentType, task.targetPath)) {
      return {
        taskId: task.id,
        agentType: task.agentType,
        success: false,
        output: '',
        errors: [`PERMISSAO NEGADA: ${task.agentType} nao pode acessar ${task.targetPath}`],
        durationMs: Date.now() - start,
      };
    }

    try {
      let output = '';

      switch (task.action) {
        case 'read':
          output = await this._readFile(task.targetPath);
          break;
        case 'write':
          output = await this._writeFile(task.targetPath, task.content || '');
          break;
        case 'compile':
        case 'test':
        case 'typecheck':
          output = await this._runInSandbox(task);
          break;
        default:
          errors.push(`Acao desconhecida: ${task.action}`);
      }

      const hasError = this._detectFailure(output);
      if (hasError) {
        errors.push(...this._extractErrors(output));
        logger.warn({ taskId: task.id, agentType: task.agentType }, 'Falha detectada, desviando para canal de excecoes');
      }

      return {
        taskId: task.id,
        agentType: task.agentType,
        success: !hasError && errors.length === 0,
        output: output.slice(0, 10000),
        errors,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      logger.error({ taskId: task.id, error: err.message }, 'Erro na execucao do swarm');
      return {
        taskId: task.id,
        agentType: task.agentType,
        success: false,
        output: '',
        errors: [err.message],
        durationMs: Date.now() - start,
      };
    }
  }

  private _checkPermission(agentType: string, path: string): boolean {
    const rules = this.allowedPaths[agentType];
    if (!rules) return false;
    return rules.some(regex => regex.test(path));
  }

  private async _readFile(filePath: string): Promise<string> {
    const { readFile } = await import('fs/promises');
    const safePath = path.join(this.workDir, filePath.replace(/^\//, '').replace(/^\\/, ''));
    const content = await readFile(safePath, 'utf-8');
    return Buffer.from(content).toString('base64');
  }

  private async _writeFile(filePath: string, base64Content: string): Promise<string> {
    const { writeFile, mkdir } = await import('fs/promises');
    const { dirname } = await import('path');
    const content = Buffer.from(base64Content, 'base64').toString('utf-8');
    // Escreve no diretorio temporario de trabalho, nao no projeto
    const safePath = path.join(this.workDir, filePath.replace(/^\//, '').replace(/^\\/, ''));
    await mkdir(dirname(safePath), { recursive: true });
    await writeFile(safePath, content, 'utf-8');
    return `Arquivo escrito: ${safePath} (${content.length} bytes)`;
  }

  private async _runInSandbox(task: SwarmTask): Promise<string> {
    const code = this._buildSandboxCommand(task);
    const lang = this._resolveLanguage(task);
    const result = await this.sandbox.execute(code, lang as any, `swarm_${task.agentType}_${task.id}`, task.agentType !== 'qa', task.agentType === 'qa' ? 120000 : undefined);

    let output = '';
    if (result.stdout) output += result.stdout;
    if (result.stderr) output += `\n[STDERR]\n${result.stderr}`;
    output += `\n[EXIT] ${result.exitCode} | ${result.durationMs}ms`;

    return output;
  }

  private _resolveLanguage(task: SwarmTask): string {
    if (task.action === 'compile' || task.action === 'test' || task.action === 'typecheck') {
      return 'node';
    }
    return task.language || 'bash';
  }

  private _buildSandboxCommand(task: SwarmTask): string {
    const workDir = this.workDir.replace(/\\/g, '/');
    switch (task.action) {
      case 'compile':
        return `cd "${workDir}" && npm install -g pnpm && pnpm install && pnpm run build 2>&1`;
      case 'test':
        return `cd "${workDir}" && npm install -g pnpm && pnpm install && pnpm test 2>&1`;
      case 'typecheck':
        return `cd "${workDir}" && npm install -g pnpm && pnpm install && pnpm exec tsc --noEmit 2>&1`;
      default:
        return 'echo "Acao nao suportada"';
    }
  }

  private _detectFailure(output: string): boolean {
    const failurePatterns = [
      /\berro\b/i,
      /\bfalha\b/i,
      /\bfailed\b/i,
      /\berror\b/i,
      /\bexception\b/i,
      /\bsyntaxerror\b/i,
      /exit code [1-9]/i,
    ];
    return failurePatterns.some(p => p.test(output));
  }

  private _extractErrors(output: string): string[] {
    const lines = output.split('\n');
    const errors: string[] = [];
    for (const line of lines) {
      if (/\berro\b|\bfalha\b|\bfailed\b|\berror\b/i.test(line)) {
        errors.push(line.trim());
      }
    }
    return errors.slice(0, 20);
  }
}
