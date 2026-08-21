import { CarcaraClient } from '../../carcara-client.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Agente Front-End: leitura/escrita de componentes visuais e layouts.
 * Restrito ao diretório de interfaces.
 */
export class FrontendAgent {
  private client: CarcaraClient;

  constructor(client: CarcaraClient) {
    this.client = client;
  }

  async generateComponent(description: string, componentName: string, framework: string = 'react'): Promise<string> {
    const prompt = `Voce e um engenheiro front-end senior. Gere um componente ${framework} para: ${description}\n\nNome do componente: ${componentName}\n\nRegras:\n- Use TypeScript\n- Inclua props tipadas\n- Estilize com CSS modules ou styled-components\n- Responda APENAS com o codigo, sem markdown`;

    const response = await this.client.chatCompletion(prompt);
    return response.choices?.[0]?.message?.content || '';
  }

  async generateStyles(componentName: string): Promise<string> {
    const prompt = `Gere estilos CSS para o componente ${componentName}. Use BEM ou CSS modules.`;
    const response = await this.client.chatCompletion(prompt);
    return response.choices?.[0]?.message?.content || '';
  }
}
