import { CarcaraClient } from '../../../infrastructure/clients/carcara-client.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Agente Back-End: leitura/escrita de lógica de negócio e configurações.
 * NÃO executa rotinas (sem runtime).
 */
export class BackendAgent {
  private client: CarcaraClient;

  constructor(client: CarcaraClient) {
    this.client = client;
  }

  async generateCode(description: string, targetPath: string, language: string = 'typescript'): Promise<string> {
    const prompt = `Voce e um engenheiro back-end senior. Gere codigo ${language} para: ${description}\n\nO arquivo sera salvo em: ${targetPath}\n\nRegras:\n- Use clean architecture\n- Inclua tratamento de erros\n- Exporte as funcoes principais\n- Responda APENAS com o codigo, sem markdown`;

    const response = await this.client.chatCompletion(prompt);
    return response.choices?.[0]?.message?.content || '';
  }

  async reviewCode(code: string): Promise<{ score: number; feedback: string }> {
    const prompt = `Revise o seguinte codigo back-end e atribua uma nota de 0-100:\n\n${code}\n\nResponda no formato: NOTA: X\nFEEDBACK: ...`;

    const response = await this.client.chatCompletion(prompt);
    const content = response.choices?.[0]?.message?.content || '';

    const scoreMatch = content.match(/NOTA:\s*(\d+)/);
    const score = scoreMatch ? parseInt(scoreMatch[1]) : 50;
    const feedback = content.replace(/NOTA:\s*\d+/, '').replace('FEEDBACK:', '').trim();

    return { score, feedback };
  }
}
