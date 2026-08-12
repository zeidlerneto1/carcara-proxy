import express, { Request, Response } from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { CarcaraClient } from './carcara-client.js';
import { customMCPTools } from './mcp-tools.js';
import { SearchService } from './search-service.js';
import { LlamaUIConfigService, MCPServerConfig } from './llama-ui-config.js';
import { ChatMessage, ToolCall } from './types.js';
import { Readable } from 'stream';

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

const strictLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { error: 'Rate limit exceeded for chat endpoint' },
});

export class CarcaraRouter {
  private app: express.Application;
  private client: CarcaraClient;
  private searchService: SearchService;
  private port: number;

  constructor(port: number = 3030) {
    this.port = port;
    this.client = new CarcaraClient({ domain: 'LNCC' });
    this.searchService = new SearchService();
    this.app = express();
  }

  private extractText(content: any): string {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part: any) => {
          if (typeof part === 'string') return part;
          if (part?.type === 'text') return part.text || '';
          if (part?.text) return part.text;
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    return String(content);
  }

  async start(): Promise<void> {
    // ==========================================
    // MIDDLEWARE (otimizado)
    // ==========================================
    this.app.use(helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }));
    this.app.use(cors());
    this.app.use(compression());
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(limiter);

    // Request logging leve
    this.app.use((req: Request, _res: Response, next) => {
      console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
      next();
    });

    // ==========================================
    // ROTAS OPENAI-COMPATIBLE
    // ==========================================

    this.app.get('/v1/models', async (_req: Request, res: Response) => {
      try {
        const models = await this.client.getAvailableModels();
        res.json({
          object: 'list',
          data: models.map(m => ({
            id: m.id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'carcara-lncc',
          })),
        });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // Chat completions com streaming otimizado
    this.app.post('/v1/chat/completions', strictLimiter, async (req: Request, res: Response) => {
      try {
        const { model, messages, stream, tools } = req.body;
        const msgs: ChatMessage[] = messages || [];

        if (!msgs.length) {
          return res.status(400).json({ error: 'Messages are required' });
        }

        const completionId = `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        const created = Math.floor(Date.now() / 1000);
        const modelName = model || this.client.getDefaultModel();

        // Monta prompt com historico (ultimas 4 msgs)
        const systemMsg = msgs.find(m => m.role === 'system');
        const recentMsgs = msgs.slice(-4);
        const parts: string[] = [];

        if (systemMsg) {
          parts.push(`System: ${this.extractText(systemMsg.content)}`);
        }

        for (const m of recentMsgs) {
          let text = this.extractText(m.content);
          if (!text) continue;
          const isLast = m === recentMsgs[recentMsgs.length - 1];
          if (!isLast && text.length > 1000) {
            text = text.substring(0, 1000);
          }
          switch (m.role) {
            case 'user': parts.push(`User: ${text}`); break;
            case 'assistant':
              parts.push(`Assistant: ${text}`);
              if (m.tool_calls?.length) {
                parts.push(`Tools: ${JSON.stringify(m.tool_calls).substring(0, 500)}`);
              }
              break;
            case 'tool':
              parts.push(`Tool: ${isLast ? text : text.substring(0, 2000)}`);
              break;
          }
        }

        const prompt = parts.join('\n');
        const lastMsg = recentMsgs[recentMsgs.length - 1];
        console.log(`Prompt: ${prompt.length} chars | ${this.extractText(lastMsg.content).substring(0, 80)}`);

        const response = await this.client.chatCompletion(prompt, model, tools);
        const content = response?.choices?.[0]?.message?.content || '';
        const toolCalls: ToolCall[] | undefined = response?.choices?.[0]?.message?.tool_calls;

        console.log(`Response: ${content.length} chars`);

        // STREAMING SSE REAL - proxy direto do LNCC
        if (stream) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders();

          try {
            // Faz request ao LNCC com stream=true e pipeia direto
            const lnccStream = await this.client.chatCompletionStream(
              prompt, model, tools
            );

            lnccStream.on('data', (chunk: Buffer) => {
              res.write(chunk);
            });

            lnccStream.on('end', () => {
              res.end();
            });

            lnccStream.on('error', (err: any) => {
              console.error('Stream error:', err.message);
              res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
              res.end();
            });

            // Se cliente fecha conexão, aborta stream
            req.on('close', () => {
              lnccStream.destroy?.();
            });

            return;
          } catch (err: any) {
            console.error('Streaming failed, falling back:', err.message);
            // Fallback: streaming simulado
            const CHUNK_SIZE = 20;
            for (let i = 0; i < content.length; i += CHUNK_SIZE) {
              const chunk = content.slice(i, i + CHUNK_SIZE);
              const delta = i === 0 ? { role: 'assistant', content: chunk } : { content: chunk };
              res.write(`data: ${JSON.stringify({
                id: completionId, object: 'chat.completion.chunk', created, model: modelName,
                choices: [{ index: 0, delta, finish_reason: null }],
              })}\n\n`);
            }
            res.write(`data: ${JSON.stringify({
              id: completionId, object: 'chat.completion.chunk', created, model: modelName,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
          }
        }

        // Nao-streaming
        res.json({
          id: completionId,
          object: 'chat.completion',
          created,
          model: modelName,
          choices: [{
            index: 0,
            message: { role: 'assistant', content, tool_calls: toolCalls },
            finish_reason: toolCalls?.length ? 'tool_calls' : 'stop',
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });

      } catch (error: any) {
        console.error('Chat completion error:', error.message);
        res.status(500).json({ error: { message: error.message, type: 'api_error' } });
      }
    });


    // Continue generation (quebra limite de tokens)
    this.app.post('/v1/chat/completions/continue', strictLimiter, async (req: Request, res: Response) => {
      try {
        const { model, messages, tools } = req.body;
        const msgs: ChatMessage[] = messages || [];
        if (!msgs.length) return res.status(400).json({ error: 'Messages are required' });

        const lastUser = msgs.filter(m => m.role === 'user').pop();
        if (!lastUser) return res.status(400).json({ error: 'No user message' });

        const response = await this.client.chatCompletionWithContinue(
          lastUser.content, model, tools
        );
        res.json(response);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // Embeddings
    this.app.post('/v1/embeddings', async (req: Request, res: Response) => {
      try {
        const { model, input } = req.body;
        const inputs = Array.isArray(input) ? input : [input];
        res.json({
          object: 'list',
          data: inputs.map((_: any, i: number) => ({
            object: 'embedding',
            embedding: new Array(1536).fill(0),
            index: i,
          })),
          model: model || 'Qwen3.6-35B',
          usage: { prompt_tokens: 0, total_tokens: 0 },
        });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // ==========================================
    // OLLAMA, MCP, SEARCH, DEBUG
    // ==========================================

    this.app.get('/api/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', initialized: this.client.isReady });
    });

    this.app.get('/api/tags', async (_req: Request, res: Response) => {
      try {
        const models = await this.client.getAvailableModels();
        res.json({
          models: models.map(m => ({
            name: m.id,
            model: m.id,
            modified_at: new Date().toISOString(),
            size: 0,
            digest: m.id,
            details: {
              format: 'gguf',
              family: 'llama',
              parameter_size: m.id.includes('70b') ? '70B' : m.id.includes('35B') ? '35B' : 'unknown',
            },
          })),
        });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/show', async (req: Request, res: Response) => {
      try {
        const { name } = req.body;
        const models = await this.client.getAvailableModels();
        const model = models.find(m => m.id === name);
        if (!model) return res.status(404).json({ error: 'Model not found' });
        res.json({
          license: 'LNCC License',
          modelfile: `# ${model.name}`,
          parameters: '',
          template: '',
          details: { format: 'gguf', family: 'llama' },
          model_info: model,
        });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/generate', strictLimiter, async (req: Request, res: Response) => {
      try {
        const { model, prompt, system } = req.body;
        if (!prompt) return res.status(400).json({ error: 'Prompt is required' });
        const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
        const response = await this.client.chatCompletion(fullPrompt, model);
        res.json({
          model: model || 'Qwen3.6-35B',
          created_at: new Date().toISOString(),
          response: response.choices[0].message.content,
          done: true,
        });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/chat', strictLimiter, async (req: Request, res: Response) => {
      try {
        const { model, messages } = req.body;
        const msgs: ChatMessage[] = messages || [];
        if (!msgs.length) return res.status(400).json({ error: 'Messages are required' });
        const lastUserMsg = msgs.filter(m => m.role === 'user').pop();
        if (!lastUserMsg) return res.status(400).json({ error: 'No user message found' });
        const response = await this.client.chatCompletion(lastUserMsg.content, model);
        res.json({
          model: model || 'Qwen3.6-35B',
          created_at: new Date().toISOString(),
          message: { role: 'assistant', content: response.choices[0].message.content },
          done: true,
          total_duration: 0,
          load_duration: 0,
        });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/embed', async (req: Request, res: Response) => {
      const { input } = req.body;
      if (!input) return res.status(400).json({ error: 'Input is required' });
      res.json({
        model: 'Qwen3.6-35B',
        embeddings: [[0]],
        total_duration: 0,
        load_duration: 0,
        prompt_eval_count: 0,
      });
    });

    this.app.get('/api/conversations/:id/export', async (req: Request, res: Response) => {
      try {
        const filePath = await this.client.saveConversationToFile(req.params.id);
        res.json({ success: true, path: filePath });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/mcp/list', async (_req: Request, res: Response) => {
      try {
        const carcaraTools = await this.client.listSdumontTools();
        const carcaraToolList = carcaraTools?.result?.tools || [];
        const customTools = customMCPTools.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        res.json({ tools: [...customTools, ...carcaraToolList] });
      } catch {
        res.json({ tools: customMCPTools.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })) });
      }
    });

    this.app.post('/mcp/call', async (req: Request, res: Response) => {
      try {
        const { name, arguments: args } = req.body;
        const customTool = customMCPTools.find(t => t.name === name);
        if (customTool) {
          return res.json({ result: await customTool.handler(args || {}) });
        }
        res.json({
          result: await this.client.callMcpTool('lncc-sdumont', 'tools/call', { name, arguments: args }),
        });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/search', async (req: Request, res: Response) => {
      const { query, providers } = req.body;
      if (!query) return res.status(400).json({ error: 'Query is required' });
      res.json(await this.searchService.search(query, providers));
    });

    this.app.post('/api/search/ddg', async (req: Request, res: Response) => {
      const { query } = req.body;
      if (!query) return res.status(400).json({ error: 'Query is required' });
      res.json(await this.searchService.duckDuckGo(query));
    });

    this.app.post('/api/search/wiki', async (req: Request, res: Response) => {
      const { query } = req.body;
      if (!query) return res.status(400).json({ error: 'Query is required' });
      res.json(await this.searchService.wikipedia(query));
    });

    this.app.get('/ping', (_req: Request, res: Response) => res.json({ pong: true }));

    this.app.get('/api/debug/conversations', async (_req: Request, res: Response) => {
      try {
        const conversations = await this.client.getConversations();
        const convArray = Array.isArray(conversations) ? conversations : [];
        const debug = [];
        for (const conv of convArray) {
          const messages = await this.client.getConversationMessages(conv.id);
          const msgArray = Array.isArray(messages) ? messages : [];
          debug.push({
            id: conv.id,
            name: conv.name,
            lastModified: new Date(conv.lastModified).toISOString(),
            currNode: conv.currNode,
            mcpServers: conv.mcpServerOverrides?.length || 0,
            thinkingEnabled: conv.thinkingEnabled,
            totalMessages: msgArray.length,
            messages: msgArray.slice(-5).map(m => ({
              role: m.role,
              type: m.type,
              content: m.content?.substring(0, 200) || '',
            })),
          });
        }
        res.json({ total: debug.length, conversations: debug });
      } catch {
        res.json({ total: 0, conversations: [] });
      }
    });



    // ==========================================
    // ARVORE DE MENSAGENS (parent/children)
    // ==========================================

    this.app.get('/api/conversations/:id/tree', async (req: Request, res: Response) => {
      try {
        const messages = await this.client.getMessageTree(req.params.id);
        res.json({ conversationId: req.params.id, messages });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/messages/:msgId', async (req: Request, res: Response) => {
      try {
        const msg = await this.client.getMessageById(req.params.msgId);
        if (!msg) return res.status(404).json({ error: 'Message not found' });
        res.json(msg);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // ==========================================
    // LLAMAUI CONFIG (localStorage)
    // ==========================================

    this.app.get('/api/config', async (_req: Request, res: Response) => {
      try {
        const config = await this.client.llamaUI.getConfig();
        res.json({ config });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/config', async (req: Request, res: Response) => {
      try {
        await this.client.llamaUI.setConfig(req.body);
        res.json({ success: true });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/config/system-message', async (_req: Request, res: Response) => {
      try {
        const msg = await this.client.llamaUI.getSystemMessage();
        res.json({ systemMessage: msg });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/config/system-message', async (req: Request, res: Response) => {
      try {
        const { message } = req.body;
        if (message === undefined) return res.status(400).json({ error: 'message is required' });
        await this.client.llamaUI.setSystemMessage(message);
        res.json({ success: true, systemMessage: message });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/config/mcp', async (_req: Request, res: Response) => {
      try {
        const servers = await this.client.llamaUI.getMcpServers();
        res.json({ servers });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/config/mcp', async (req: Request, res: Response) => {
      try {
        const server: MCPServerConfig = req.body;
        if (!server.id || !server.url) return res.status(400).json({ error: 'id and url are required' });
        await this.client.llamaUI.addMcpServer(server);
        res.json({ success: true, server });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.delete('/api/config/mcp/:id', async (req: Request, res: Response) => {
      try {
        await this.client.llamaUI.removeMcpServer(req.params.id);
        res.json({ success: true, removed: req.params.id });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/config/thinking', async (_req: Request, res: Response) => {
      try {
        const enabled = await this.client.llamaUI.getEnableThinking();
        res.json({ enableThinking: enabled });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/config/thinking', async (req: Request, res: Response) => {
      try {
        const { enabled } = req.body;
        if (enabled === undefined) return res.status(400).json({ error: 'enabled is required' });
        await this.client.llamaUI.setEnableThinking(enabled);
        res.json({ success: true, enableThinking: enabled });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/config/theme', async (_req: Request, res: Response) => {
      try {
        const theme = await this.client.llamaUI.getTheme();
        res.json({ theme });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/config/theme', async (req: Request, res: Response) => {
      try {
        const { theme } = req.body;
        if (!theme) return res.status(400).json({ error: 'theme is required' });
        await this.client.llamaUI.setTheme(theme);
        res.json({ success: true, theme });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/config/raw', async (_req: Request, res: Response) => {
      try {
        const data = await this.client.llamaUI.getAllLlamaUiData();
        res.json(data);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/config/raw/:key', async (req: Request, res: Response) => {
      try {
        const value = await this.client.llamaUI.getRaw(req.params.key);
        res.json({ key: req.params.key, value });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/config/raw/:key', async (req: Request, res: Response) => {
      try {
        const { value } = req.body;
        if (value === undefined) return res.status(400).json({ error: 'value is required' });
        await this.client.llamaUI.setRaw(req.params.key, value);
        res.json({ success: true, key: req.params.key });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.delete('/api/config/reset', async (_req: Request, res: Response) => {
      try {
        await this.client.llamaUI.resetConfig();
        res.json({ success: true, message: 'LlamaUI config resetada' });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // ==========================================
    // INICIALIZAR
    // ==========================================
    console.log('Inicializando Carcara Client...');
    try {
      await this.client.init();
      console.log('Cliente pronto!');
    } catch (error: any) {
      console.error('Erro na inicializacao:', error.message);
    }

    return new Promise((resolve) => {
      this.app.listen(this.port, () => {
        console.log(`\n🦙 Carcara AI Gateway`);
        console.log(`🌐 http://localhost:${this.port}`);
        console.log('═══════════════════════════════════════');
        console.log('📋 OpenAI Compatible:');
        console.log(` GET /v1/models → Listar modelos`);
        console.log(` POST /v1/chat/completions → Chat (stream/nao-stream)`);
        console.log(` POST /v1/embeddings → Embeddings`);
        console.log('');
        console.log('📋 Ollama Compatible:');
        console.log(` GET /api/health → Health check`);
        console.log(` GET /api/tags → Listar modelos`);
        console.log(` POST /api/show → Info do modelo`);
        console.log(` POST /api/generate → Gerar texto`);
        console.log(` POST /api/chat → Chat`);
        console.log(` POST /api/embed → Embeddings`);
        console.log('');
        console.log('📋 MCP Tools:');
        console.log(` GET /mcp/list → Listar ferramentas`);
        console.log(` POST /mcp/call → Chamar ferramenta`);
        console.log('');
        console.log('📋 Search:');
        console.log(` POST /api/search → Busca multi-provider`);
        console.log(` POST /api/search/ddg → DuckDuckGo`);
        console.log(` POST /api/search/wiki → Wikipedia`);
        console.log('');
        console.log('📋 Debug:');
        console.log(` GET /ping → Ping`);
        console.log(` GET /api/debug/conversations → Debug detalhado`);
        console.log(` GET /api/conversations/:id/export → Exportar conversa`);
        console.log('═══════════════════════════════════════');
        console.log(`📁 Sessao: .carcara/session.json`);
        console.log('═══════════════════════════════════════\n');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await this.client.close();
  }
}
