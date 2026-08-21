import { CarcaraClient } from '../../carcara-client.js';
import { SandboxOrchestrator, SwarmTask } from '../../services/sandbox-orchestrator.js';
import { GVisorSandboxService } from '../../../infrastructure/services/gvisor-sandbox-service.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Agente QA: ÚNICO com permissão de acionar runtime da sandbox.
 * Ações: compilar, rodar testes, verificar tipagem.
 * Timeout rígido de 30s.
 */
export class QAAgent {
  private client: CarcaraClient;
  private orchestrator: SandboxOrchestrator;

  constructor(client: CarcaraClient, sandbox: GVisorSandboxService) {
    this.client = client;
    this.orchestrator = new SandboxOrchestrator(sandbox);
  }

  async runTests(testPath?: string): Promise<{ passed: number; failed: number; output: string }> {
    const task: SwarmTask = {
      id: `qa_test_${Date.now()}`,
      agentType: 'qa',
      action: 'test',
      targetPath: testPath || 'src/',
    };

    const result = await this.orchestrator.execute(task);
    const passed = (result.output.match(/✓|PASS|passed/gi) || []).length;
    const failed = (result.output.match(/✗|FAIL|failed/gi) || []).length;

    return { passed, failed, output: result.output };
  }

  async compile(): Promise<{ success: boolean; output: string }> {
    const task: SwarmTask = {
      id: `qa_compile_${Date.now()}`,
      agentType: 'qa',
      action: 'compile',
      targetPath: '.',
    };

    const result = await this.orchestrator.execute(task);
    return { success: result.success, output: result.output };
  }

  async typecheck(): Promise<{ errors: number; output: string }> {
    const task: SwarmTask = {
      id: `qa_types_${Date.now()}`,
      agentType: 'qa',
      action: 'typecheck',
      targetPath: '.',
    };

    const result = await this.orchestrator.execute(task);
    const errorCount = result.errors.length;
    return { errors: errorCount, output: result.output };
  }

  async generateTests(code: string, language: string = 'typescript'): Promise<string> {
    const prompt = `Voce e um engenheiro QA senior. Gere testes unitarios para o seguinte codigo ${language}:\n\n${code}\n\nRegras:\n- Use o framework de teste padrao (Jest/Vitest)\n- Cubra casos de sucesso e erro\n- Use mocks quando necessario\n- Responda APENAS com o codigo dos testes`;

    const response = await this.client.chatCompletion(prompt);
    return response.choices?.[0]?.message?.content || '';
  }
}
