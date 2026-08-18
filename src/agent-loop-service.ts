import pino from 'pino';
import { ChatMessage, ToolCall } from './types.js';
import { TagParserService } from './tag-parser-service.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export interface AgentLoopConfig {
  maxRolls: number;           // Número máximo de tentativas/iterações (default: 5)
  stopConditions?: string[];  // Condições de parada personalizadas
  enableToolUse?: boolean;    // Habilitar uso de ferramentas
  enableSelfReflection?: boolean; // Habilitar auto-reflexão
  enableTagParsing?: boolean; // Habilitar parsing de tags estilo Kimi Chat
  useTagsForTools?: boolean;  // Usar tags em vez de tool calls nativos
  availableTools?: string[];  // Lista de tools disponíveis para o prompt
  temperature?: number;
  maxTokens?: number;
}

export interface AgentRollResult {
  rollNumber: number;
  content: string;
  toolCalls?: ToolCall[];
  finishReason: string;
  needsAnotherRoll: boolean;
  error?: string;
}

export interface AgentLoopResult {
  success: boolean;
  rolls: AgentRollResult[];
  finalContent: string;
  totalRolls: number;
  stoppedByCondition?: string;
}

/**
 * Agente com Loop de Engenharia no Client-Side
 * 
 * Implementa um ciclo de reflexão-ação-observação com número configurável de rolls.
 * Padrão: 5 rolls, mas totalmente customizável.
 */
export class AgentLoopService {
  private config: AgentLoopConfig;
  private defaultConfig: AgentLoopConfig = {
    maxRolls: 5,
    stopConditions: [
      'task completed',
      'goal achieved',
      'no further action needed',
      'final answer',
    ],
    enableToolUse: true,
    enableSelfReflection: true,
    enableTagParsing: true,      // Novo: parsing de tags habilitado por padrão
    useTagsForTools: true,       // Novo: usa tags em vez de tool calls nativos
    availableTools: [
      'search',
      'browse',
      'code',
      'read_file',
      'write_file',
      'run_command',
    ],
    temperature: 0.7,
    maxTokens: 4096,
  };

  constructor(config: Partial<AgentLoopConfig> = {}) {
    this.config = { ...this.defaultConfig, ...config };
    logger.info({ maxRolls: this.config.maxRolls }, 'AgentLoopService initialized');
  }

  /**
   * Atualiza configuração dinamicamente
   */
  updateConfig(newConfig: Partial<AgentLoopConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info({ maxRolls: this.config.maxRolls }, 'AgentLoopConfig updated');
  }

  /**
   * Verifica se deve parar o loop baseado nas condições
   */
  private shouldStop(content: string, rollNumber: number): { stop: boolean; reason?: string } {
    // Verifica se atingiu máximo de rolls
    if (rollNumber >= this.config.maxRolls) {
      return { stop: true, reason: 'max_rolls_reached' };
    }

    // Verifica condições de parada personalizadas
    const lowerContent = content.toLowerCase();
    for (const condition of this.config.stopConditions || []) {
      if (lowerContent.includes(condition.toLowerCase())) {
        return { stop: true, reason: condition };
      }
    }

    // Verifica se não há tool calls e habilitou tool use
    if (!this.config.enableToolUse) {
      return { stop: false };
    }

    return { stop: false };
  }

  /**
   * Cria prompt de reflexão para próximo roll com instruções de tags
   */
  private createReflectionPrompt(
    originalTask: string,
    previousRolls: AgentRollResult[]
  ): string {
    // Gera system prompt com instruções de tags se habilitado
    let systemPrompt = '';
    if (this.config.enableTagParsing && this.config.useTagsForTools) {
      systemPrompt = TagParserService.generateSystemPrompt({
        availableTools: this.config.availableTools,
        enableThinking: this.config.enableSelfReflection,
      }) + '\n\n---\n';
    }

    if (!this.config.enableSelfReflection || previousRolls.length === 0) {
      return systemPrompt + originalTask;
    }

    const reflectionContext = previousRolls.map((roll, idx) => 
      `### Roll ${idx + 1}:\n${roll.content}\n${roll.toolCalls && roll.toolCalls.length > 0 ? `\nFerramentas usadas: ${JSON.stringify(roll.toolCalls)}` : ''}`
    ).join('\n\n');

    return `${systemPrompt}[AGENT LOOP - Roll ${previousRolls.length + 1}/${this.config.maxRolls}]

Tarefa Original: ${originalTask}

Histórico de Execução:
${reflectionContext}

---
Instruções:
1. Analise o progresso até agora
2. Identifique o que ainda falta fazer
3. Execute próxima ação necessária usando TAGS apropriadas
4. Se tarefa completa, use <final>...</final>
5. Se precisa de mais iterações, continue com próxima ação

Resposta:`;
  }

  /**
   * Executa loop completo do agente com parsing de tags
   */
  async executeLoop(
    initialTask: string,
    chatCompletionFn: (prompt: string, config?: any) => Promise<{ content: string; toolCalls?: ToolCall[]; finishReason: string }>
  ): Promise<AgentLoopResult> {
    const rolls: AgentRollResult[] = [];
    let currentTask = initialTask;
    let finalContent = '';
    let stoppedByCondition: string | undefined;

    logger.info({ task: initialTask, maxRolls: this.config.maxRolls }, 'Starting agent loop');

    for (let rollNum = 1; rollNum <= this.config.maxRolls; rollNum++) {
      try {
        const prompt = this.createReflectionPrompt(currentTask, rolls);
        
        logger.info({ roll: rollNum, maxRolls: this.config.maxRolls }, `Executing roll ${rollNum}`);
        
        const response = await chatCompletionFn(prompt, {
          temperature: this.config.temperature,
          maxTokens: this.config.maxTokens,
        });

        // Parseia tags da resposta se habilitado
        let toolCalls = response.toolCalls || [];
        let parsedContent = response.content;
        
        if (this.config.enableTagParsing && this.config.useTagsForTools) {
          const parseResult = TagParserService.parse(response.content);
          
          // Usa tool calls extraídos das tags
          if (parseResult.hasToolCalls && parseResult.toolCalls.length > 0) {
            toolCalls = parseResult.toolCalls;
            logger.info({ tagsFound: parseResult.tags.length }, 'Tags parsed and converted to tool calls');
          }
          
          // Usa texto limpo (sem tags) como conteúdo
          parsedContent = parseResult.plainText;
        }

        const rollResult: AgentRollResult = {
          rollNumber: rollNum,
          content: parsedContent,
          toolCalls,
          finishReason: response.finishReason,
          needsAnotherRoll: false,
        };

        rolls.push(rollResult);
        finalContent = parsedContent;

        // Verifica condições de parada
        const stopCheck = this.shouldStop(parsedContent, rollNum);
        if (stopCheck.stop) {
          stoppedByCondition = stopCheck.reason;
          logger.info({ reason: stopCheck.reason, roll: rollNum }, 'Agent loop stopped');
          break;
        }

        // Se tem tool calls, processa e continua
        if (toolCalls.length > 0 && this.config.enableToolUse) {
          rollResult.needsAnotherRoll = true;
          logger.info({ toolCallsCount: toolCalls.length }, 'Tool calls detected, another roll needed');
          // Aqui você executaria as tools e atualizaria currentTask
          // currentTask = await this.executeTools(toolCalls);
        }

      } catch (error: any) {
        logger.error({ roll: rollNum, error: error.message }, 'Error in agent roll');
        rolls.push({
          rollNumber: rollNum,
          content: '',
          finishReason: 'error',
          needsAnotherRoll: false,
          error: error.message,
        });
        
        // Decide se continua ou para baseado no erro
        if (error.message.includes('critical') || error.message.includes('fatal')) {
          break;
        }
      }
    }

    const result: AgentLoopResult = {
      success: rolls.length > 0 && !rolls.some(r => r.error),
      rolls,
      finalContent,
      totalRolls: rolls.length,
      stoppedByCondition,
    };

    logger.info({ 
      success: result.success, 
      totalRolls: result.totalRolls,
      stoppedBy: result.stoppedByCondition 
    }, 'Agent loop completed');

    return result;
  }

  /**
   * Executa um único roll (para controle manual)
   */
  async executeSingleRoll(
    task: string,
    previousRolls: AgentRollResult[],
    chatCompletionFn: (prompt: string) => Promise<{ content: string; toolCalls?: ToolCall[]; finishReason: string }>
  ): Promise<AgentRollResult> {
    const prompt = this.createReflectionPrompt(task, previousRolls);
    
    const response = await chatCompletionFn(prompt);
    
    return {
      rollNumber: previousRolls.length + 1,
      content: response.content,
      toolCalls: response.toolCalls,
      finishReason: response.finishReason,
      needsAnotherRoll: response.finishReason !== 'stop',
    };
  }

  /**
   * Get current configuration
   */
  getConfig(): AgentLoopConfig {
    return { ...this.config };
  }

  /**
   * Set max rolls dynamically
   */
  setMaxRolls(maxRolls: number): void {
    if (maxRolls < 1 || maxRolls > 20) {
      logger.warn({ maxRolls }, 'Invalid maxRolls value, must be between 1 and 20');
      return;
    }
    this.config.maxRolls = maxRolls;
    logger.info({ maxRolls }, 'Max rolls updated');
  }
}
