import { EventEmitter } from 'events';
import pino from 'pino';
import { LoopEngineering, PlanFn, ExecuteFn, EvaluateFn, AdaptFn } from './loop-engineering.js';
import { AgentDefinition, AgentTask, AgentTaskResult, LoopResult, LoopConfig } from './types.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export type AgentHandler = (task: AgentTask) => Promise<any>;

export class AgentEngine extends EventEmitter {
  private agents = new Map<string, { def: AgentDefinition; handler: AgentHandler }>();

  register(def: AgentDefinition, handler: AgentHandler): void {
    this.agents.set(def.id, { def, handler });
    logger.info({ agent: def.id, capabilities: def.capabilities }, 'Agente registrado');
  }

  unregister(agentId: string): boolean {
    return this.agents.delete(agentId);
  }

  list(): AgentDefinition[] {
    return Array.from(this.agents.values()).map(a => a.def);
  }

  get(agentId: string): AgentDefinition | undefined {
    return this.agents.get(agentId)?.def;
  }

  async run(task: AgentTask): Promise<AgentTaskResult> {
    const agent = this.agents.get(task.agentId);
    if (!agent) throw new Error(`Agente '${task.agentId}' nao encontrado`);

    const start = Date.now();
    this.emit('task:start', task);

    try {
      const output = await agent.handler(task);
      const result: AgentTaskResult = {
        taskId: task.id, agentId: task.agentId, success: true, output,
        durationMs: Date.now() - start, timestamp: Date.now(),
      };
      this.emit('task:complete', result);
      return result;
    } catch (error: any) {
      const result: AgentTaskResult = {
        taskId: task.id, agentId: task.agentId, success: false, output: null,
        durationMs: Date.now() - start, timestamp: Date.now(),
      };
      this.emit('task:error', { result, error: error.message });
      throw error;
    }
  }

  async runLoop<T = any>(
    task: AgentTask,
    planFn: PlanFn<T>,
    executeFn: ExecuteFn<T>,
    evaluateFn: EvaluateFn<T>,
    adaptFn: AdaptFn<T>,
    loopConfig?: Partial<LoopConfig>
  ): Promise<AgentTaskResult> {
    const start = Date.now();
    const loop = new LoopEngineering(loopConfig);

    const loopResult = await loop.run(
      task.input, planFn, executeFn, evaluateFn, adaptFn,
      task.expectedOutput, { taskId: task.id, agentId: task.agentId, ...task.config }
    );

    const result: AgentTaskResult = {
      taskId: task.id, agentId: task.agentId, success: loopResult.success,
      output: loopResult.bestOutput, loopResult,
      durationMs: Date.now() - start, timestamp: Date.now(),
    };

    this.emit('task:complete', result);
    return result;
  }

  async runPipeline(tasks: AgentTask[]): Promise<AgentTaskResult[]> {
    const results: AgentTaskResult[] = [];
    let currentInput = tasks[0]?.input;

    for (const task of tasks) {
      const enriched = { ...task, input: currentInput ?? task.input };
      const result = await this.run(enriched);
      results.push(result);
      if (!result.success) break;
      currentInput = result.output;
    }
    return results;
  }
}
