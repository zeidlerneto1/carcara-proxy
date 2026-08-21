import express, { Request, Response } from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { CarcaraClient } from '../carcara-client.js';
import { customMCPTools } from '../mcp-tools.js';
import { SearchService } from '../infrastructure/services/search-service.js';
import { LlamaUIConfigService, MCPServerConfig } from '../llama-ui-config.js';
import { AgentEngine } from '../application/agents/agent-engine.js';
import { MemoryService } from '../memory-service.js';
import { MetricsService } from '../metrics-service.js';
import { registerAllAgents } from '../agents/index.js';
import { ChatUseCase } from '../application/use-cases/chat-use-case.js';
import { ApprovalService } from '../application/services/approval-service.js';
import { StreamingCodeParser } from '../infrastructure/parsers/streaming-code-parser.js';
import { ChatMessage, ToolCall } from '../types.js';

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, max: 120,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

const strictLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, max: 30,
  message: { error: 'Rate limit exceeded for chat endpoint' },
});

class ConcurrencySemaphore {
  private max: number;
  private current = 0;
  private queue: (() => void)[] = [];

  constructor(max: number) {
    this.max = max;
  }

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise(resolve => this.queue.push(resolve));
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next();
    }
  }

  getCurrent(): number {
    return this.current;
  }
}

export class CarcaraRouter {
  private app: express.Application;
  private client: CarcaraClient;
  private searchService: SearchService;
  private agentEngine: AgentEngine;
  private memoryService: MemoryService;
  private metricsService: MetricsService;
  private reactAgent: any;
  private chatUseCase: ChatUseCase;
  private approvalService: ApprovalService;
  private codeParser: StreamingCodeParser;
  private port: number;
  private semaphore: ConcurrencySemaphore;
  private allowHostExecution: boolean;

  constructor(port: number = 3030) {
    this.port = port;
    this.client = new CarcaraClient({ domain: 'LNCC' });
    this.searchService = new SearchService();
    this.agentEngine = new AgentEngine();
    this.memoryService = new MemoryService();
    this.metricsService = new MetricsService();
    this.approvalService = new ApprovalService(false);
    this.codeParser = new StreamingCodeParser();
    this.chatUseCase = new ChatUseCase(this.client as any, this.searchService as any);
    this.semaphore = new ConcurrencySemaphore(3);
    this.allowHostExecution = process.env.ALLOW_HOST_EXECUTION === 'true';
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

  async start(): Promise<void> {
    this.app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
    this.app.use(cors());
    this.app.use(compression());
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(limiter);

    this.app.use((req: Request, _res: Response, next) => {
      console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
      next();
    });

    this.reactAgent = registerAllAgents(
      this.agentEngine, this.client, this.memoryService, this.metricsService,
      this.allowHostExecution, this.approvalService
    );
    this.client.setAgentEngine(this.agentEngine);
    this.client.setMemoryService(this.memoryService);
    this.client.setMetricsService(this.metricsService);

    this.app.get('/v1/models', async (_req: Request, res: Response) => {
      try {
        const models = await this.client.getAvailableModels();
        res.json({
          object: 'list',
          data: models.map(m => ({ id: m.id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'carcara-lncc' })),
        });
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.post('/v1/chat/completions', strictLimiter, async (req: Request, res: Response) => {
      await this.semaphore.acquire();
      try {
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

        const { model, messages, stream, tools: clientTools } = req.body;
        const msgs: ChatMessage[] = messages || [];
        if (!msgs.length) return res.status(400).json({ error: 'Messages are required' });

        const completionId = `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        const created = Math.floor(Date.now() / 1000);
        const modelName = model || this.client.getDefaultModel();

        const lnccMessages: any[] = [];
        const systemMsg = msgs.find((m) => m.role === 'system');
        if (systemMsg) lnccMessages.push({ role: 'system', content: this.extractText(systemMsg.content) });

        for (const m of msgs.slice(-10)) {
          if (m.role === 'system') continue;
          const text = this.extractText(m.content);
          if (!text && !(m as any).tool_calls) continue;
          const msg: any = { role: m.role, content: text };
          if ((m as any).tool_calls) msg.tool_calls = (m as any).tool_calls;
          if ((m as any).tool_call_id) {
            msg.tool_call_id = (m as any).tool_call_id;
            msg.name = (m as any).name || '';
          }
          lnccMessages.push(msg);
        }

        const lastMsg = msgs[msgs.length - 1];
        const userText = this.extractText(lastMsg.content);
        console.log(`Prompt: ${userText.length} chars | ${userText.substring(0, 80)}`);

        const agentResult = await this.client.thinking.detectAndRunAgent(userText);
        if (agentResult !== null) {
          return this._sendResponse(res, agentResult, completionId, created, modelName, stream);
        }

        const useNativeTools = !clientTools || clientTools.length === 0;
        if (useNativeTools) {
          try {
            logger.info({ model: modelName }, 'Iniciando ToolCalling loop nativo');
            const result = await this.chatUseCase.runToolLoop(lnccMessages, modelName, 15);
            return this._sendResponse(res, result.content, completionId, created, modelName, stream);
          } catch (toolErr: any) {
            logger.error({ error: toolErr.message }, 'Erro no ToolCalling, fallback normal');
          }
        }

        const prompt = lnccMessages.map((m) => `${m.role}: ${m.content}`).join('\n');
        const response = await this.client.chatCompletion(prompt, modelName, clientTools);
        const content = response?.choices?.[0]?.message?.content || '';
        const toolCalls: ToolCall[] | undefined = response?.choices?.[0]?.message?.tool_calls;
        return this._sendResponse(res, content, completionId, created, modelName, stream, toolCalls);
      } catch (error: any) {
        console.error('Chat completion error:', error.message);
        res.status(500).json({ error: { message: error.message, type: 'api_error' } });
      } finally {
        this.semaphore.release();
      }
    });

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

    this.app.get('/api/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        initialized: this.client.isReady,
        allowHostExecution: this.allowHostExecution,
        concurrencyMax: 3,
        concurrencyCurrent: this.semaphore.getCurrent(),
      });
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

    this.app.get('/api/approval/pending', (_req: Request, res: Response) => {
      res.json({ pending: this.approvalService.listPending() });
    });

    this.app.post('/api/approval/respond', (req: Request, res: Response) => {
      const { id, approved } = req.body;
      if (!id || approved === undefined) return res.status(400).json({ error: 'id and approved are required' });
      const ok = this.approvalService.respond(id, approved);
      res.json({ success: ok, id, approved });
    });

    this.app.get('/api/approval/:id', (req: Request, res: Response) => {
      const req_ = this.approvalService.get(req.params.id);
      if (!req_) return res.status(404).json({ error: 'Approval request not found' });
      res.json(req_);
    });

    this.app.post('/api/parser/feed', (req: Request, res: Response) => {
      const { token, reset } = req.body;
      if (reset) this.codeParser.reset();
      if (token) {
        const result = this.codeParser.feed(token);
        res.json(result);
      } else {
        res.json({ language: '', code: '', isComplete: false });
      }
    });

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

    await this.client.init();

    return new Promise<void>((resolve) => {
      this.app.listen(this.port, () => {
        console.log('╔═══════════════════════════════════════════════════════════════╗');
        console.log('║      🤖 Carcara Proxy v3.2 - N-Layers + ReAct Host           ║');
        console.log(`║         HostExec: ${this.allowHostExecution ? '✅' : '❌'} | Concurrency: 3 | Agents: ${this.agentEngine.list().length}         ║`);
        console.log('╠═══════════════════════════════════════════════════════════════╣');
        console.log(`║  🌐 http://localhost:${this.port}                                    ║`);
        console.log('║  📋 OpenAI: /v1/models, /v1/chat/completions, /v1/embeddings  ║');
        console.log('║  📋 Ollama: /api/health, /api/tags, /api/chat, /api/generate  ║');
        console.log('║  🔧 MCP: /mcp/list, /mcp/call                                ║');
        console.log('║  🔍 Search: /api/search, /api/search/ddg, /api/search/wiki     ║');
        console.log('║  ✅ Approval: /api/approval/pending, /api/approval/respond     ║');
        console.log('║  🤖 Agentes: ReAct com execucao host (Human-in-the-Loop)      ║');
        console.log('║  🧠 Memoria: .carcara/memory.jsonl                            ║');
        console.log('║  📊 Metricas: .carcara/metrics.jsonl                          ║');
        console.log('╚═══════════════════════════════════════════════════════════════╝');
        resolve();
      });
    });
  }

  private _sendResponse(
    res: Response,
    content: string,
    completionId: string,
    created: number,
    modelName: string,
    stream: boolean,
    toolCalls?: ToolCall[]
  ): void {
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const CHUNK_SIZE = 20;
      for (let i = 0; i < content.length; i += CHUNK_SIZE) {
        const chunk = content.slice(i, i + CHUNK_SIZE);
        const delta = i === 0 ? { role: 'assistant', content: chunk } : { content: chunk };
        res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.json({
        id: completionId, object: 'chat.completion', created, model: modelName,
        choices: [{ index: 0, message: { role: 'assistant', content, tool_calls: toolCalls }, finish_reason: toolCalls?.length ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
  }

  async stop(): Promise<void> {
    await this.client.close();
    this.metricsService.stop();
  }
}

import pino from 'pino';
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
