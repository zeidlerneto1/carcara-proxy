import { AgentTask } from '../types.js';
import { CarcaraClient } from '../carcara-client.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export interface SubTask {
  id: string;
  description: string;
  agentId: string;
  dependencies: string[];
  input: any;
  expectedOutput?: any;
}

export interface TaskPlan {
  objective: string;
  subTasks: SubTask[];
  parallelGroups: string[][];
}

export class TaskPlannerAgent {
  private client: CarcaraClient;
  constructor(client: CarcaraClient) { this.client = client; }

  async execute(task: AgentTask): Promise<TaskPlan> {
    const objective = task.input as string;
    const model = task.config?.model as string || this.client.getDefaultModel();

    const prompt = `Decomponha o seguinte objetivo em subtarefas executaveis.
Cada subtarefa deve ter: id, descricao, agente especialista (code, search, prompt, review), e dependencias.

Objetivo: ${objective}

Formato de saida (JSON):
{
  "subTasks": [
    { "id": "t1", "description": "...", "agentId": "code", "dependencies": [], "input": {...} }
  ],
  "parallelGroups": [["t1", "t2"], ["t3"]]
}

Forneca APENAS o JSON, sem markdown.`;

    const response = await this.client.chatCompletion(prompt, model);
    const text = response.choices[0].message.content;

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
      return { objective, subTasks: parsed.subTasks || [], parallelGroups: parsed.parallelGroups || [] };
    } catch (err: any) {
      logger.error({ error: err.message }, 'Falha ao parsear plano');
      return { objective, subTasks: [{ id: 't1', description: objective, agentId: 'code', dependencies: [], input: task.input }], parallelGroups: [['t1']] };
    }
  }
}
