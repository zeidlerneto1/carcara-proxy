import { CarcaraClient } from '../../carcara-client.js';
import { SandboxOrchestrator, SwarmTask, SwarmResult } from '../../services/sandbox-orchestrator.js';
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

    state.plan = await this._createPlan(query);
    logger.info({ plan: state.plan }, 'Plano criado pelo Supervisor');

    for (let i = 0; i < Math.min(state.plan.length, this.config.maxIterations); i++) {
      state.currentStep = i;
      const step = state.plan[i];
      logger.info({ step: i + 1, total: state.plan.length, action: step }, 'Executando passo do plano');

      const swarmTask = await this._parseStepToTask(step, i, task.id || `swarm_${Date.now()}`);
      const result = await this.orchestrator.execute(swarmTask);
      state.results.push(result);

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

  private async _safeChat(prompt: string): Promise<string> {
    try {
      const response = await this.client.chatCompletion(prompt, this.config.supervisorModel);
      if (!response || typeof response !== 'object') {
        logger.warn({ response }, 'Resposta invalida do LLM');
        return '';
      }
      if (!Array.isArray(response.choices)) {
        logger.warn({ response }, 'Resposta sem choices do LLM');
        return '';
      }
      const content = response.choices[0]?.message?.content;
      return typeof content === 'string' ? content : '';
    } catch (err: any) {
      logger.error({ error: err.message }, 'Erro no chatCompletion do Supervisor');
      return '';
    }
  }

  private async _createPlan(query: string): Promise<string[]> {
    const prompt = `Voce e um Supervisor de engenharia de software. Decomponha a seguinte tarefa em passos sequenciais para um enxame de agentes (BACKEND, FRONTEND, QA).\n\nTarefa: ${query}\n\nResponda APENAS com uma lista numerada. Cada passo deve comecar com BACKEND:, FRONTEND: ou QA:. Inclua o caminho do arquivo. QA deve ser o ULTIMO passo.\nExemplo:\n1. BACKEND: Criar API endpoint em src/application/api.ts\n2. FRONTEND: Criar componente em src/components/Form.tsx\n3. QA: Executar testes`;

    const content = await this._safeChat(prompt);
    const lines = content.split('\n').filter(l => /^\d+\./.test(l.trim()));
    logger.debug({ rawContent: content.substring(0, 500) }, 'Resposta bruta do LLM para plano');
    if (lines.length === 0) {
      logger.warn({ content: content.substring(0, 200) }, 'LLM nao retornou plano no formato esperado');
    }
    return lines.length > 0 ? lines : ['1. BACKEND: Criar estrutura base em src/application/index.ts', '2. QA: Compilar projeto'];
  }

  private async _replan(query: string, state: SupervisorState): Promise<string[]> {
    const failedSteps = state.results.filter(r => !r.success).map(r => r.taskId);
    const prompt = `O plano atual falhou nos passos: ${failedSteps.join(', ')}.\nPlano original: ${state.plan.join('\n')}\n\nCrie um plano de correção com no maximo 3 passos adicionais.`;

    const content = await this._safeChat(prompt);
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

    const pathMatch = step.match(/(src\/[^\s]+|server\.[^\s]+|config\/[^\s]+)/);
    let targetPath = pathMatch?.[0] || 'src/application/index.ts';
    // Evitar targetPath ser um diretorio (causa EISDIR)
    if (targetPath.endsWith('/')) {
      targetPath += 'index.ts';
    }

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

    const prompt = `Sintetize o seguinte relatorio de execucao em uma resposta final para o usuario.\n\nTarefa: ${state.query}\n\nResultados:\n${summary}`;

    return await this._safeChat(prompt);
  }
}
