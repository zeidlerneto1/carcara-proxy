import { CarcaraClient } from '../carcara-client.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

interface CodeResult {
  code: string;
  score: number;
  iterations: number;
  converged: boolean;
}

export class CodeLoopAgent {
  private client: CarcaraClient;
  private maxIterations: number = 5;

  constructor(client: CarcaraClient) {
    this.client = client;
  }

  async execute(task: any): Promise<CodeResult> {
    const description = task.input?.description || '';
    const language = task.input?.language || 'python';
    let bestCode = '';
    let bestScore = 0;

    for (let i = 0; i < this.maxIterations; i++) {
      const prompt = `Gere codigo ${language} para: ${description}\nIteracao ${i + 1}`;
      const response = await this.client.chatCompletion(prompt, undefined, []);
      const code = response.choices?.[0]?.message?.content || '';

      const score = this.evaluateCode(code, description);
      if (score > bestScore) {
        bestScore = score;
        bestCode = code;
      }

      if (score >= 0.95) break;
    }

    return { code: bestCode, score: bestScore, iterations: this.maxIterations, converged: bestScore >= 0.95 };
  }

  private evaluateCode(code: string, description: string): number {
    let score = 0.5;
    if (code.includes('def ') || code.includes('function')) score += 0.2;
    if (code.length > 50) score += 0.1;
    if (description.toLowerCase().split(' ').some(w => code.toLowerCase().includes(w))) score += 0.2;
    return Math.min(score, 1.0);
  }
}
