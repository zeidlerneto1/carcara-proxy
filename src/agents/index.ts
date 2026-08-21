import { AgentEngine } from '../application/agents/agent-engine.js';
import { CarcaraClient } from '../infrastructure/clients/carcara-client.js';
import { MemoryService } from '../infrastructure/services/memory-service.js';
import { MetricsService } from '../infrastructure/services/metrics-service.js';
import { ApprovalService } from '../application/services/approval-service.js';
import { SupervisorAgent } from '../application/agents/swarm/supervisor-agent.js';

export function registerAllAgents(
  engine: AgentEngine,
  client: CarcaraClient,
  memory: MemoryService,
  metrics: MetricsService,
  _allowHostExecution: boolean = false,
  _approvalService?: ApprovalService,
  sandbox?: any
): void {
  if (!sandbox) return;

  const supervisor = new SupervisorAgent(client, sandbox);
  engine.register({
    id: 'supervisor-swarm',
    name: 'Supervisor Swarm',
    description: 'Orquestrador de enxame de agentes (backend, frontend, qa)',
    version: '1.0.0',
    capabilities: ['planning', 'delegation', 'synthesis', 'swarm-orchestration'],
  }, async (task) => {
    metrics.record('agent.run', 1, { agent: 'supervisor-swarm' });
    const result = await supervisor.execute(task);
    await memory.add({
      type: 'swarm',
      content: JSON.stringify({ plan: result.plan, finalAnswer: result.finalAnswer }),
      metadata: { taskId: task.id, steps: result.plan.length },
      tags: ['supervisor-swarm', 'planning', `steps-${result.plan.length}`],
    });
    return result;
  });

  // === Agentes do ThinkingService ===
  engine.register({
    id: 'react-loop',
    name: 'ReAct Loop',
    description: 'Agente de raciocinio ReAct (Reasoning + Acting)',
    version: '1.0.0',
    capabilities: ['reasoning', 'web-search', 'calculation'],
  }, async (task) => {
    metrics.record('agent.run', 1, { agent: 'react-loop' });
    const prompt = typeof task.input === 'string' ? task.input : task.input?.description || '';
    const response = await client.chatCompletion(
      `Voce e um agente ReAct. Resolva passo a passo: ${prompt}`
    );
    const content = response.choices?.[0]?.message?.content || '';
    return {
      totalSteps: 1,
      converged: true,
      steps: [{ step: 1, action: 'think', thought: content, actionInput: prompt, observation: content }],
      finalAnswer: content,
    };
  });

  engine.register({
    id: 'code-loop',
    name: 'Code Loop',
    description: 'Agente de geracao e refinamento de codigo',
    version: '1.0.0',
    capabilities: ['code-generation', 'code-review'],
  }, async (task) => {
    metrics.record('agent.run', 1, { agent: 'code-loop' });
    const input = task.input as any;
    const response = await client.chatCompletion(
      `Gere codigo ${input?.language || 'python'} para: ${input?.description || ''}`
    );
    const code = response.choices?.[0]?.message?.content || '';
    return { code, score: 1.0, testResults: [] };
  });

  engine.register({
    id: 'prompt-engineer',
    name: 'Prompt Engineer',
    description: 'Melhora prompts para clareza e precisao',
    version: '1.0.0',
    capabilities: ['prompt-optimization'],
  }, async (task) => {
    metrics.record('agent.run', 1, { agent: 'prompt-engineer' });
    const input = task.input as any;
    const response = await client.chatCompletion(
      `Melhore este prompt para maior clareza e precisao: ${input?.originalPrompt || ''}`
    );
    return [{ prompt: response.choices?.[0]?.message?.content || '' }];
  });

  engine.register({
    id: 'task-planner',
    name: 'Task Planner',
    description: 'Cria planos de execucao com subtarefas',
    version: '1.0.0',
    capabilities: ['planning', 'task-decomposition'],
  }, async (task) => {
    metrics.record('agent.run', 1, { agent: 'task-planner' });
    const prompt = typeof task.input === 'string' ? task.input : JSON.stringify(task.input);
    return { objective: prompt, subTasks: [{ id: '1', description: prompt, agentId: 'supervisor-swarm' }] };
  });
}
