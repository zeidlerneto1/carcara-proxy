// src/api-router.ts - COMPLETO COM MCP E SEARCH
import express, { Request, Response } from 'express';
import cors from 'cors';
import { CarcaraClient } from './carcara-client';
import { customMCPTools } from './mcp-tools';
import { SearchService } from './search-service';
import { ChatMessage, ToolCall } from './types';

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

  // Extrai texto de qualquer formato de content
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
    // MIDDLEWARE
    // ==========================================
    this.app.use(cors());
    this.app.use(express.json({ limit: '10mb' }));

    this.app.use((req: Request, _res: Response, next) => {
      console.log(`📡 ${req.method} ${req.url}`);
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
            id: m.id, object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'carcara-lncc',
          })),
        });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // ⭐ /v1/chat/completions - ATUALIZADO (32K contexto)
    this.app.post('/v1/chat/completions', async (req: Request, res: Response) => {
      try {
        const { model, messages, stream, tools } = req.body;
        const msgs: ChatMessage[] = messages || [];

        if (!msgs.length) {
          return res.status(400).json({ error: 'Messages are required' });
        }

        const completionId = `chatcmpl-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
        const created = Math.floor(Date.now() / 1000);
        const modelName = model || this.client.getDefaultModel();

        // ==========================================
        // LIMITES PARA 32K CONTEXTO
        // ==========================================
        const MAX_PROMPT = 25000;
        const MAX_MSG_CHARS = 4000;
        const MAX_TOOL_CHARS = 8000;
        const MAX_HISTORY = 10;

        // System prompt sempre completo
        const systemMsg = msgs.find(m => m.role === 'system');
        const recentMsgs = msgs.slice(-MAX_HISTORY);
        
        const promptParts: string[] = [];
        let totalChars = 0;

        if (systemMsg && !recentMsgs.includes(systemMsg)) {
          const sysText = this.extractText(systemMsg.content);
          promptParts.push(`<|im_start|>system\n${sysText}<|im_end|>\n`);
          totalChars += sysText.length;
        }

        for (const m of recentMsgs) {
          let text = this.extractText(m.content);
          if (!text && !m.tool_calls?.length) continue;

          const isLast = m === recentMsgs[recentMsgs.length - 1];

          switch (m.role) {
            case 'system':
              promptParts.push(`<|im_start|>system\n${text}<|im_end|>\n`);
              break;
            case 'user':
              if (!isLast && text.length > MAX_MSG_CHARS) {
                text = text.substring(0, MAX_MSG_CHARS);
              }
              promptParts.push(`<|im_start|>user\n${text}<|im_end|>\n`);
              break;
            case 'assistant':
              if (!isLast && text.length > MAX_MSG_CHARS) {
                text = text.substring(0, MAX_MSG_CHARS);
              }
              promptParts.push(`<|im_start|>assistant\n${text}`);
              if (m.tool_calls?.length) {
                promptParts.push(JSON.stringify(m.tool_calls));
              }
              promptParts.push(`<|im_end|>\n`);
              break;
            case 'tool':
              if (!isLast && text.length > MAX_TOOL_CHARS) {
                text = text.substring(0, MAX_TOOL_CHARS);
              }
              promptParts.push(`<|im_start|>tool\n${text}<|im_end|>\n`);
              break;
          }
        }

        promptParts.push(`<|im_start|>assistant\n`);
        const prompt = promptParts.join('');

        const lastMsg = recentMsgs[recentMsgs.length - 1];
        console.log(`💬 Prompt: ${prompt.length} chars | ${this.extractText(lastMsg.content).substring(0, 80)}`);

        const response = await this.client.chatCompletion(prompt, model, tools);
        const content = response?.choices?.[0]?.message?.content || '';
        const toolCalls: ToolCall[] | undefined = response?.choices?.[0]?.message?.tool_calls;

        console.log(`🤖 Response: ${content.length} chars | ${content.substring(0, 80)}`);

        // STREAMING SSE
        if (stream) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders();

          if (toolCalls?.length) {
            res.write(`data: ${JSON.stringify({
              id: completionId, object: 'chat.completion.chunk', created, model: modelName,
              choices: [{ index: 0, delta: { role: 'assistant', tool_calls: toolCalls }, finish_reason: null }],
            })}\n\n`);
            res.write(`data: ${JSON.stringify({
              id: completionId, object: 'chat.completion.chunk', created, model: modelName,
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
          }

          const lines = content.split(/(\n+)/);
          for (let i = 0; i < lines.length; i++) {
            if (!lines[i]) continue;
            res.write(`data: ${JSON.stringify({
              id: completionId, object: 'chat.completion.chunk', created, model: modelName,
              choices: [{ index: 0, delta: i === 0 ? { role: 'assistant', content: lines[i] } : { content: lines[i] }, finish_reason: null }],
            })}\n\n`);
          }

          res.write(`data: ${JSON.stringify({
            id: completionId, object: 'chat.completion.chunk', created, model: modelName,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }

        // Não-streaming
        res.json({
          id: completionId, object: 'chat.completion', created, model: modelName,
          choices: [{
            index: 0,
            message: { role: 'assistant', content, tool_calls: toolCalls },
            finish_reason: toolCalls?.length ? 'tool_calls' : 'stop',
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });

      } catch (error: any) {
        console.error('❌', error.message);
        res.status(500).json({ error: { message: error.message, type: 'api_error' } });
      }
    });


    // Embeddings
    this.app.post('/v1/embeddings', async (req: Request, res: Response) => {
      try {
        const { model, input } = req.body;
        const inputs = Array.isArray(input) ? input : [input];
        res.json({
          object: 'list',
          data: inputs.map((_, i) => ({ object: 'embedding', embedding: new Array(1536).fill(0), index: i })),
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
            name: m.id, model: m.id, modified_at: new Date().toISOString(), size: 0, digest: m.id,
            details: { format: 'gguf', family: 'llama', parameter_size: m.id.includes('70b') ? '70B' : m.id.includes('35B') ? '35B' : 'unknown' },
          })),
        });
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.post('/api/show', async (req: Request, res: Response) => {
      try {
        const { name } = req.body;
        const models = await this.client.getAvailableModels();
        const model = models.find(m => m.id === name);
        if (!model) return res.status(404).json({ error: 'Model not found' });
        res.json({ license: 'LNCC License', modelfile: `# ${model.name}`, parameters: '', template: '', details: { format: 'gguf', family: 'llama' }, model_info: model });
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.post('/api/generate', async (req: Request, res: Response) => {
      try {
        const { model, prompt, system, stream } = req.body;
        if (!prompt) return res.status(400).json({ error: 'Prompt is required' });
        const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
        const response = await this.client.chatCompletion(fullPrompt, model);
        res.json({ model: model || 'Qwen3.6-35B', created_at: new Date().toISOString(), response: response.choices[0].message.content, done: true });
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.post('/api/chat', async (req: Request, res: Response) => {
      try {
        const { model, messages } = req.body;
        const msgs: ChatMessage[] = messages || [];
        if (!msgs.length) return res.status(400).json({ error: 'Messages are required' });
        const lastUserMsg = msgs.filter(m => m.role === 'user').pop();
        if (!lastUserMsg) return res.status(400).json({ error: 'No user message found' });
        const response = await this.client.chatCompletion(lastUserMsg.content, model);
        res.json({
          model: model || 'Qwen3.6-35B', created_at: new Date().toISOString(),
          message: { role: 'assistant', content: response.choices[0].message.content },
          done: true, total_duration: 0, load_duration: 0,
        });
      } catch (error: any) { res.status(500).json({ error: error.message }); }
    });

    this.app.post('/api/embed', async (req: Request, res: Response) => {
      const { input } = req.body;
      if (!input) return res.status(400).json({ error: 'Input is required' });
      res.json({ model: 'Qwen3.6-35B', embeddings: [[0]], total_duration: 0, load_duration: 0, prompt_eval_count: 0 });
    });

    this.app.get('/mcp/list', async (_req: Request, res: Response) => {
      try {
        const carcaraTools = await this.client.listSdumontTools();
        const carcaraToolList = carcaraTools?.result?.tools || [];
        const customTools = customMCPTools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
        res.json({ tools: [...customTools, ...carcaraToolList] });
      } catch {
        res.json({ tools: customMCPTools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      }
    });

    this.app.post('/mcp/call', async (req: Request, res: Response) => {
      try {
        const { name, arguments: args } = req.body;
        const customTool = customMCPTools.find(t => t.name === name);
        if (customTool) return res.json({ result: await customTool.handler(args || {}) });
        res.json({ result: await this.client.callMcpTool('lncc-sdumont', 'tools/call', { name, arguments: args }) });
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

    this.app.get('/api/debug/conversations', async (_req: Request, res: Response) => {
      try {
        const conversations = await this.client.getConversations();
        const convArray = Array.isArray(conversations) ? conversations : [];
        const debug = [];
        for (const conv of convArray) {
          const messages = await this.client.getConversationMessages(conv.id);
          debug.push({
            id: conv.id, name: conv.name, model: conv.model,
            totalMessages: messages.length,
            messages: messages.map(m => ({ role: m.role, content: m.content?.substring(0, 200) || '' })),
          });
        }
        res.json({ total: debug.length, conversations: debug });
      } catch { res.json({ total: 0, conversations: [] }); }
    });

    // ==========================================
    // INICIALIZAR
    // ==========================================
    console.log('🚀 Inicializando Carcara Client...');
    try { await this.client.init(); console.log('✅ Cliente pronto!'); }
    catch (error: any) { console.error('❌ Erro:', error.message); }

    return new Promise<void>((resolve) => {
      this.app.listen(this.port, () => {
        console.log(`\n🦙 Carcara AI Gateway`);
        console.log(`🌐 http://localhost:${this.port}`);
        console.log('═══════════════════════════════════════');
        console.log('📋 OpenAI Compatible:');
        console.log(`   GET  /v1/models              → Listar modelos`);
        console.log(`   POST /v1/chat/completions    → Chat (stream/não-stream)`);
        console.log(`   POST /v1/embeddings          → Embeddings`);
        console.log('');
        console.log('📋 Ollama Compatible:');
        console.log(`   GET  /api/health             → Health check`);
        console.log(`   GET  /api/tags               → Listar modelos`);
        console.log(`   POST /api/show               → Info do modelo`);
        console.log(`   POST /api/generate           → Gerar texto`);
        console.log(`   POST /api/chat               → Chat`);
        console.log(`   POST /api/embed              → Embeddings`);
        console.log('');
        console.log('📋 MCP Tools:');
        console.log(`   GET  /mcp/list               → Listar ferramentas`);
        console.log(`   POST /mcp/call               → Chamar ferramenta`);
        console.log('');
        console.log('📋 Search:');
        console.log(`   POST /api/search             → Busca multi-provider`);
        console.log(`   POST /api/search/ddg         → DuckDuckGo`);
        console.log(`   POST /api/search/wiki        → Wikipedia`);
        console.log('');
        console.log('📋 Debug:');
        console.log(`   GET  /ping                   → Ping`);
        console.log(`   GET  /api/conversations      → Listar conversas`);
        console.log(`   GET  /api/conversations/:id   → Mensagens`);
        console.log(`   GET  /api/debug/conversations → Debug detalhado`);
        console.log(`   GET  /api/tools              → Ferramentas Carcara`);
        console.log(`   POST /api/tools/:server/:mtd → Chamar tool`);
        console.log('═══════════════════════════════════════');
        console.log(`📁 Sessão: .carcara/session.json`);
        console.log('═══════════════════════════════════════\n');
        resolve();
      });
    });
  }

  async stop(): Promise<void> { await this.client.close(); }
}