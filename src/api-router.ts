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

    // ⭐ /v1/chat/completions - CORRIGIDO (proteção contra selected vazio)
    this.app.post('/v1/chat/completions', async (req: Request, res: Response) => {
      try {
        const { model, messages, stream, tools } = req.body;
        const msgs: ChatMessage[] = messages || [];

        if (!msgs.length) {
          return res.status(400).json({ error: 'Messages are required' });
        }

        // CORREÇÃO 1: ID gerado via timestamp pode colidir ou falhar em parsers rigorosos. Adicionado sufixo aleatório.
        const completionId = `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        const created = Math.floor(Date.now() / 1000);
        const modelName = model || 'Qwen3.6-35B';

        const promptParts: string[] = [];
        let totalChars = 0;
        const MAX_PROMPT = 8000;

        const reversed = [...msgs].reverse();
        const selected: ChatMessage[] = [];

        for (const m of reversed) {
          const text = this.extractText(m.content);
          const msgSize = text.length + 50;

          if (m.role === 'system' || m.role === 'tool') {
            if (totalChars + msgSize > MAX_PROMPT && selected.length > 0) break;
            selected.unshift(m);
            totalChars += msgSize;
            continue;
          }

          const limitedText = text.substring(0, 2000);
          if (totalChars + limitedText.length > MAX_PROMPT && selected.length > 0) break;
          
          selected.unshift({ ...m, content: limitedText });
          totalChars += limitedText.length;
        }

        if (selected.length === 0 && msgs.length > 0) {
          const last = msgs[msgs.length - 1];
          selected.push(last);
        }

        // Constrói prompt usando delimitadores ChatML explícitos para o Qwen não alucinar nos turnos
        for (const m of selected) {
          const text = this.extractText(m.content);
          if (!text && !m.tool_calls) continue;

          switch (m.role) {
            case 'system':
              promptParts.push(`<|im_start|>system\n${text}<|im_end|>\n`);
              break;
            case 'user':
              promptParts.push(`<|im_start|>user\n${text}<|im_end|>\n`);
              break;
            case 'assistant':
              promptParts.push(`<|im_start|>assistant\n${text}`);
              if (m.tool_calls?.length) {
                promptParts.push(`\n[CALL_TOOLS]: ${JSON.stringify(m.tool_calls)}`);
              }
              promptParts.push(`<|im_end|>\n`);
              break;
            case 'tool':
              promptParts.push(`<|im_start|>tool\n${text}<|im_end|>\n`);
              break;
          }
        }

        // Abre o turno do assistente para forçar o modelo a responder e não repetir prompts antigos
        promptParts.push(`<|im_start|>assistant\n`);
        const prompt = promptParts.join('\n');

        const lastMsg = selected[selected.length - 1];
        const lastText = lastMsg ? this.extractText(lastMsg.content) : '...';
        console.log(`💬 Prompt: ${prompt.length} chars | ${lastText.substring(0, 80)}`);

        const response = await this.client.chatCompletion(prompt, model, tools);
        const content = response?.choices?.[0]?.message?.content || '';
        const toolCalls: ToolCall[] | undefined = response?.choices?.[0]?.message?.tool_calls;

        console.log(`🤖 Response: ${content.length} chars | ${content.substring(0, 80)}`);

        // STREAMING SSE CORRIGIDO E PROTEGIDO CONTRA QUEBRA DE STRINGS
        if (stream) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders();

          // Se o cluster respondeu uma chamada de ferramenta nativa, despacha ela inteira e intacta de uma vez só
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

          // CORREÇÃO 2: Se o conteúdo for código ou contiver marcadores estruturados, dividimos por quebra de linha (\n)
          // Fatiar por espaços corta caracteres de escape (\") no meio, corrompendo o JSON e dando "Unterminated String"
          if (content) {
            const lines = content.split(/(\n+)/);
            for (let i = 0; i < lines.length; i++) {
              if (!lines[i]) continue;
              res.write(`data: ${JSON.stringify({
                id: completionId, object: 'chat.completion.chunk', created, model: modelName,
                choices: [{ index: 0, delta: i === 0 ? { role: 'assistant', content: lines[i] } : { content: lines[i] }, finish_reason: null }],
              })}\n\n`);
              // Pequena pausa apenas para manter a cadência fluida exigida por clientes SSE
              await new Promise(resolve => setTimeout(resolve, 2));
            }
          }

          // Chunk finalizador obrigatório do protocolo OpenAI
          res.write(`data: ${JSON.stringify({
            id: completionId, object: 'chat.completion.chunk', created, model: modelName,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }

        // Resposta síncrona estável (Fallback)
        return res.json({
          id: completionId, object: 'chat.completion', created, model: modelName,
          choices: [{
            index: 0,
            message: { role: 'assistant', content, tool_calls: toolCalls },
            finish_reason: toolCalls?.length ? 'tool_calls' : 'stop',
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });

      } catch (error: any) {
        console.error('❌ Erro no endpoint completions:', error.message);
        if (!res.headersSent) {
          res.status(500).json({ error: { message: error.message, type: 'api_error' } });
        }
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
        console.log(`\n🦙 Carcara AI Gateway\n🌐 http://localhost:${this.port}\n`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> { await this.client.close(); }
}