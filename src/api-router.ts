import express, { Request, Response } from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { CarcaraClient } from './carcara-client.js';
import { customMCPTools } from './mcp-tools.js';
import { SearchService } from './search-service.js';
import { LlamaUIConfigService, MCPServerConfig } from './llama-ui-config.js';
import { SandboxService } from './sandbox-service.js';
import { AgentEngine } from './agent-engine.js';
import { MemoryService } from './memory-service.js';
import { MetricsService } from './metrics-service.js';
import { registerAllAgents } from './agents/index.js';
import { ChatMessage, ToolCall, AgentTask, CodeTaskInput } from './types.js';
import { Readable } from 'stream';

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, max: 120,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

const strictLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, max: 30,
  message: { error: 'Rate limit exceeded for chat endpoint' },
});

export class CarcaraRouter {
  private app: express.Application;
  private client: CarcaraClient;
  private searchService: SearchService;
  private sandboxService: SandboxService;
  private agentEngine: AgentEngine;
  private memoryService: MemoryService;
  private metricsService: MetricsService;
  private reactAgent: ReActLoopAgent;
  private port: number;
  private dockerAvailable: boolean = false;

  constructor(port: number = 3030) {
    this.port = port;
    this.client = new CarcaraClient({ domain: 'LNCC' });
    this.searchService = new SearchService();
    this.sandboxService = new SandboxService();
    this.agentEngine = new AgentEngine();
    this.memoryService = new MemoryService();
    this.metricsService = new MetricsService();
    // reactAgent inicializado via registerAllAgents
    this.app = express();
  }

  private extractText(content: any): string {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((part: any) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        if (part?.text) return part.text;
        return '';
      }).filter(Boolean).join('\n');
    }
    return String(content);
  }

  /** Detecta se Docker esta disponivel no startup */
  private async detectEnvironment(): Promise<void> {
    this.dockerAvailable = await this.sandboxService.detectDocker();
    logger.info({ dockerAvailable: this.dockerAvailable }, 'Ambiente detectado');

    // Registra agentes
    this.reactAgent = registerAllAgents(this.agentEngine, this.client, this.memoryService, this.metricsService);
    this.client.setAgentEngine(this.agentEngine);
    this.client.setMemoryService(this.memoryService);
    this.client.setMetricsService(this.metricsService);
  }

  async start(): Promise<void> {
    await this.detectEnvironment();

    // ==========================================
    // MIDDLEWARE
    // ==========================================
    this.app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
    this.app.use(cors());
    this.app.use(compression());
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(limiter);

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
          data: models.map(m => ({ id: m.id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'carcara-lncc' })),
        });
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    // Chat completions com deteccao de agente integrada
    this.app.post('/v1/chat/completions', strictLimiter, async (req: Request, res: Response) => {
      try {
        const { model, messages, stream, tools } = req.body;
        const msgs: ChatMessage[] = messages || [];
        if (!msgs.length) return res.status(400).json({ error: 'Messages are required' });

        const completionId = `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        const created = Math.floor(Date.now() / 1000);
        const modelName = model || this.client.getDefaultModel();

        // Monta prompt
        const systemMsg = msgs.find(m => m.role === 'system');
        const recentMsgs = msgs.slice(-4);
        const parts: string[] = [];
        if (systemMsg) parts.push(`System: ${this.extractText(systemMsg.content)}`);

        for (const m of recentMsgs) {
          let text = this.extractText(m.content);
          if (!text) continue;
          const isLast = m === recentMsgs[recentMsgs.length - 1];
          if (!isLast && text.length > 1000) text = text.substring(0, 1000);
          switch (m.role) {
            case 'user': parts.push(`User: ${text}`); break;
            case 'assistant':
              parts.push(`Assistant: ${text}`);
              if (m.tool_calls?.length) parts.push(`Tools: ${JSON.stringify(m.tool_calls).substring(0, 500)}`);
              break;
            case 'tool': parts.push(`Tool: ${isLast ? text : text.substring(0, 2000)}`); break;
          }
        }

        const prompt = parts.join('\n');
        const lastMsg = recentMsgs[recentMsgs.length - 1];
        console.log(`Prompt: ${prompt.length} chars | ${this.extractText(lastMsg.content).substring(0, 80)}`);

        // === DETECCAO DE AGENTE ===
        const agentResult = await this.client.thinking.detectAndRunAgent(this.extractText(lastMsg.content));
        if (agentResult !== null) {
          // Retorna resultado do agente como mensagem do assistant
          if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.flushHeaders();

            // Streama o resultado do agente em chunks
            const CHUNK_SIZE = 20;
            for (let i = 0; i < agentResult.length; i += CHUNK_SIZE) {
              const chunk = agentResult.slice(i, i + CHUNK_SIZE);
              const delta = i === 0 ? { role: 'assistant', content: chunk } : { content: chunk };
              res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
            }
            res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
          } else {
            res.json({
              id: completionId, object: 'chat.completion', created, model: modelName,
              choices: [{ index: 0, message: { role: 'assistant', content: agentResult }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            });
            return;
          }
        }

        // === REACT LOOP (comportamento padrao para perguntas complexas) ===
    const userText = this.extractText(lastMsg.content);
    const shouldUseReAct = this.shouldUseReAct(userText);

    if (shouldUseReAct) {
      try {
        logger.info({ model: modelName }, 'Iniciando ReAct loop');
        const reactResult = await this.reactAgent.execute({
          id: `react_${Date.now()}`,
          agentId: 'react-loop',
          input: userText,
          config: { model: modelName, maxSteps: 15 },
        });

        const finalContent = reactResult.finalAnswer;

        if (stream) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders();

          const CHUNK_SIZE = 20;
          for (let i = 0; i < finalContent.length; i += CHUNK_SIZE) {
            const chunk = finalContent.slice(i, i + CHUNK_SIZE);
            const delta = i === 0 ? { role: 'assistant', content: chunk } : { content: chunk };
            res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        } else {
          res.json({
            id: completionId, object: 'chat.completion', created, model: modelName,
            choices: [{ index: 0, message: { role: 'assistant', content: finalContent }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          });
          return;
        }
      } catch (reactErr: any) {
        logger.error({ error: reactErr.message }, 'Erro no ReAct loop, fallback para fluxo normal');
        // Continua para fluxo normal
      }
    }

    // === FLUXO NORMAL (sem agente e sem ReAct) ===
        const response = await this.client.chatCompletion(prompt, model, tools);
        const content = response?.choices?.[0]?.message?.content || '';
        const toolCalls: ToolCall[] | undefined = response?.choices?.[0]?.message?.tool_calls;
        console.log(`Response: ${content.length} chars`);

        if (stream) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders();

          try {
            const lnccStream = await this.client.chatCompletionStream(prompt, model, tools);
            lnccStream.on('data', (chunk: Buffer) => { res.write(chunk); });
            lnccStream.on('end', () => { res.end(); });
            lnccStream.on('error', (err: any) => {
              console.error('Stream error:', err.message);
              res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
              res.end();
            });
            req.on('close', () => { lnccStream.destroy?.(); });
            return;
          } catch (err: any) {
            console.error('Streaming failed, falling back:', err.message);
            const CHUNK_SIZE = 20;
            for (let i = 0; i < content.length; i += CHUNK_SIZE) {
              const chunk = content.slice(i, i + CHUNK_SIZE);
              const delta = i === 0 ? { role: 'assistant', content: chunk } : { content: chunk };
              res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
            }
            res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
          }
        }

        res.json({
          id: completionId, object: 'chat.completion', created, model: modelName,
          choices: [{ index: 0, message: { role: 'assistant', content, tool_calls: toolCalls }, finish_reason: toolCalls?.length ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      } catch (error: any) {
        console.error('Chat completion error:', error.message);
        res.status(500).json({ error: { message: error.message, type: 'api_error' } });
      }
    });

    // Continue generation
    this.app.post('/v1/chat/completions/continue', strictLimiter, async (req: Request, res: Response) => {
      try {
        const { model, messages, tools } = req.body;
        const msgs: ChatMessage[] = messages || [];
        if (!msgs.length) return res.status(400).json({ error: 'Messages are required' });
        const lastUser = msgs.filter(m => m.role === 'user').pop();
        if (!lastUser) return res.status(400).json({ error: 'No user message' });
        const response = await this.client.chatCompletionWithContinue(lastUser.content, model, tools);
        res.json(response);
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    // Embeddings
    this.app.post('/v1/embeddings', async (req: Request, res: Response) => {
      try {
        const { model, input } = req.body;
        const inputs = Array.isArray(input) ? input : [input];
        res.json({
          object: 'list',
          data: inputs.map((_: any, i: number) => ({ object: 'embedding', embedding: new Array(1536).fill(0), index: i })),
          model: model || 'Qwen3.6-35B',
          usage: { prompt_tokens: 0, total_tokens: 0 },
        });
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    // ==========================================
    // OLLAMA COMPATIBLE
    // ==========================================

    this.app.get('/api/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', initialized: this.client.isReady, docker: this.dockerAvailable });
    });

    this.app.get('/api/tags', async (_req: Request, res: Response) => {
      try {
        const models = await this.client.getAvailableModels();
        res.json({ models: models.map(m => ({ name: m.id, model: m.id, modified_at: new Date().toISOString(), size: 0 })) });
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.post('/api/show', async (req: Request, res: Response) => {
      try {
        const { name } = req.body;
        const models = await this.client.getAvailableModels();
        const model = models.find(m => m.id === name);
        if (!model) return res.status(404).json({ error: 'Model not found' });
        res.json({ license: 'MIT', modelfile: '', parameters: '', template: '', details: { parent_model: '', format: 'gguf', family: 'qwen', families: ['qwen'], parameter_size: '35B', quantization_level: 'Q4_K_M' } });
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.post('/api/generate', strictLimiter, async (req: Request, res: Response) => {
      try {
        const { model, prompt, stream } = req.body;
        const response = await this.client.chatCompletion(prompt, model);
        const content = response.choices[0].message.content;

        if (stream) {
          res.setHeader('Content-Type', 'application/x-ndjson');
          res.flushHeaders();
          const CHUNK_SIZE = 20;
          for (let i = 0; i < content.length; i += CHUNK_SIZE) {
            res.write(JSON.stringify({ model, created_at: new Date().toISOString(), response: content.slice(i, i + CHUNK_SIZE), done: false }) + '\n');
          }
          res.write(JSON.stringify({ model, created_at: new Date().toISOString(), response: '', done: true }) + '\n');
          return res.end();
        }
        res.json({ model, created_at: new Date().toISOString(), response: content, done: true });
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.post('/api/chat', strictLimiter, async (req: Request, res: Response) => {
      try {
        const { model, messages, stream } = req.body;
        const prompt = messages.map((m: ChatMessage) => `${m.role}: ${this.extractText(m.content)}`).join('\n');

        // Deteccao de agente
        const lastUserMsg = messages.filter((m: ChatMessage) => m.role === 'user').pop();
        if (lastUserMsg) {
          const agentResult = await this.client.thinking.detectAndRunAgent(this.extractText(lastUserMsg.content));
          if (agentResult !== null) {
            if (stream) {
              res.setHeader('Content-Type', 'application/x-ndjson');
              res.flushHeaders();
              const CHUNK_SIZE = 20;
              for (let i = 0; i < agentResult.length; i += CHUNK_SIZE) {
                res.write(JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content: agentResult.slice(i, i + CHUNK_SIZE) }, done: false }) + '\n');
              }
              res.write(JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content: '' }, done: true }) + '\n');
              return res.end();
            }
            res.json({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content: agentResult }, done: true });
            return;
          }
        }

        const response = await this.client.chatCompletion(prompt, model);
        const content = response.choices[0].message.content;

        if (stream) {
          res.setHeader('Content-Type', 'application/x-ndjson');
          res.flushHeaders();
          const CHUNK_SIZE = 20;
          for (let i = 0; i < content.length; i += CHUNK_SIZE) {
            res.write(JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content: content.slice(i, i + CHUNK_SIZE) }, done: false }) + '\n');
          }
          res.write(JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content: '' }, done: true }) + '\n');
          return res.end();
        }
        res.json({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content }, done: true });
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.post('/api/embed', async (req: Request, res: Response) => {
      try {
        const { model, input } = req.body;
        const inputs = Array.isArray(input) ? input : [input];
        res.json({ embeddings: inputs.map(() => new Array(1536).fill(0)) });
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    // ==========================================
    // MCP TOOLS
    // ==========================================

    this.app.get('/mcp/list', async (_req: Request, res: Response) => {
      try {
        const tools = await this.client.listSdumontTools();
        const custom = customMCPTools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
        res.json({ tools: [...(tools?.result?.tools || []), ...custom] });
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.post('/mcp/call', async (req: Request, res: Response) => {
      try {
        const { server, method, params } = req.body;
        if (!server || !method) return res.status(400).json({ error: 'server and method are required' });
        const result = await this.client.callMcpTool(server, method, params);
        res.json(result);
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    // ==========================================
    // SEARCH
    // ==========================================

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
            id: conv.id, name: conv.name,
            lastModified: new Date(conv.lastModified).toISOString(),
            currNode: conv.currNode,
            mcpServers: conv.mcpServerOverrides?.length || 0,
            thinkingEnabled: conv.thinkingEnabled,
            totalMessages: msgArray.length,
            messages: msgArray.slice(-5).map(m => ({ role: m.role, type: m.type, content: m.content?.substring(0, 200) || '' })),
          });
        }
        res.json({ total: debug.length, conversations: debug });
      } catch { res.json({ total: 0, conversations: [] }); }
    });

    // ==========================================
    // ARVORE DE MENSAGENS
    // ==========================================

    this.app.get('/api/conversations/:id/tree', async (req: Request, res: Response) => {
      try {
        const messages = await this.client.getMessageTree(req.params.id);
        res.json({ conversationId: req.params.id, messages });
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.get('/api/messages/:msgId', async (req: Request, res: Response) => {
      try {
        const msg = await this.client.getMessageById(req.params.msgId);
        if (!msg) return res.status(404).json({ error: 'Message not found' });
        res.json(msg);
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    // ==========================================
    // SANDBOX (Docker apenas - detectado no startup)
    // ==========================================

    this.app.get('/api/sandbox/status', async (_req: Request, res: Response) => {
      try {
        const dockerAvailable = this.dockerAvailable;
        res.json({
          dockerAvailable,
          dockerConfig: this.sandboxService.getConfig(),
          mode: dockerAvailable ? 'docker' : 'unavailable',
          agents: this.agentEngine.list().map(a => ({ id: a.id, name: a.name, capabilities: a.capabilities })),
        });
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.post('/api/sandbox/exec', async (req: Request, res: Response) => {
      try {
        const { code, language, timeout, memory } = req.body;
        if (!code) return res.status(400).json({ error: 'code is required' });
        if (!language) return res.status(400).json({ error: 'language is required' });

        if (!this.dockerAvailable) {
          return res.status(503).json({ error: 'Docker nao disponivel. Sandbox desabilitado.' });
        }

        const dockerLangs = ['python', 'javascript', 'typescript', 'bash', 'sh'];
        if (!dockerLangs.includes(language)) {
          return res.status(400).json({ error: `Linguagem deve ser uma de: ${dockerLangs.join(', ')}` });
        }

        if (timeout) this.sandboxService.setConfig({ timeoutMs: timeout });
        if (memory) this.sandboxService.setConfig({ memoryLimitMb: memory });

        const result = await this.sandboxService.execute(code, language);
        res.json({ ...result, mode: 'docker' });
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.post('/api/sandbox/config', async (req: Request, res: Response) => {
      try {
        const { timeoutMs, memoryLimitMb, cpuPercent, networkEnabled, allowedLanguages } = req.body;
        this.sandboxService.setConfig({
          ...(timeoutMs !== undefined && { timeoutMs }),
          ...(memoryLimitMb !== undefined && { memoryLimitMb }),
          ...(cpuPercent !== undefined && { cpuPercent }),
          ...(networkEnabled !== undefined && { networkEnabled }),
          ...(allowedLanguages !== undefined && { allowedLanguages }),
        });
        res.json({ success: true, dockerConfig: this.sandboxService.getConfig() });
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    // ==========================================
    // AGENTES (integrados nas APIs existentes)
    // ==========================================

    // Executa agente via POST na API de chat (usando header X-Carcara-Agent)
    this.app.post('/v1/chat/completions', strictLimiter, async (req: Request, res: Response) => {
      const agentId = req.headers['x-carcara-agent'] as string;
      if (agentId && req.body.messages?.length) {
        try {
          const lastMsg = req.body.messages[req.body.messages.length - 1];
          const result = await this.agentEngine.run({
            id: `api_${Date.now()}`, agentId,
            input: { description: this.extractText(lastMsg.content), language: 'python' },
            config: req.body.config || {},
          });
          res.json({
            id: `agent-${Date.now()}`, object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: req.body.model || 'agent',
            choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(result.output, null, 2) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          });
          return;
        } catch (error: any) {
          res.status(500).json({ error: error.message });
          return;
        }
      }
    });

    // ==========================================
    // LLAMAUI CONFIG
    // ==========================================

    this.app.get('/api/config', async (_req: Request, res: Response) => {
      try { const config = await this.client.llamaUI.getConfig(); res.json({ config }); }
      catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.post('/api/config', async (req: Request, res: Response) => {
      try { await this.client.llamaUI.setConfig(req.body); res.json({ success: true }); }
      catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.get('/api/config/system-message', async (_req: Request, res: Response) => {
      try { const msg = await this.client.llamaUI.getSystemMessage(); res.json({ systemMessage: msg }); }
      catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.post('/api/config/system-message', async (req: Request, res: Response) => {
      try {
        const { message } = req.body;
        if (message === undefined) return res.status(400).json({ error: 'message is required' });
        await this.client.llamaUI.setSystemMessage(message);
        res.json({ success: true, systemMessage: message });
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.get('/api/config/mcp', async (_req: Request, res: Response) => {
      try { const servers = await this.client.llamaUI.getMcpServers(); res.json({ servers }); }
      catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.post('/api/config/mcp', async (req: Request, res: Response) => {
      try {
        const server: MCPServerConfig = req.body;
        if (!server.id || !server.url) return res.status(400).json({ error: 'id and url are required' });
        await this.client.llamaUI.addMcpServer(server);
        res.json({ success: true, server });
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.delete('/api/config/mcp/:id', async (req: Request, res: Response) => {
      try { await this.client.llamaUI.removeMcpServer(req.params.id); res.json({ success: true, removed: req.params.id }); }
      catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.get('/api/config/thinking', async (_req: Request, res: Response) => {
      try { const enabled = await this.client.llamaUI.getEnableThinking(); res.json({ enableThinking: enabled }); }
      catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.post('/api/config/thinking', async (req: Request, res: Response) => {
      try {
        const { enabled } = req.body;
        if (enabled === undefined) return res.status(400).json({ error: 'enabled is required' });
        await this.client.llamaUI.setEnableThinking(enabled);
        res.json({ success: true, enableThinking: enabled });
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.get('/api/config/theme', async (_req: Request, res: Response) => {
      try { const theme = await this.client.llamaUI.getTheme(); res.json({ theme }); }
      catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.post('/api/config/theme', async (req: Request, res: Response) => {
      try { await this.client.llamaUI.setTheme(req.body.theme); res.json({ success: true }); }
      catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    // ==========================================
    // START
    // ==========================================

    await this.client.init();

    return new Promise<void>((resolve) => {
      this.app.listen(this.port, () => {
        console.log('\\u2554\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2557');
        console.log('\\u2551      🤖 Carcara Proxy v3.0 - Agentic Loop      \u2551');
        console.log('\\u2551         Docker: ' + (this.dockerAvailable ? '✅' : '❌') + ' | Agents: ' + this.agentEngine.list().length + '         \u2551');
        console.log('\\u2560\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2557');
        console.log(`\\u2551  🌐 http://localhost:${this.port}                           \u2551`);
        console.log('\\u2551  📋 OpenAI: /v1/models, /v1/chat/completions, /v1/embeddings  \u2551');
        console.log('\\u2551  📋 Ollama: /api/health, /api/tags, /api/chat, /api/generate  \u2551');
        console.log('\\u2551  🔧 MCP: /mcp/list, /mcp/call                                \u2551');
        console.log('\\u2551  🐳 Sandbox: /api/sandbox/exec (Docker)                        \u2551');
        console.log('\\u2551  🔍 Search: /api/search, /api/search/ddg, /api/search/wiki     \u2551');
        console.log('\\u2551  🤖 Agentes: detectados automaticamente no chat               \u2551');
        console.log('\\u2551  🧠 Memoria: .carcara/memory.jsonl                            \u2551');
        console.log('\\u2551  📊 Metricas: .carcara/metrics.jsonl                          \u2551');
        console.log('\\u255a\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u255d');
        console.log(`\\u2551  📁 Sessao: .carcara/session.json                              \u2551`);
        console.log('\\u255a\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u255d\\n');
        resolve();
      });
    });
  }

  /**
   * Heuristica para decidir se uma pergunta beneficia do loop ReAct
   */
  private shouldUseReAct(text: string): boolean {
    const lower = text.toLowerCase().trim();

    // Sempre usa ReAct para certos padroes
    const reactPatterns = [
      /\b(calcule|calculate|compute|quanto [ée])\b/i,
      /\b(busque|search|pesquise|encontre|procure)\b/i,
      /\b(compare|comparar|diferenca entre)\b/i,
      /\b(analise|analyze|explique|explain|por que|why|how)\b/i,
      /\b(codigo|code|script|programa|funcao)\b/i,
      /\b(dados|data|estatistica|statistic|grafico|chart)\b/i,
      /\b(202[0-9]|atual|current|hoje|today|agora|now)\b/i,
      /\b(clima|weather|temperatura|temperature)\b/i,
      /\b(populacao|population|gdp|economia|economy)\b/i,
    ];

    for (const p of reactPatterns) {
      if (p.test(lower)) return true;
    }

    // Perguntas com multiplas partes (virgulas, "e", "depois")
    if ((lower.match(/\b(e|depois|then|after|next)\b/g) || []).length >= 2) {
      return true;
    }

    // Perguntas longas (>100 chars) provavelmente sao complexas
    if (text.length > 100) {
      return true;
    }

    return false;
  }

  async stop(): Promise<void> {
    await this.client.close();
    this.metricsService.stop();
  }
}

import pino from 'pino';
import { ReActLoopAgent } from './agents/react-loop-agent.js';
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
