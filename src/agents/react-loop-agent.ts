import { CarcaraClient } from '../carcara-client.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

interface ReActStep {
  step: number;
  thought: string;
  action: string;
  actionInput: string;
  observation: string;
}

interface ReActResult {
  query: string;
  answer: string;
  steps: ReActStep[];
  totalSteps: number;
  converged: boolean;
}

export class ReActLoopAgent {
  private client: CarcaraClient;
  private maxSteps: number = 10;

  constructor(client: CarcaraClient) {
    this.client = client;
  }

  async execute(task: any): Promise<ReActResult> {
    const query = task.input?.description || task.input || '';
    const steps: ReActStep[] = [];
    let currentThought = '';
    let converged = false;

    for (let step = 1; step <= this.maxSteps; step++) {
      const prompt = this.buildPrompt(query, steps);
      const response = await this.client.chatCompletion(prompt, undefined, []);
      const content = response.choices?.[0]?.message?.content || '';

      const thought = this.extractThought(content);
      const action = this.extractAction(content);
      const actionInput = this.extractActionInput(content);

      if (!action || action === 'finish') {
        converged = true;
        steps.push({ step, thought, action: 'finish', actionInput: '', observation: '' });
        break;
      }

      const observation = await this.executeAction(action, actionInput);
      steps.push({ step, thought, action, actionInput, observation });
      currentThought = thought;
    }

    const finalAnswer = currentThought || query;
    return { query, answer: finalAnswer, steps, totalSteps: steps.length, converged };
  }

  private buildPrompt(query: string, steps: ReActStep[]): string {
    let prompt = `Voce e um agente ReAct. Responda a pergunta usando raciocinio passo a passo.\n\nPergunta: ${query}\n\n`;
    for (const s of steps) {
      prompt += `Passo ${s.step}:\nPensamento: ${s.thought}\nAcao: ${s.action}\nEntrada: ${s.actionInput}\nObservacao: ${s.observation}\n\n`;
    }
    prompt += `Pense no proximo passo. Use [Pensamento: ...] [Acao: ...] [Entrada: ...]. Use Acao: finish quando tiver a resposta.`;
    return prompt;
  }

  private extractThought(content: string): string {
    const match = content.match(/Pensamento:\s*([^\n]+)/i);
    return match?.[1]?.trim() || '';
  }

  private extractAction(content: string): string {
    const match = content.match(/Acao:\s*([^\n]+)/i);
    return match?.[1]?.trim() || '';
  }

  private extractActionInput(content: string): string {
    const match = content.match(/Entrada:\s*([^\n]+)/i);
    return match?.[1]?.trim() || '';
  }

  private async executeAction(action: string, input: string): Promise<string> {
    switch (action.toLowerCase()) {
      case 'search':
        return `Resultado da busca por: ${input}`;
      case 'calculate':
        try { return String(eval(input)); } catch (e: any) { return `Erro: ${e.message}`; }
      default:
        return `Acao ${action} nao disponivel (Docker removido).`;
    }
  }
}
