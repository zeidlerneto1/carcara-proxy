import { AgentEngine } from '../agent-engine.js';
import { CarcaraClient } from '../carcara-client.js';
import { MemoryService } from '../memory-service.js';
import { MetricsService } from '../metrics-service.js';
import { CodeLoopAgent } from './code-loop-agent.js';
import { PromptEngineerAgent } from './prompt-engineer-agent.js';
import { TaskPlannerAgent } from './task-planner-agent.js';
import { ReActLoopAgent } from './react-loop-agent.js';

export function registerAllAgents(
  engine: AgentEngine,
  client: CarcaraClient,
  memory: MemoryService,
  metrics: MetricsService
): ReActLoopAgent {
  // ===== REACT LOOP AGENT =====
  const reactAgent = new ReActLoopAgent(client);
  engine.register({
    id: 'react-loop',
    name: 'ReAct Loop Agent',
    description: 'Agente ReAct (Reasoning + Acting) com loop de ferramentas no chat principal',
    version: '2.0.0',
    capabilities: ['reasoning', 'tool-use', 'web-search', 'code-execution', 'mcp'],
  }, async (task) => {
    metrics.record('agent.run', 1, { agent: 'react-loop' });
    const result = await reactAgent.execute(task);
    await memory.add({
      type: 'conversation',
      content: JSON.stringify({ query: result.query, steps: result.totalSteps, converged: result.converged }),
      metadata: { taskId: task.id, converged: result.converged, steps: result.totalSteps },
      tags: ['react-loop', result.converged ? 'success' : 'partial', `steps-${result.totalSteps}`],
    });
    return result;
  });

  // ===== CODE LOOP AGENT =====
  const codeAgent = new CodeLoopAgent(client);
  engine.register({
    id: 'code-loop',
    name: 'Code Loop Agent',
    description: 'Gera codigo e itera ate convergir',
    version: '1.0.0',
    capabilities: ['code-generation', 'test-evaluation', 'auto-correction'],
  }, async (task) => {
    metrics.record('agent.run', 1, { agent: 'code-loop' });
    const result = await codeAgent.execute(task);
    await memory.add({
      type: 'code',
      content: result.code,
      metadata: { taskId: task.id, score: result.score, language: task.input?.language },
      tags: ['code-loop', task.input?.language, result.score >= 0.95 ? 'success' : 'partial'],
    });
    return result;
  });

  // ===== PROMPT ENGINEER AGENT =====
  const promptAgent = new PromptEngineerAgent(client);
  engine.register({
    id: 'prompt-engineer',
    name: 'Prompt Engineer',
    description: 'Evolui prompts via algoritmo genetico com avaliacao automatica',
    version: '1.0.0',
    capabilities: ['prompt-optimization', 'ab-testing', 'genetic-algorithm'],
  }, async (task) => {
    metrics.record('agent.run', 1, { agent: 'prompt-engineer' });
    const result = await promptAgent.execute(task);
    await memory.add({
      type: 'prompt',
      content: JSON.stringify(result[0]),
      metadata: { taskId: task.id, bestScore: result[0]?.score },
      tags: ['prompt-engineer', 'optimization'],
    });
    return result;
  });

  // ===== TASK PLANNER AGENT =====
  const planner = new TaskPlannerAgent(client);
  engine.register({
    id: 'task-planner',
    name: 'Task Planner',
    description: 'Decompoe objetivos complexos em grafos de subtarefas',
    version: '1.0.0',
    capabilities: ['task-decomposition', 'dependency-analysis', 'parallel-planning'],
  }, async (task) => {
    metrics.record('agent.run', 1, { agent: 'task-planner' });
    return planner.execute(task);
  });

  return reactAgent;
}
