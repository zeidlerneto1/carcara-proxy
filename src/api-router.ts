// src/api-router.ts - COMPLETO COM MCP E SEARCH
import express, { Request, Response } from 'express';
import cors from 'cors';
import { CarcaraClient } from './carcara-client';
import { customMCPTools } from './mcp-tools';
import { SearchService } from './search-service';

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

  async start(): Promise<void> {
    // ==========================================
    // MIDDLEWARE
    // ==========================================
    this.app.use(cors());
    this.app.use(express.json());

    this.app.use((req: Request, _res: Response, next) => {
      console.log(`📡 ${req.method} ${req.url}`);
      next();
    });

    // ==========================================
    // ROTAS PADRÃO OLLAMA
    // ==========================================

    this.app.get('/api/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', initialized: this.client.isReady });
    });

    this.app.get('/api/tags', async (_req: Request, res: Response) => {
      try {
        const models = await this.client.getAvailableModels();
        const ollamaModels = models.map(m => ({
          name: m.id,
          model: m.id,
          modified_at: new Date().toISOString(),
          size: 0,
          digest: m.id,
          details: {
            format: 'gguf',
            family: 'llama',
            parameter_size: m.id.includes('70b') ? '70B' : 'unknown',
          },
        }));
        res.json({ models: ollamaModels });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/show', async (req: Request, res: Response) => {
      try {
        const { name } = req.body;
        const models = await this.client.getAvailableModels();
        const model = models.find(m => m.id === name);
        
        if (!model) {
          return res.status(404).json({ error: 'Model not found' });
        }

        res.json({
          license: 'LNCC License',
          modelfile: `# ${model.name}\n# ${model.description || ''}`,
          parameters: '',
          template: '',
          details: { format: 'gguf', family: 'llama' },
          model_info: model,
        });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/generate', async (req: Request, res: Response) => {
      try {
        const { model, prompt, system, template, context, options, stream } = req.body;

        if (!prompt) {
          return res.status(400).json({ error: 'Prompt is required' });
        }

        const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
        let finalPrompt = fullPrompt;
        if (template) {
          finalPrompt = template
            .replace('{{ .Prompt }}', prompt)
            .replace('{{ .System }}', system || '');
        }

        const response = await this.client.chatCompletion(finalPrompt, model, options?.tools);

        const result = {
          model: model || 'default',
          created_at: new Date().toISOString(),
          response: response.choices[0].message.content,
          message: response.choices[0].message,
          done: true,
          total_duration: 0,
          load_duration: 0,
          prompt_eval_count: (response as any).usage?.prompt_tokens || 0,
          prompt_eval_duration: 0,
          eval_count: (response as any).usage?.completion_tokens || 0,
          eval_duration: 0,
          context: context || [],
        };

        if (stream) {
          res.setHeader('Content-Type', 'application/x-ndjson');
          const lines = result.response.split('\n');
          for (const line of lines) {
            res.write(JSON.stringify({ ...result, response: line, done: false }) + '\n');
          }
          res.write(JSON.stringify({ ...result, done: true }) + '\n');
          res.end();
        } else {
          res.json(result);
        }
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/chat', async (req: Request, res: Response) => {
      try {
        const { model, messages, stream, options } = req.body;

        if (!messages || messages.length === 0) {
          return res.status(400).json({ error: 'Messages are required' });
        }

        const lastUserMessage = messages.filter((m: any) => m.role === 'user').pop();

        if (!lastUserMessage) {
          return res.status(400).json({ error: 'No user message found' });
        }

        const response = await this.client.chatCompletion(lastUserMessage.content, model, options?.tools);

        const ollamaResponse = {
          model: model || 'default',
          created_at: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: response.choices[0].message.content,
            tool_calls: response.choices[0].message.tool_calls,
          },
          done: true,
          total_duration: 0,
          load_duration: 0,
          prompt_eval_count: (response as any).usage?.prompt_tokens || 0,
          prompt_eval_duration: 0,
          eval_count: (response as any).usage?.completion_tokens || 0,
          eval_duration: 0,
        };

        res.json(ollamaResponse);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/embed', async (req: Request, res: Response) => {
      try {
        const { model, input } = req.body;

        if (!input) {
          return res.status(400).json({ error: 'Input is required' });
        }

        await this.client.chatCompletion(`Generate embedding for: ${input}`, model);

        res.json({
          model: model || 'default',
          embeddings: [[0]],
          total_duration: 0,
          load_duration: 0,
          prompt_eval_count: 0,
        });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // ==========================================
    // MCP TOOLS (CUSTOM + CARCARA)
    // ==========================================

    // Listar todas as MCP tools
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
      } catch (error: any) {
        res.json({
          tools: customMCPTools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      }
    });

    // Chamar MCP tool
    this.app.post('/mcp/call', async (req: Request, res: Response) => {
      try {
        const { name, arguments: args } = req.body;
        
        // Procurar nas tools customizadas primeiro
        const customTool = customMCPTools.find(t => t.name === name);
        
        if (customTool) {
          const result = await customTool.handler(args || {});
          return res.json({ result });
        }
        
        // Tenta no Carcara
        const result = await this.client.callMcpTool('lncc-sdumont', 'tools/call', { name, arguments: args });
        res.json({ result });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // ==========================================
    // SEARCH ENDPOINTS
    // ==========================================

    // Search unificado
    this.app.post('/api/search', async (req: Request, res: Response) => {
      try {
        const { query, providers } = req.body;
        
        if (!query) {
          return res.status(400).json({ error: 'Query is required' });
        }
        
        const results = await this.searchService.search(query, providers);
        res.json(results);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // DuckDuckGo search
    this.app.post('/api/search/ddg', async (req: Request, res: Response) => {
      try {
        const { query } = req.body;
        
        if (!query) {
          return res.status(400).json({ error: 'Query is required' });
        }
        
        const results = await this.searchService.duckDuckGo(query);
        res.json(results);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // Wikipedia search
    this.app.post('/api/search/wiki', async (req: Request, res: Response) => {
      try {
        const { query } = req.body;
        
        if (!query) {
          return res.status(400).json({ error: 'Query is required' });
        }
        
        const results = await this.searchService.wikipedia(query);
        res.json(results);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // ==========================================
    // ROTAS ADICIONAIS
    // ==========================================

    this.app.get('/ping', (_req: Request, res: Response) => {
      res.json({ pong: true });
    });

    this.app.get('/api/conversations', async (_req: Request, res: Response) => {
      try {
        const conversations = await this.client.getConversations();
        res.json({ conversations: Array.isArray(conversations) ? conversations : [] });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/conversations/:id/messages', async (req: Request, res: Response) => {
      try {
        const messages = await this.client.getConversationMessages(req.params.id);
        res.json({ messages: Array.isArray(messages) ? messages : [] });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/tools', async (_req: Request, res: Response) => {
      try {
        const tools = await this.client.listSdumontTools();
        res.json({ tools: tools?.result?.tools || [] });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/tools/:server/:method', async (req: Request, res: Response) => {
      try {
        const result = await this.client.callMcpTool(req.params.server, req.params.method, req.body || {});
        res.json({ result });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // Debug conversations
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
            model: conv.model,
            date: new Date(conv.lasModified).toISOString(),
            totalMessages: msgArray.length,
            messages: msgArray.map(m => ({
              role: m.role,
              content: m.content?.substring(0, 200) || '',
              timestamp: new Date(m.timestamp).toISOString(),
            })),
          });
        }
        
        res.json({ total: debug.length, conversations: debug });
      } catch (error: any) {
        res.json({ total: 0, conversations: [] });
      }
    });

    // ==========================================
    // INICIALIZAR CLIENTE
    // ==========================================
    console.log('🚀 Inicializando Carcara Client...');
    try {
      await this.client.init();
      console.log('✅ Cliente pronto!');
    } catch (error: any) {
      console.error('❌ Erro ao inicializar:', error.message);
    }

    // ==========================================
    // INICIAR SERVIDOR
    // ==========================================
    return new Promise<void>((resolve) => {
      this.app.listen(this.port, () => {
        console.log(`\n🦙 Carcara API (Ollama Compatível)`);
        console.log(`🌐 http://localhost:${this.port}`);
        console.log('═══════════════════════════════════════');
        console.log('📋 Ollama:');
        console.log('   GET  /api/health');
        console.log('   GET  /api/tags');
        console.log('   POST /api/show');
        console.log('   POST /api/generate');
        console.log('   POST /api/chat');
        console.log('   POST /api/embed');
        console.log('\n📋 MCP Tools:');
        console.log('   GET  /mcp/list');
        console.log('   POST /mcp/call');
        console.log('\n📋 Search:');
        console.log('   POST /api/search');
        console.log('   POST /api/search/ddg');
        console.log('   POST /api/search/wiki');
        console.log('\n📋 Debug:');
        console.log('   GET  /api/debug/conversations');
        console.log('═══════════════════════════════════════\n');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await this.client.close();
  }
}