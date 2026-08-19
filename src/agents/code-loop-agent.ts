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

    // Verifica Docker antes de comecar
    const dockerOk = await this.sandbox.detectDocker();
    if (!dockerOk) {
      throw new Error('Docker nao disponivel. CodeLoopAgent requer Docker.');
    }

    let currentCode = await this.generateCode(input, model);
    let iteration = 0;
    const maxIterations = task.config?.maxIterations || 5;
    let bestResult: CodeIteration | null = null;
    let bestScore = -1;

    while (iteration < maxIterations) {
      iteration++;
      logger.info({ iteration, lang: input.language }, 'CodeLoopAgent iterando');

      const testResults = await this.runTests(currentCode, input);
      const score = this.evaluate(testResults, input.expectedOutput);

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
          .map(t => `STDOUT: ${t.stdout}\nSTDERR: ${t.stderr}\nEXIT: ${t.exitCode}`)
          .join('\n---\n');
        currentCode = await this.fixCode(input, currentCode, errors, model);
      }
    }

    return bestResult!;
  }

  private async generateCode(input: CodeTaskInput, model: string): Promise<string> {
    const prompt = this.buildGenerationPrompt(input);
    const response = await this.client.chatCompletion(prompt, model);
    return this.extractCode(response.choices[0].message.content, input.language);
  }

  private async fixCode(input: CodeTaskInput, code: string, errors: string, model: string): Promise<string> {
    const prompt = `O seguinte codigo tem erros. Corrija-o.\n\nLINGUAGEM: ${input.language}\nCODIGO:\n\`\`\`${input.language}\n${code}\n\`\`\`\n\nERROS DOS TESTES:\n${errors}\n\nINSTRUCAO ORIGINAL:\n${input.description}\n\nForneca APENAS o codigo corrigido.`;
    const response = await this.client.chatCompletion(prompt, model);
    return this.extractCode(response.choices[0].message.content, input.language);
  }

  private async runTests(code: string, input: CodeTaskInput) {
    const results = [];
    const testCode = input.testCases?.length ? `${code}\n\n# --- TESTES ---\n${input.testCases.join('\n')}` : code;

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

  private buildGenerationPrompt(input: CodeTaskInput): string {
    return `Gere codigo ${input.language} para: ${input.description}
${input.constraints ? `\nRestricoes: ${input.constraints}` : ''}
${input.testCases ? `\nTestes que devem passar:\n${input.testCases.join('\n')}` : ''}
\nForneca APENAS o codigo, sem explicacoes.`;
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
