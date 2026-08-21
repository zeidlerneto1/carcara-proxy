import { EventEmitter } from 'events';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export interface QueuedTask {
  id: string;
  type: 'supervisor' | 'worker';
  model: string;
  prompt: string;
  priority: number;
  createdAt: number;
  resolve: (value: string) => void;
  reject: (reason: any) => void;
}

export interface QueueStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  maxConcurrency: number;
}

/**
 * Fila de agentes com controle de concorrencia.
 * Qwen 3.6-35B = Supervisor (planejamento)
 * DeepSeek V4 Flash = Worker (execucao rapida)
 */
export class AgentQueueService extends EventEmitter {
  private queue: QueuedTask[] = [];
  private running = new Set<string>();
  private maxConcurrency: number;
  private supervisorModel: string;
  private workerModel: string;
  private stats = { pending: 0, running: 0, completed: 0, failed: 0, maxConcurrency: 0 };

  constructor(
    maxConcurrency: number = 3,
    supervisorModel: string = 'Qwen3.6-35B',
    workerModel: string = 'DeepSeek-v4-Flash-0731'
  ) {
    super();
    this.maxConcurrency = maxConcurrency;
    this.supervisorModel = supervisorModel;
    this.workerModel = workerModel;
    this.stats.maxConcurrency = maxConcurrency;
  }

  /**
   * Adiciona tarefa na fila. Supervisor tem prioridade sobre Worker.
   */
  enqueue(type: 'supervisor' | 'worker', prompt: string, priority: number = 0): Promise<string> {
    return new Promise((resolve, reject) => {
      const task: QueuedTask = {
        id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        type,
        model: type === 'supervisor' ? this.supervisorModel : this.workerModel,
        prompt,
        priority,
        createdAt: Date.now(),
        resolve,
        reject,
      };

      // Inserir ordenado por prioridade (maior primeiro)
      const idx = this.queue.findIndex(t => t.priority < task.priority);
      if (idx === -1) {
        this.queue.push(task);
      } else {
        this.queue.splice(idx, 0, task);
      }

      this.stats.pending = this.queue.length;
      this.emit('task:queued', task);
      logger.info({ taskId: task.id, type, model: task.model, priority }, 'Tarefa enfileirada');
      this._processQueue();
    });
  }

  /**
   * Processa a fila respeitando maxConcurrency.
   */
  private async _processQueue(): Promise<void> {
    if (this.running.size >= this.maxConcurrency) return;
    if (this.queue.length === 0) return;

    const task = this.queue.shift()!;
    this.stats.pending = this.queue.length;
    this.running.add(task.id);
    this.stats.running = this.running.size;
    this.emit('task:started', task);
    logger.info({ taskId: task.id, type: task.type, running: this.running.size }, 'Tarefa iniciada');

    try {
      // Aqui seria a chamada real ao LLM
      // Por enquanto simulamos com delay
      const result = await this._executeTask(task);
      this.stats.completed++;
      task.resolve(result);
      this.emit('task:completed', { task, result });
      logger.info({ taskId: task.id, durationMs: Date.now() - task.createdAt }, 'Tarefa completa');
    } catch (error: any) {
      this.stats.failed++;
      task.reject(error);
      this.emit('task:failed', { task, error: error.message });
      logger.error({ taskId: task.id, error: error.message }, 'Tarefa falhou');
    } finally {
      this.running.delete(task.id);
      this.stats.running = this.running.size;
      // Processar próxima
      setImmediate(() => this._processQueue());
    }
  }

  private async _executeTask(task: QueuedTask): Promise<string> {
    // Placeholder: integrar com CarcaraClient.chatCompletion
    // No api-router sera substituido pela chamada real
    return `[${task.type.toUpperCase()} via ${task.model}] ${task.prompt.substring(0, 50)}...`;
  }

  getStats(): QueueStats {
    return { ...this.stats };
  }

  listPending(): QueuedTask[] {
    return this.queue.map(t => ({ ...t, resolve: undefined as any, reject: undefined as any }));
  }

  listRunning(): string[] {
    return Array.from(this.running);
  }

  clear(): void {
    for (const task of this.queue) {
      task.reject(new Error('Fila limpa'));
    }
    this.queue = [];
    this.stats.pending = 0;
    logger.info('Fila limpa');
  }
}
