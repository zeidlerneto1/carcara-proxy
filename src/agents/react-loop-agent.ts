import { AgentTask } from '../types.js';
import { SandboxService } from '../sandbox-service.js';
import { SearchService } from '../search-service.js';
import { CarcaraClient } from '../carcara-client.js';
import { customMCPTools } from '../mcp-tools.js';
import { LoopEngineering } from '../loop-engineering.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export interface ReActStep {
  step: number;
  thought: string;
  action: string;
  actionInput: string;
  observation: string;
  timestamp: number;
}

export interface ReActResult {
  query: string;
  steps: ReActStep[];
  finalAnswer: string;
  converged: boolean;
  totalSteps: number;
  durationMs: number;
}

export interface ReActTool {
  name: string;
  description: string;
  handler: (input: string) => Promise<string>;
}

/**
 * ReActLoopAgent — Reasoning + Acting Loop
 *
 * Ciclo ReAct:
 * 1. THOUGHT: LLM pensa sobre o que precisa fazer
 * 2. ACTION: LLM escolhe uma ferramenta
 * 3. OBSERVATION: Executa a ação e observa o resultado
 * 4. REPEAT: Volta ao passo 1 com o novo contexto
 *
 * Ferramentas disponíveis:
 * - search: busca na web (DuckDuckGo)
 * - code: gera e executa código no sandbox Docker
 * - calculate: calcula expressões matemáticas
 * - get_time: retorna data/hora atual
 * - get_weather: retorna clima de uma localização
 * - mcp_call: chama ferramenta MCP do LNCC-SDumont
 * - final_answer: encerra o loop com a resposta final
 */
export class ReActLoopAgent {
  private client: CarcaraClient;
  private sandbox: SandboxService;
  private search: SearchService;
  private customTools: Map<string, ReActTool> = new Map();
  private loopEngine: LoopEngineering<any>;
  private dockerAvailable: boolean;

  constructor(client: CarcaraClient, dockerAvailable: boolean = false) {
    this.client = client;
    this.sandbox = new SandboxService();
    this.search = new SearchService();
    this.loopEngine = new LoopEngineering({ maxIterations: 15, convergenceThreshold: 0.9 });
    this.dockerAvailable = dockerAvailable;
    this.registerDefaultTools();
  }

  /** Registra ferramentas customizadas dinamicamente */
  registerTool(name: string, description: string, handler: (input: string) => Promise<string>): void {
    this.customTools.set(name, { name, description, handler });
    logger.info({ tool: name }, 'Ferramenta ReAct registrada');
  }

  /** Remove ferramenta customizada */
  unregisterTool(name: string): void {
    this.customTools.delete(name);
  }

  /** Lista ferramentas disponíveis */
  listTools(): string[] {
    return ['search', 'code', 'calculate', 'get_time', 'get_weather', 'mcp_call', 'final_answer', ...this.customTools.keys()];
  }

  async execute(task: AgentTask): Promise<ReActResult> {
    const query = typeof task.input === 'string' ? task.input : JSON.stringify(task.input);
    const model = (task.config?.model as string) || this.client.getDefaultModel();
    const maxSteps = (task.config?.maxSteps as number) || 15;
    const conversationHistory = (task.config?.history as string) || '';

    const dockerOk = this.dockerAvailable;
    if (!dockerOk) {
      logger.warn('Docker indisponivel. ReAct rodara em modo local (HOST).');
    } else {
      logger.info('Docker disponivel. ReAct usara sandbox isolado.');
    }

    const steps: ReActStep[] = [];
    const startTime = Date.now();
    let context = conversationHistory
      ? `${conversationHistory}\n\nPergunta atual: ${query}\n`
      : `Pergunta: ${query}\n`;

    for (let stepNum = 1; stepNum <= maxSteps; stepNum++) {
      logger.info({ step: stepNum, maxSteps }, 'ReAct iterando');

      // THOUGHT + ACTION
      const llmResponse = await this.reactStep(context, model, stepNum);
      const thought = llmResponse.thought;
      const action = llmResponse.action;
      const actionInput = llmResponse.actionInput;

      // Se é final_answer, encerra
      if (action === 'final_answer') {
        steps.push({ step: stepNum, thought, action, actionInput, observation: actionInput, timestamp: Date.now() });
        logger.info({ step: stepNum }, 'ReAct convergiu (final_answer)');
        return {
          query, steps,
          finalAnswer: actionInput,
          converged: true,
          totalSteps: stepNum,
          durationMs: Date.now() - startTime,
        };
      }

      // OBSERVATION
      let observation = '';
      try {
        observation = await this.executeAction(action, actionInput, dockerOk);
      } catch (err: any) {
        observation = `ERRO ao executar ${action}: ${err.message}`;
        logger.error({ step: stepNum, action, error: err.message }, 'Erro na execucao da ferramenta');
      }

      steps.push({ step: stepNum, thought, action, actionInput, observation, timestamp: Date.now() });

      // Atualiza contexto para próxima iteração
      context += `\nPasso ${stepNum}:\n`;
      context += `Pensamento: ${thought}\n`;
      context += `Acao: ${action}[${actionInput}]\n`;
      context += `Observacao: ${observation}\n`;

      // Trunca contexto se ficar muito grande (>8000 chars)
      if (context.length > 8000) {
        const summary = await this.summarizeContext(context, model);
        context = `Resumo dos passos anteriores: ${summary}\n\nPergunta: ${query}\n`;
        logger.info({ step: stepNum }, 'Contexto truncado e resumido');
      }
    }

    // Se não convergiu, gera resposta final com o que tem
    const finalAnswer = await this.generateFinalAnswer(context, model);
    return {
      query, steps,
      finalAnswer,
      converged: false,
      totalSteps: steps.length,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Executa o loop ReAct com streaming de eventos
   * Útil para UI em tempo real
   */
  async executeStreaming(
    task: AgentTask,
    onStep: (step: ReActStep) => void,
    onComplete: (result: ReActResult) => void
  ): Promise<void> {
    const result = await this.execute(task);
    result.steps.forEach(onStep);
    onComplete(result);
  }

  private async reactStep(context: string, model: string, stepNum: number): Promise<{ thought: string; action: string; actionInput: string }> {
    const toolsDesc = this.buildToolsDescription();

    const prompt = `Voce e um agente ReAct (Reasoning + Acting). Resolva a pergunta passo a passo.

${context}

FERRAMENTAS DISPONIVEIS:
${toolsDesc}

FORMATO DE SAIDA OBRIGATORIO (exatamente assim):
Pensamento: <seu raciocinio aqui>
Acao: <nome_da_ferramenta>[<input>]

REGRAS:
1. Use EXATAMENTE o formato acima
2. A acao deve ser uma das ferramentas listadas
3. Para final_answer, use: Acao: final_answer[<resposta completa>]
4. Seja conciso no pensamento
5. NAO inclua markdown, listas, ou formatacao extra

Exemplos validos:
Pensamento: Preciso saber a populacao do Brasil em 2024.
Acao: search[populacao Brasil 2024]

Pensamento: Agora tenho os dados, posso responder.
Acao: final_answer[A populacao do Brasil em 2024 e de aproximadamente 216 milhoes de habitantes.]

Agora resolva (Passo ${stepNum}):
Pensamento:`;

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        const response = await this.client.chatCompletion(prompt, model);
        const text = response.choices[0].message.content;
        const parsed = this.parseReactResponse(text);

        if (parsed.action && this.isValidAction(parsed.action)) {
          return parsed;
        }

        // Se parser falhou, tenta corrigir
        logger.warn({ attempt: attempts, text: text.slice(0, 200) }, 'Parser ReAct falhou, tentando novamente');
      } catch (err: any) {
        logger.error({ attempt: attempts, error: err.message }, 'Erro no reactStep');
      }
    }

    // Fallback: responde diretamente
    logger.warn('Max attempts reached, falling back to final_answer');
    try {
      const fallbackPrompt = `${context}\n\nResponda diretamente:`;
      const response = await this.client.chatCompletion(fallbackPrompt, model);
      return {
        thought: 'Fallback direto apos falha no parser.',
        action: 'final_answer',
        actionInput: response.choices[0].message.content.trim(),
      };
    } catch {
      return {
        thought: 'Erro critico no agente.',
        action: 'final_answer',
        actionInput: 'Desculpe, nao consegui processar sua solicitacao. Tente reformular.',
      };
    }
  }

  private parseReactResponse(text: string): { thought: string; action: string; actionInput: string } {
    // Tenta múltiplos padrões de parse
    const patterns = [
      // Padrão principal
      /Pensamento:\s*(.+?)(?=\nAcao:|$)/is,
      // Variantes com acento
      /Pensamento:\s*(.+?)(?=\nA[cç][aã]o:|$)/is,
      /Pensamento:\s*(.+?)(?=\nAction:|$)/is,
    ];

    let thought = '';
    for (const p of patterns) {
      const m = text.match(p);
      if (m) {
        thought = m[1].trim();
        break;
      }
    }

    // Parse da ação
    const actionPatterns = [
      /Acao:\s*(\w+)\[(.*?)\]/is,
      /A[cç][aã]o:\s*(\w+)\[(.*?)\]/is,
      /Action:\s*(\w+)\[(.*?)\]/is,
      /Acao:\s*(\w+)\s*\[(.*?)\]/is,
    ];

    let action = '';
    let actionInput = '';
    for (const p of actionPatterns) {
      const m = text.match(p);
      if (m) {
        action = m[1].trim().toLowerCase();
        actionInput = m[2].trim();
        break;
      }
    }

    // Se não achou ação com [], tenta sem []
    if (!action) {
      const simpleMatch = text.match(/(?:Acao|Action):\s*(\w+)(?:\s*[:\-]?\s*(.+))?/i);
      if (simpleMatch) {
        action = simpleMatch[1].trim().toLowerCase();
        actionInput = simpleMatch[2]?.trim() || '';
      }
    }

    return { thought: thought || 'Pensando...', action, actionInput };
  }

  private isValidAction(action: string): boolean {
    const valid = ['search', 'code', 'calculate', 'get_time', 'get_weather', 'mcp_call', 'final_answer'];
    return valid.includes(action) || this.customTools.has(action);
  }

  private async executeAction(action: string, input: string, dockerAvailable: boolean): Promise<string> {
    // Ferramentas customizadas primeiro
    if (this.customTools.has(action)) {
      return await this.customTools.get(action)!.handler(input);
    }

    switch (action) {
      case 'search': {
        const result = await this.search.duckDuckGo(input);
        if (!result.results?.length) return 'Nenhum resultado encontrado.';
        return result.results.slice(0, 3).map((r: any, i: number) => `${i + 1}. ${r.title}: ${r.snippet}`).join('\n');
      }

      case 'code': {
        if (!dockerAvailable) return 'ERRO: Docker nao disponivel para execucao de codigo.';
        const code = await this.generateCodeForAction(input);
        const result = await this.sandbox.execute(code, 'python');
        if (result.exitCode !== 0) {
          return `ERRO (exit ${result.exitCode}):\n${result.stderr}`;
        }
        return result.stdout || 'Codigo executado com sucesso (sem saida).';
      }

      case 'calculate': {
        try {
          const result = Function(`'use strict'; return (${input})`)();
          return String(result);
        } catch (e: any) {
          return `ERRO no calculo: ${e.message}`;
        }
      }

      case 'get_time': {
        const tz = input.trim() || 'UTC';
        try {
          const now = new Date();
          return now.toLocaleString('pt-BR', { timeZone: tz });
        } catch {
          return now.toISOString();
        }
      }

      case 'get_weather': {
        const location = input.trim() || 'Sao Paulo';
        try {
          const response = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1`);
          const data = await response.json();
          const current = data.current_condition[0];
          return `${location}: ${current.temp_C}°C, ${current.weatherDesc[0].value}, umidade ${current.humidity}%`;
        } catch (e: any) {
          return `ERRO ao buscar clima: ${e.message}`;
        }
      }

      case 'mcp_call': {
        try {
          // Parse input: "server.method" ou JSON
          let serverId: string, method: string, params: any = {};
          if (input.includes('.')) {
            [serverId, method] = input.split('.', 2);
          } else {
            try {
              const parsed = JSON.parse(input);
              serverId = parsed.server;
              method = parsed.method;
              params = parsed.params || {};
            } catch {
              return 'ERRO: formato mcp_call invalido. Use "server.method" ou JSON {server, method, params}';
            }
          }
          const result = await this.client.callMcpTool(serverId, method, params);
          return JSON.stringify(result, null, 2).slice(0, 2000);
        } catch (e: any) {
          return `ERRO MCP: ${e.message}`;
        }
      }

      default:
        return `Acao desconhecida: ${action}. Ferramentas disponiveis: ${this.listTools().join(', ')}`;
    }
  }

  private async generateCodeForAction(description: string): Promise<string> {
    const model = this.client.getDefaultModel();
    const prompt = `Gere codigo Python auto-executavel para: ${description}

REGRAS:
1. NUNCA use input(), sys.stdin, ou interatividade
2. Use apenas valores hardcoded
3. A saida deve ser via print()
4. NAO inclua a palavra "python" como primeira linha
5. Seja conciso

Forneca APENAS o codigo dentro de \`\`\`python ... \`\`\`.`;

    const response = await this.client.chatCompletion(prompt, model);
    const text = response.choices[0].message.content;

    const m = text.match(/\`\`\`python\n([\s\S]*?)\n\`\`\`/);
    if (m) {
      let code = m[1].trim();
      const firstLine = code.split('\n')[0].trim().toLowerCase();
      if (firstLine === 'python' || firstLine === 'py') {
        code = code.split('\n').slice(1).join('\n').trim();
      }
      return code;
    }
    return text.trim();
  }

  private async generateFinalAnswer(context: string, model: string): Promise<string> {
    const prompt = `Baseado no seguinte contexto de raciocinio, forneca a resposta final concisa e completa.

${context}

Resposta final (em portugues):`;

    const response = await this.client.chatCompletion(prompt, model);
    return response.choices[0].message.content.trim();
  }

  private async summarizeContext(context: string, model: string): Promise<string> {
    const prompt = `Resuma o seguinte contexto de raciocinio em 2-3 frases, mantendo os fatos importantes:

${context.slice(0, 4000)}

Resumo:`;

    try {
      const response = await this.client.chatCompletion(prompt, model);
      return response.choices[0].message.content.trim();
    } catch {
      return context.slice(-1000);
    }
  }

  private buildToolsDescription(): string {
    const defaultTools = [
      { name: 'search', desc: 'busca na web usando DuckDuckGo' },
      { name: 'code', desc: 'gera e executa codigo Python no sandbox Docker' },
      { name: 'calculate', desc: 'calcula uma expressao matematica simples' },
      { name: 'get_time', desc: 'retorna data e hora atual (opcional: timezone)' },
      { name: 'get_weather', desc: 'retorna clima de uma localizacao' },
      { name: 'mcp_call', desc: 'chama ferramenta MCP do LNCC-SDumont (formato: server.method ou JSON)' },
      { name: 'final_answer', desc: 'encerra o loop com a resposta final' },
    ];

    const custom = Array.from(this.customTools.values()).map(t => ({ name: t.name, desc: t.description }));
    return [...defaultTools, ...custom].map(t => `- ${t.name}: ${t.desc}`).join('\n');
  }

  private registerDefaultTools(): void {
    // MCP tools como ferramentas ReAct
    for (const tool of customMCPTools) {
      this.registerTool(
        `mcp_${tool.name}`,
        `MCP: ${tool.description}`,
        async (input: string) => {
          try {
            const params = JSON.parse(input);
            const result = await tool.handler(params);
            return JSON.stringify(result, null, 2).slice(0, 2000);
          } catch (e: any) {
            return `ERRO: ${e.message}`;
          }
        }
      );
    }
  }
}
