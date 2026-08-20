import pino from 'pino';
import { ILLMClient } from '../ports/illm-client.js';
import { ISandboxService } from '../ports/isandbox-service.js';
import { ISearchService } from '../ports/isearch-service.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export interface NativeTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: any;
  };
}

export interface ToolCallRequest {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * ChatUseCase: orquestra chat com tool calling nativo.
 * Application Layer - N-Layers Architecture.
 */
export class ChatUseCase {
  private llmClient: ILLMClient;
  private sandboxService: ISandboxService;
  private searchService: ISearchService;
  private dockerAvailable: boolean;

  constructor(llmClient: ILLMClient, sandboxService: ISandboxService, searchService: ISearchService, dockerAvailable: boolean) {
    this.llmClient = llmClient;
    this.sandboxService = sandboxService;
    this.searchService = searchService;
    this.dockerAvailable = dockerAvailable;
  }

  getNativeTools(): NativeTool[] {
    return [
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Busca informações na web usando DuckDuckGo ou Wikipedia.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Termo de busca' },
              provider: { type: 'string', enum: ['duckduckgo', 'wikipedia'], description: 'Provedor' },
            },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'sandbox_exec',
          description: 'Executa código em sandbox Docker isolado.',
          parameters: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'Código completo' },
              language: { type: 'string', enum: ['python', 'javascript', 'typescript', 'bash', 'sh'], description: 'Linguagem' },
            },
            required: ['code', 'language'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'calculate',
          description: 'Realiza cálculos matemáticos precisos.',
          parameters: {
            type: 'object',
            properties: {
              expression: { type: 'string', description: 'Expressão matemática' },
            },
            required: ['expression'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_time',
          description: 'Retorna data/hora atual ISO 8601.',
          parameters: { type: 'object', properties: {} },
        },
      },
    ];
  }

  async executeTool(call: ToolCallRequest, sessionId?: string): Promise<string> {
    const name = call.function.name;
    let args: any = {};
    try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
    logger.info({ tool: name, args }, 'Executando ferramenta nativa');

    try {
      switch (name) {
        case 'web_search': {
          const result = await this.searchService.search(args.query, args.provider ? [args.provider] : undefined);
          return JSON.stringify(result).slice(0, 4000);
        }
        case 'sandbox_exec': {
          if (!this.dockerAvailable) return 'ERRO: Docker não disponível.';
          const result = await this.sandboxService.execute(args.code, args.language || 'python', sessionId);
          let out = '';
          if (result.stdout) out += `stdout:\n${result.stdout}\n`;
          if (result.stderr) out += `stderr:\n${result.stderr}\n`;
          out += `exitCode: ${result.exitCode ?? '?'}`;
          return out.slice(0, 4000);
        }
        case 'calculate': {
          try { const fn = new Function('return (' + args.expression + ')'); return String(fn()); }
          catch (e: any) { return `ERRO: ${e.message}`; }
        }
        case 'get_time': return new Date().toISOString();
        default: return `ERRO: Ferramenta desconhecida: ${name}`;
      }
    } catch (err: any) {
      logger.error({ tool: name, error: err.message }, 'Erro na ferramenta');
      return `ERRO: ${err.message}`;
    }
  }

  /**
   * Loop de tool calling com parallel execution (Fork-Join).
   */
  async runToolLoop(messages: any[], model: string, maxSteps: number = 15, sessionId?: string): Promise<{ content: string; toolCallsCount: number; steps: number }> {
    const tools = this.getNativeTools();
    let currentMessages = [...messages];
    let totalToolCalls = 0;

    for (let step = 0; step < maxSteps; step++) {
      logger.info({ step: step + 1, maxSteps }, 'ToolLoop step');
      const response = await this.llmClient.chatCompletionMessages(currentMessages, model, tools);
      const choice = response.choices?.[0];
      if (!choice?.message) return { content: 'Sem resposta do modelo', toolCallsCount: totalToolCalls, steps: step };

      const message = choice.message;
      if (!message.tool_calls?.length) {
        return { content: message.content || '', toolCallsCount: totalToolCalls, steps: step };
      }

      totalToolCalls += message.tool_calls.length;
      currentMessages.push({ role: 'assistant', content: message.content || '', tool_calls: message.tool_calls });

      // Parallel execution: Promise.all para todas as tools
      const toolResults = await Promise.all(
        message.tool_calls.map(async (toolCall: ToolCallRequest) => {
          const result = await this.executeTool(toolCall, sessionId);
          return { role: 'tool', tool_call_id: toolCall.id, name: toolCall.function?.name || '', content: result };
        })
      );
      currentMessages.push(...toolResults);
    }

    const finalResponse = await this.llmClient.chatCompletionMessages(currentMessages, model, []);
    return {
      content: finalResponse.choices?.[0]?.message?.content || 'Loop encerrado.',
      toolCallsCount: totalToolCalls,
      steps: maxSteps,
    };
  }
}
