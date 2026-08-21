import { CarcaraClient } from '../../carcara-client.js';
import { SandboxOrchestrator, SwarmTask, SwarmResult } from '../services/sandbox-orchestrator.js';
import { GVisorSandboxService } from '../../../infrastructure/services/gvisor-sandbox-service.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export interface SupervisorState {
  query: string;
  plan: string[];
  currentStep: number;
  results: SwarmResult[];
  completed: boolean;
}

export interface SupervisorConfig {
  maxIterations: number;
  supervisorModel: string;
}

/**
 * Supervisor LangGraph-style.
 * Recebe uma query, decompõe em plano, delega para workers,
 * recebe relatórios e decide próximo passo.
 */
export class SupervisorAgent {
  private client: CarcaraClient;
  private orchestrator: SandboxOrchestrator;
  private config: SupervisorConfig;

  constructor(client: CarcaraClient, sandbox: GVisorSandboxService, config?: Partial<SupervisorConfig>) {
    this.client = client;
    this.orchestrator = new SandboxOrchestrator(sandbox);
    this.config = {
      maxIterations: 10,
      supervisorModel: 'Qwen3.6-35B',
      ...config,
    };
  }

  async execute(task: any): Promise<{ plan: string[]; results: SwarmResult[]; finalAnswer: string }> {
    const query = task.input?.description || task.input || '';
    const state: SupervisorState = {
      query,
      plan: [],
      currentStep: 0,
      results: [],
      completed: false,
    };

    // Passo 1: Criar plano
    state.plan = await this._createPlan(query);
    logger.info({ plan: state.plan }, 'Plano criado pelo Supervisor');

    // Passo 2: Executar plano passo a passo
    for (let i = 0; i < Math.min(state.plan.length, this.config.maxIterations); i++) {
      state.currentStep = i;
      const step = state.plan[i];
      logger.info({ step: i + 1, total: state.plan.length, action: step }, 'Executando passo do plano');

      const swarmTask = await this._parseStepToTask(step, i, task.id);
      const result = await this.orchestrator.execute(swarmTask);
      state.results.push(result);

      // Se falhou, tentar replanejar
      if (!result.success) {
        logger.warn({ step, errors: result.errors }, 'Falha no passo, replanejando...');
        const fixPlan = await this._replan(query, state);
        if (fixPlan.length > 0) {
          state.plan.splice(i + 1, 0, ...fixPlan);
        }
      }
    }

    state.completed = true;
    const finalAnswer = await this._synthesizeResults(state);

    return {
      plan: state.plan,
      results: state.results,
      finalAnswer,
    };
  }

  private async _createPlan(query: string): Promise<string[]> {
    const prompt = `Voce e um Supervisor de engenharia de software. Decomponha a seguinte tarefa em passos sequenciais para um enxame de agentes (backend, frontend, qa).\n\nTarefa: ${query}\n\nResponda APENAS com uma lista numerada de passos. Cada passo deve indicar o agente (BACKEND/FRONTEND/QA) e a acao.\nExemplo:\n1. BACKEND: Criar API endpoint em src/application/api.ts\n2. FRONTEND: Criar componente em src/components/Form.tsx\n3. QA: Executar testes`;

    const response = await this.client.chatCompletion(prompt, this.config.supervisorModel);
    const content = response.choices?.[0]?.message?.content || '';

    // Extrair passos numerados
    const lines = content.split('\n').filter(l => /^\d+\./.test(l.trim()));
    return lines.length > 0 ? lines : ['1. QA: Analisar requisitos'];
  }

  private async _replan(query: string, state: SupervisorState): Promise<string[]> {
    const failedSteps = state.results.filter(r => !r.success).map(r => r.taskId);
    const prompt = `O plano atual falhou nos passos: ${failedSteps.join(', ')}.\nPlano original: ${state.plan.join('\n')}\n\nCrie um plano de correção com no maximo 3 passos adicionais.`;

    const response = await this.client.chatCompletion(prompt, this.config.supervisorModel);
    const content = response.choices?.[0]?.message?.content || '';
    const lines = content.split('\n').filter(l => /^\d+\./.test(l.trim()));
    return lines;
  }

  private async _parseStepToTask(step: string, index: number, parentId: string): Promise<SwarmTask> {
    const upper = step.toUpperCase();
    let agentType: SwarmTask['agentType'] = 'qa';
    let action: SwarmTask['action'] = 'read';

    if (upper.includes('BACKEND')) agentType = 'backend';
    else if (upper.includes('FRONTEND')) agentType = 'frontend';
    else if (upper.includes('QA')) agentType = 'qa';

    if (upper.includes('CRIAR') || upper.includes('ESCREVER') || upper.includes('WRITE')) action = 'write';
    else if (upper.includes('COMPILAR') || upper.includes('BUILD')) action = 'compile';
    else if (upper.includes('TESTAR') || upper.includes('TEST')) action = 'test';
    else if (upper.includes('TIPO') || upper.includes('TYPECHECK')) action = 'typecheck';
    else if (upper.includes('LER') || upper.includes('READ')) action = 'read';

    // Extrair path do step (heurística simples)
    const pathMatch = step.match(/(src\/[^\s]+|server\.[^\s]+|config\/[^\s]+)/);
    const targetPath = pathMatch?.[0] || 'src/';

    return {
      id: `${parentId}_step_${index}`,
      agentType,
      action,
      targetPath,
    };
  }

  private async _synthesizeResults(state: SupervisorState): Promise<string> {
    const summary = state.results.map(r =>
      `[${r.agentType.toUpperCase()}] ${r.success ? '✅' : '❌'} ${r.output.substring(0, 200)}`
    ).join('\n');

    const prompt = `Sintetize o seguinte relatório de execucao em uma resposta final para o usuario.\n\nTarefa: ${state.query}\n\nResultados:\n${summary}`;

    const response = await this.client.chatCompletion(prompt, this.config.supervisorModel);
    return response.choices?.[0]?.message?.content || 'Execucao completa.';
  }
}
