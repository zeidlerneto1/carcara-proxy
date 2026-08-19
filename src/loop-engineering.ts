import { EventEmitter } from 'events';
import pino from 'pino';
import { LoopConfig, LoopIteration, LoopResult, LoopPhase, LoopContext } from './types.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const DEFAULT_CONFIG: LoopConfig = {
  maxIterations: 10,
  convergenceThreshold: 0.85,
  timeoutMs: 300000,
  backoffMultiplier: 1.5,
  maxBackoffMs: 30000,
  stopOnRegression: true,
  saveCheckpoints: true,
};

export type PlanFn<T> = (input: T, context: LoopContext<T>) => Promise<T>;
export type ExecuteFn<T> = (plan: T, context: LoopContext<T>) => Promise<T>;
export type EvaluateFn<T> = (output: T, expected: T | undefined, context: LoopContext<T>) => Promise<number>;
export type AdaptFn<T> = (output: T, score: number, context: LoopContext<T>) => Promise<T>;

export class LoopEngineering<T = any> extends EventEmitter {
  private config: LoopConfig;
  private abortController: AbortController | null = null;

  constructor(config: Partial<LoopConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async run(
    initialInput: T,
    planFn: PlanFn<T>,
    executeFn: ExecuteFn<T>,
    evaluateFn: EvaluateFn<T>,
    adaptFn: AdaptFn<T>,
    expectedOutput?: T,
    metadata: Record<string, any> = {}
  ): Promise<LoopResult<T>> {
    this.abortController = new AbortController();
    const startTime = Date.now();
    const history: LoopIteration<T>[] = [];
    let currentInput = initialInput;
    let bestOutput = initialInput;
    let bestScore = -1;
    let bestIteration = 0;
    let stoppedReason: LoopResult<T>['stoppedReason'] = 'maxIterations';

    logger.info({ maxIterations: this.config.maxIterations }, 'LoopEngineering iniciado');

    for (let i = 1; i <= this.config.maxIterations; i++) {
      if (this.abortController.signal.aborted) { stoppedReason = 'error'; break; }
      if (Date.now() - startTime > this.config.timeoutMs) { stoppedReason = 'timeout'; break; }

      const iterStart = Date.now();
      const context: LoopContext<T> = {
        iteration: i,
        history: [...history],
        config: this.config,
        startTime,
        metadata,
      };

      this.emit('phase', { phase: 'plan' as LoopPhase, iteration: i });
      let planOutput: T;
      try { planOutput = await planFn(currentInput, context); }
      catch (err: any) {
        history.push(this.makeIteration(i, 'plan', currentInput, currentInput, 0, {}, iterStart, err.message));
        stoppedReason = 'error'; break;
      }

      this.emit('phase', { phase: 'execute' as LoopPhase, iteration: i });
      let execOutput: T;
      try { execOutput = await executeFn(planOutput, context); }
      catch (err: any) {
        history.push(this.makeIteration(i, 'execute', planOutput, planOutput, 0, {}, iterStart, err.message));
        stoppedReason = 'error'; break;
      }

      this.emit('phase', { phase: 'evaluate' as LoopPhase, iteration: i });
      let score: number;
      try {
        score = await evaluateFn(execOutput, expectedOutput, context);
        score = Math.max(0, Math.min(1, score));
      } catch (err: any) {
        history.push(this.makeIteration(i, 'evaluate', execOutput, execOutput, 0, {}, iterStart, err.message));
        stoppedReason = 'error'; break;
      }

      const metrics = this.computeMetrics(execOutput, context);
      const iteration = this.makeIteration(i, 'adapt', currentInput, execOutput, score, metrics, iterStart);
      history.push(iteration);
      this.emit('iteration', iteration);

      if (score > bestScore) { bestScore = score; bestOutput = execOutput; bestIteration = i; }

      if (score >= this.config.convergenceThreshold) {
        stoppedReason = 'converged';
        logger.info({ iteration: i, score }, 'Loop convergiu');
        break;
      }

      if (this.config.stopOnRegression && history.length >= 2) {
        const prev = history[history.length - 2];
        if (score < prev.score * 0.7) {
          stoppedReason = 'regression';
          logger.warn({ iteration: i, score, prevScore: prev.score }, 'Regressao detectada');
          break;
        }
      }

      this.emit('phase', { phase: 'adapt' as LoopPhase, iteration: i });
      try { currentInput = await adaptFn(execOutput, score, context); }
      catch (err: any) { stoppedReason = 'error'; break; }

      if (i < this.config.maxIterations) {
        const delay = Math.min(this.config.maxBackoffMs, 1000 * Math.pow(this.config.backoffMultiplier, i - 1));
        await this.sleep(delay);
      }
    }

    const result: LoopResult<T> = {
      success: stoppedReason === 'converged',
      iterations: history,
      bestOutput,
      bestScore,
      bestIteration,
      totalDurationMs: Date.now() - startTime,
      stoppedReason,
    };

    this.emit('complete', result);
    logger.info({ success: result.success, iterations: history.length, bestScore }, 'Loop finalizado');
    return result;
  }

  abort(): void {
    this.abortController?.abort();
    logger.info('Loop abortado');
  }

  private makeIteration(iteration: number, phase: LoopPhase, input: any, output: any, score: number,
    metrics: Record<string, number>, startTime: number, error?: string): LoopIteration {
    return { iteration, phase, input, output, score, metrics, timestamp: Date.now(), durationMs: Date.now() - startTime, error };
  }

  private computeMetrics(output: any, context: LoopContext<any>): Record<string, number> {
    const metrics: Record<string, number> = {};
    if (typeof output === 'string') { metrics.outputLength = output.length; metrics.lineCount = output.split('\n').length; }
    metrics.iteration = context.iteration;
    return metrics;
  }

  private sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
}
