import { ChatMessage, ToolCall } from '../../domain/entities/message.js';

export interface ILLMClient {
  chatCompletionMessages(messages: any[], model?: string, tools?: any[]): Promise<any>;
  chatCompletion(prompt: string, model?: string, tools?: any[]): Promise<any>;
  getDefaultModel(): string;
  getAvailableModels(): Promise<any[]>;
}
