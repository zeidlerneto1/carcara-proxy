import * as vscode from 'vscode';
import {
  ChatMessage, ModelInfo, SandboxResult, SearchResult,
  HealthStatus, ChatCompletionResponse, StreamChunk, ProxyConfig
} from './types';

export class CarcaraApiClient {
  private config: ProxyConfig;
  private abortController: AbortController | null = null;

  constructor() {
    this.config = this.loadConfig();
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('carcara')) {
        this.config = this.loadConfig();
      }
    });
  }

  private loadConfig(): ProxyConfig {
    const cfg = vscode.workspace.getConfiguration('carcara');
    return {
      url: cfg.get('proxyUrl', 'http://localhost:3030'),
      defaultModel: cfg.get('defaultModel', 'DeepSeek-v4-Flash-0731'),
      streamEnabled: cfg.get('streamEnabled', true),
      systemMessage: cfg.get('systemMessage', 'Você é um assistente de programação útil. Responda em português do Brasil.'),
      maxHistoryMessages: cfg.get('maxHistoryMessages', 20),
      theme: cfg.get('theme', 'auto') as 'dark' | 'light' | 'auto',
      sandboxTimeout: cfg.get('sandboxTimeout', 30000),
      enableThinking: cfg.get('enableThinking', false),
    };
  }

  getConfig(): ProxyConfig {
    return this.config;
  }

  async checkHealth(): Promise<HealthStatus> {
    try {
      const res = await fetch(`${this.config.url}/api/health`, { timeout: 5000 } as any);
      return await res.json();
    } catch {
      return { status: 'offline', initialized: false };
    }
  }

  async getModels(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.config.url}/v1/models`);
      const data = await res.json();
      return data.data || [];
    } catch (err: any) {
      throw new Error(`Falha ao carregar modelos: ${err.message}`);
    }
  }

  async *chatCompletionStream(
    messages: ChatMessage[],
    model?: string,
    tools?: any[]
  ): AsyncGenerator<StreamChunk, void, unknown> {
    this.abortController = new AbortController();

    const body: any = {
      model: model || this.config.defaultModel,
      messages: this.prepareMessages(messages),
      stream: true,
    };
    if (tools) body.tools = tools;

    const response = await fetch(`${this.config.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`HTTP ${response.status}: ${err}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') return;

          try {
            const parsed: StreamChunk = JSON.parse(data);
            yield parsed;
          } catch {
            // ignora linhas malformadas
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async chatCompletion(
    messages: ChatMessage[],
    model?: string,
    tools?: any[]
  ): Promise<ChatCompletionResponse> {
    const body: any = {
      model: model || this.config.defaultModel,
      messages: this.prepareMessages(messages),
      stream: false,
    };
    if (tools) body.tools = tools;

    const response = await fetch(`${this.config.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`HTTP ${response.status}: ${err}`);
    }

    return await response.json();
  }

  async executeSandbox(code: string, language: string): Promise<SandboxResult> {
    const response = await fetch(`${this.config.url}/api/sandbox/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, language }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Sandbox error: ${err}`);
    }

    return await response.json();
  }

  async search(query: string, providers?: string[]): Promise<SearchResult[]> {
    const response = await fetch(`${this.config.url}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, providers }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Search error: ${err}`);
    }

    return await response.json();
  }

  async searchDuckDuckGo(query: string): Promise<SearchResult> {
    const response = await fetch(`${this.config.url}/api/search/ddg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    return await response.json();
  }

  async getMcpTools(): Promise<any[]> {
    try {
      const res = await fetch(`${this.config.url}/mcp/list`);
      const data = await res.json();
      return data.tools || [];
    } catch {
      return [];
    }
  }

  async callMcpTool(name: string, args: any): Promise<any> {
    const response = await fetch(`${this.config.url}/mcp/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, arguments: args }),
    });
    return await response.json();
  }

  abort(): void {
    this.abortController?.abort();
  }

  private prepareMessages(messages: ChatMessage[]): any[] {
    const systemMsg: ChatMessage = {
      role: 'system',
      content: this.config.systemMessage,
    };

    const recent = messages.slice(-this.config.maxHistoryMessages);
    const hasSystem = recent.some(m => m.role === 'system');

    if (!hasSystem) {
      return [systemMsg, ...recent];
    }
    return recent;
  }
}
