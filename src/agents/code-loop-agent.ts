import { AgentTask, CodeTaskInput, CodeIteration } from '../types.js';
import { SandboxService } from '../sandbox-service.js';
import { CarcaraClient } from '../carcara-client.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export class CodeLoopAgent {
  private client: CarcaraClient;
  private sandbox: SandboxService;

  constructor(client: CarcaraClient) {
    this.client = client;
    this.sandbox = new SandboxService();
  }

  async execute(task: AgentTask): Promise<CodeIteration> {
    const input = task.input as CodeTaskInput;
    const model = task.config?.model as string || this.client.getDefaultModel();

    const dockerOk = await this.sandbox.detectDocker();
    if (!dockerOk) {
      throw new Error('Docker nao disponivel. CodeLoopAgent requer Docker.');
    }

    // Gera testes automaticos se nao fornecidos
    const enrichedInput = this.enrichWithAutoTests(input);

    let currentCode = await this.generateCode(enrichedInput, model);
    let iteration = 0;
    const maxIterations = task.config?.maxIterations || 5;
    let bestResult: CodeIteration | null = null;
    let bestScore = -1;
    const history: string[] = [];

    while (iteration < maxIterations) {
      iteration++;
      logger.info({ iteration, lang: enrichedInput.language }, 'CodeLoopAgent iterando');

      const testResults = await this.runTests(currentCode, enrichedInput);
      const score = this.evaluate(testResults, enrichedInput.expectedOutput);

      const result: CodeIteration = {
        code: currentCode,
        explanation: `Iteracao ${iteration}`,
        testResults,
        score,
      };

      if (score > bestScore) { bestScore = score; bestResult = result; }

      if (score >= 0.95) {
        logger.info({ iteration, score }, 'CodeLoopAgent convergiu');
        break;
      }

      if (iteration < maxIterations) {
        const errors = testResults
          .filter(t => !t.passed)
          .map(t => `[STDOUT]:\n${t.stdout}\n[STDERR]:\n${t.stderr}\n[EXIT]: ${t.exitCode}`)
          .join('\n---\n');
        history.push(errors);
        currentCode = await this.fixCode(enrichedInput, currentCode, errors, history, model);
      }
    }

    return bestResult!;
  }

  private enrichWithAutoTests(input: CodeTaskInput): CodeTaskInput {
    if (input.testCases && input.testCases.length > 0) return input;

    // Gera testes automaticos baseado na descricao
    const autoTests: string[] = [];
    const desc = input.description.toLowerCase();

    if (desc.includes('soma') || desc.includes('add') || desc.includes('sum')) {
      autoTests.push('assert add(2, 3) == 5');
      autoTests.push('assert add(-1, 1) == 0');
      autoTests.push('assert add(0, 0) == 0');
    } else if (desc.includes('fatorial') || desc.includes('factorial')) {
      autoTests.push('assert factorial(5) == 120');
      autoTests.push('assert factorial(0) == 1');
      autoTests.push('assert factorial(1) == 1');
    } else if (desc.includes('fibonacci')) {
      autoTests.push('assert fibonacci(10) == 55');
      autoTests.push('assert fibonacci(1) == 1');
      autoTests.push('assert fibonacci(0) == 0');
    } else if (desc.includes('reverse') || desc.includes('inverte')) {
      autoTests.push('assert reverse("hello") == "olleh"');
      autoTests.push('assert reverse("") == ""');
    } else if (desc.includes('palindromo') || desc.includes('palindrome')) {
      autoTests.push('assert is_palindrome("ana") == True');
      autoTests.push('assert is_palindrome("hello") == False');
    } else {
      // Teste generico: verifica se o codigo roda sem erro
      autoTests.push('# Teste basico: verifica execucao sem erro\nprint("OK")');
    }

    return { ...input, testCases: autoTests };
  }

  private async generateCode(input: CodeTaskInput, model: string): Promise<string> {
    const prompt = `Gere codigo ${input.language} para: ${input.description}

REGRAS OBRIGATORIAS:
1. NUNCA use input(), raw_input(), sys.stdin, getpass, ou qualquer funcao interativa
2. O codigo deve ser 100% auto-executavel — defina funcoes e chame-as no final com valores de exemplo
3. Use apenas valores hardcoded ou parametros de funcao
4. A saida deve ser via print() com resultado claro

${input.constraints ? `Restricoes: ${input.constraints}` : ''}
${input.testCases ? `Testes que devem passar:\n${input.testCases.join('\n')}` : ''}

Forneca APENAS o codigo, sem explicacoes.`;

    const response = await this.client.chatCompletion(prompt, model);
    return this.extractCode(response.choices[0].message.content, input.language);
  }

  private async fixCode(input: CodeTaskInput, code: string, errors: string, history: string[], model: string): Promise<string> {
    const prompt = `O seguinte codigo tem erros ao executar no sandbox Docker (sem TTY/interatividade). Corrija-o.

LINGUAGEM: ${input.language}
CODIGO:
\`\`\`${input.language}
${code}
\`\`\`

ERROS DOS TESTES:
${errors}

HISTORICO DE ERROS ANTERIORES:
${history.slice(0, -1).join('\n---\n') || 'Nenhum'}

INSTRUCAO ORIGINAL:
${input.description}

REGRAS DE CORRECAO:
1. NUNCA use input(), sys.stdin, ou interatividade
2. Substitua input() por valores hardcoded ou parametros de funcao
3. Se houver funcoes, chame-as no final do arquivo com valores de exemplo
4. A saida deve ser via print()

Forneca APENAS o codigo corrigido, sem explicacoes.`;

    const response = await this.client.chatCompletion(prompt, model);
    return this.extractCode(response.choices[0].message.content, input.language);
  }

  private async runTests(code: string, input: CodeTaskInput) {
    const results = [];
    const testCode = input.testCases?.length
      ? `${code}\n\n# --- TESTES ---\n${input.testCases.join('\n')}`
      : code;

    try {
      const result = await this.sandbox.execute(testCode, input.language);
      results.push({
        passed: result.exitCode === 0,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    } catch (err: any) {
      results.push({ passed: false, stdout: '', stderr: err.message, exitCode: -1 });
    }
    return results;
  }

  private evaluate(testResults: any[], expectedOutput?: string): number {
    let score = 0;
    const allPassed = testResults.every(r => r.passed);
    if (allPassed) score += 0.5;
    if (expectedOutput) {
      const actual = testResults.map(r => r.stdout).join('\n').trim();
      if (actual.includes(expectedOutput.trim()) || expectedOutput.trim().includes(actual)) score += 0.5;
    } else if (allPassed) score += 0.5;
    return score;
  }

  private extractCode(text: string, language: string): string {
    const patterns = [
      new RegExp(`\`\`\`(?:${language}|)\n([\s\S]*?)\n\`\`\``),
      /\`\`\`\n([\s\S]*?)\n\`\`\`/,
      /\`\`\`([\s\S]*?)\`\`\`/,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m[1].trim();
    }
    return text.trim();
  }
}
