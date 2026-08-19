import { AgentTask } from '../types.js';
import { SandboxService } from '../sandbox-service.js';
import { SearchService } from '../search-service.js';
import { CarcaraClient } from '../carcara-client.js';
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

/**
 * ReActLoopAgent — Reasoning + Acting Loop
 *
 * Ciclo ReAct:
 *   1. THOUGHT: LLM pensa sobre o que precisa fazer
 *   2. ACTION: LLM escolhe uma ferramenta (search, code, calculate, final_answer)
 *   3. OBSERVATION: Executa a ação e observa o resultado
 *   4. REPEAT: Volta ao passo 1 com o novo contexto
 *
 * Ferramentas disponíveis:
 *   - search: busca na web (DuckDuckGo)
 *   - code: gera e executa código no sandbox Docker
 *   - calculate: calcula expressões matemáticas
 *   - final_answer: encerra o loop com a resposta final
 */
export class ReActLoopAgent {
  private client: CarcaraClient;
  private sandbox: SandboxService;
  private search: SearchService;

  constructor(client: CarcaraClient) {
    this.client = client;
    this.sandbox = new SandboxService();
    this.search = new SearchService();
  }

  async execute(task: AgentTask): Promise<ReActResult> {
    const query = task.input as string;
    const model = task.config?.model as string || this.client.getDefaultModel();
    const maxSteps = task.config?.maxSteps || 10;

    const dockerOk = await this.sandbox.detectDocker();
    if (!dockerOk) {
      logger.warn('Docker indisponivel. ReAct rodara sem sandbox de codigo.');
    }

    const steps: ReActStep[] = [];
    const startTime = Date.now();
    let context = `Pergunta: ${query}\n`;

    for (let stepNum = 1; stepNum <= maxSteps; stepNum++) {
      logger.info({ step: stepNum }, 'ReAct iterando');

      // THOUGHT + ACTION
      const llmResponse = await this.reactStep(context, model);
      const thought = llmResponse.thought;
      const action = llmResponse.action;
      const actionInput = llmResponse.actionInput;

      // OBSERVATION
      let observation = '';
      if (action === 'final_answer') {
        observation = actionInput;
        steps.push({ step: stepNum, thought, action, actionInput, observation, timestamp: Date.now() });
        logger.info({ step: stepNum }, 'ReAct convergiu (final_answer)');
        return {
          query, steps,
          finalAnswer: actionInput,
          converged: true,
          totalSteps: stepNum,
          durationMs: Date.now() - startTime,
        };
      }

      observation = await this.executeAction(action, actionInput, dockerOk);
      steps.push({ step: stepNum, thought, action, actionInput, observation, timestamp: Date.now() });

      // Atualiza contexto para próxima iteração
      context += `\nPasso ${stepNum}:\n`;
      context += `Pensamento: ${thought}\n`;
      context += `Acao: ${action}[${actionInput}]\n`;
      context += `Observacao: ${observation}\n`;

      // Verifica se resolveu
      if (observation.includes('ERRO') && stepNum >= maxSteps - 1) {
        break;
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

  private async reactStep(context: string, model: string): Promise<{ thought: string; action: string; actionInput: string }> {
    const prompt = `Voce e um agente ReAct (Reasoning + Acting). Resolva a pergunta passo a passo.

${context}

Ferramentas disponiveis:
- search[query]: busca na web usando DuckDuckGo
- code[descricao]: gera e executa codigo Python no sandbox Docker (use para calculos complexos, manipulacao de dados, etc)
- calculate[expressao]: calcula uma expressao matematica simples
- final_answer[resposta]: encerra o loop com a resposta final

FORMATO DE SAIDA OBRIGATORIO (exatamente assim):
Pensamento: <seu raciocinio sobre o que fazer agora>
Acao: <search|code|calculate|final_answer>[<input da acao>]

Exemplo:
Pensamento: Preciso saber a populacao do Brasil em 2024.
Acao: search[populacao Brasil 2024]

Exemplo 2:
Pensamento: Preciso calcular a soma dos primeiros 100 numeros naturais.
Acao: code[calcule a soma dos primeiros 100 numeros naturais e imprima o resultado]

Agora resolva:
Pensamento:`;

    const response = await this.client.chatCompletion(prompt, model);
    const text = response.choices[0].message.content;

    // Parse da resposta ReAct
    const thoughtMatch = text.match(/Pensamento:\s*(.+?)(?=\nAcao:|$)/is);
    const actionMatch = text.match(/Acao:\s*(\w+)\[(.*?)\]/is);

    const thought = thoughtMatch ? thoughtMatch[1].trim() : 'Pensando...';
    const action = actionMatch ? actionMatch[1].trim().toLowerCase() : 'final_answer';
    const actionInput = actionMatch ? actionMatch[2].trim() : text;

    return { thought, action, actionInput };
  }

  private async executeAction(action: string, input: string, dockerAvailable: boolean): Promise<string> {
    try {
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

        default:
          return `Acao desconhecida: ${action}. Use search, code, calculate ou final_answer.`;
      }
    } catch (err: any) {
      return `ERRO ao executar ${action}: ${err.message}`;
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

Forneca APENAS o codigo dentro de \\`\\`\\`python ... \\`\\`\\`.`;

    const response = await this.client.chatCompletion(prompt, model);
    const text = response.choices[0].message.content;

    // Extrai codigo
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
    const prompt = `Baseado no seguinte contexto de raciocinio, forneca a resposta final concisa.

${context}

Resposta final:`;

    const response = await this.client.chatCompletion(prompt, model);
    return response.choices[0].message.content.trim();
  }
}
