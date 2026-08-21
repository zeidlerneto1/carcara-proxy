import { AgentEngine } from '../application/agents/agent-engine.js';
import { CarcaraClient } from '../../infrastructure/clients/carcara-client.js';
import { MemoryService } from '../../infrastructure/services/memory-service.js';
import { MetricsService } from '../../infrastructure/services/metrics-service.js';
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
}
