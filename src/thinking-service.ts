import { SearchService } from './search-service.js';
import { AgentEngine } from './agent-engine.js';
import { MemoryService } from './memory-service.js';
import { MetricsService } from './metrics-service.js';
import { CarcaraClient } from './carcara-client.js';
import { ThinkingConfig, ThinkingLevel, CodeTaskInput, AgentTask } from './types.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const LEVEL_MAP: Record<ThinkingLevel, number> = {
  off: 0, low: 512, medium: 2048, high: 8192, max: 10000,
};

export class ThinkingService {
  private searchService = new SearchService();
  private config: ThinkingConfig = {
    enabled: true, level: 'low', budgetTokens: 512,
    reasoningControl: true, reasoningFormat: 'auto',
    sandboxEnabled: true, sandboxTools: ['web_search', 'get_time', 'calculate'],
  };
  private agentEngine: AgentEngine | null = null;
  private memoryService: MemoryService | null = null;
  private metricsService: MetricsService | null = null;
  private client: CarcaraClient | null = null;

  setServices(agentEngine: AgentEngine, memory: MemoryService, metrics: MetricsService, client: CarcaraClient): void {
    this.agentEngine = agentEngine;
    this.memoryService = memory;
    this.metricsService = metrics;
    this.client = client;
  }

  setConfig(cfg: Partial<ThinkingConfig>): void {
    this.config = { ...this.config, ...cfg };
    if (cfg.level && !cfg.budgetTokens) this.config.budgetTokens = LEVEL_MAP[cfg.level];
  }

  getConfig(): ThinkingConfig { return { ...this.config }; }
  setLevel(level: ThinkingLevel): void {
    this.config.level = level;
    this.config.budgetTokens = LEVEL_MAP[level];
    this.config.enabled = level !== 'off';
  }

  applyToPayload(payload: any): any {
    if (!this.config.enabled) {
      return { ...payload, enable_thinking: false, reasoning_control: false, chat_template_kwargs: { enable_thinking: false } };
    }
    return {
      ...payload, enable_thinking: true, reasoning_control: this.config.reasoningControl,
      reasoning_format: this.config.reasoningFormat, thinking_budget_tokens: this.config.budgetTokens,
      chat_template_kwargs: { enable_thinking: true }, timings_per_token: true,
    };
  }

  /** Detecta intencao de agente e delega. Retorna resultado do agente ou null. */
  async detectAndRunAgent(prompt: string): Promise<string | null> {
    const lower = prompt.toLowerCase().trim();

    // Padroes de ativacao de agente
    const patterns = [
      { regex: /^(?:\/agent|@agent)\s+(\w+)\s*(.*)/i, type: 'direct' },
      { regex: /^(?:gera|generate|escreve|write|cria|create)\s+(?:codigo|code|script|programa)/i, type: 'code' },
      { regex: /^(?:otimiza|optimize|melhora|improve)\s+(?:prompt|instrucao)/i, type: 'prompt' },
      { regex: /^(?:plano|plan|decompoe|break down)/i, type: 'plan' },
    ];

    for (const p of patterns) {
      const match = lower.match(p.regex);
      if (!match) continue;

      if (!this.agentEngine || !this.client) {
        logger.warn('AgentEngine nao configurado');
        return null;
      }

      this.metricsService?.record('agent.trigger', 1, { pattern: p.type });

      try {
        if (p.type === 'direct') {
          const agentId = match[1];
          const input = match[2] || prompt;
          const result = await this.agentEngine.run({
            id: `trigger_${Date.now()}`, agentId,
            input: { description: input, language: 'python' },
          });
          return this.formatAgentResult(result);
        }

        if (p.type === 'code') {
          const lang = this.detectLanguage(prompt) || 'python';
          const result = await this.agentEngine.run({
            id: `code_${Date.now()}`, agentId: 'code-loop',
            input: { description: prompt, language: lang } as CodeTaskInput,
          });
          return this.formatAgentResult(result);
        }

        if (p.type === 'prompt') {
          const result = await this.agentEngine.run({
            id: `prompt_${Date.now()}`, agentId: 'prompt-engineer',
            input: { originalPrompt: prompt, objective: 'melhorar clareza e precisao', evaluationCriteria: ['clareza', 'precisao'] },
          });
          return this.formatAgentResult(result);
        }

        if (p.type === 'plan') {
          const result = await this.agentEngine.run({
            id: `plan_${Date.now()}`, agentId: 'task-planner',
            input: prompt,
          });
          return this.formatAgentResult(result);
        }
      } catch (err: any) {
        logger.error({ error: err.message, pattern: p.type }, 'Erro no agente');
        return `[Erro do agente: ${err.message}]`;
      }
    }

    return null;
  }

  async executeSandbox(prompt: string, context?: string): Promise<string> {
    // Primeiro tenta agente
    const agentResult = await this.detectAndRunAgent(prompt);
    if (agentResult !== null) return agentResult;

    // Fallback: enriquecimento tradicional
    if (!this.config.sandboxEnabled || !this.config.enabled) return prompt;

    const enriched: string[] = [prompt];

    if (this.config.sandboxTools.includes('web_search')) {
      try {
        const search = await this.searchService.duckDuckGo(prompt);
        if (search.results?.length) {
          enriched.push('\n[Contexto da web]:');
          search.results.slice(0, 3).forEach((r: any, i: number) => {
            enriched.push(`${i + 1}. ${r.title}: ${r.snippet}`);
          });
        }
      } catch {}
    }

    if (this.config.sandboxTools.includes('get_time')) {
      enriched.push(`\n[Data/Hora atual]: ${new Date().toISOString()}`);
    }

    if (this.config.sandboxTools.includes('calculate')) {
      const mathExpr = this.extractMathExpression(prompt);
      if (mathExpr) {
        try {
          const result = Function(`'use strict'; return (${mathExpr})`)();
          enriched.push(`\n[Calculo: ${mathExpr} = ${result}]`);
        } catch {}
      }
    }

    if (context) enriched.push(`\n[Contexto anterior]:\n${context}`);

    return enriched.join('\n');
  }

  private detectLanguage(prompt: string): string | null {
    const p = prompt.toLowerCase();
    if (p.includes('python') || p.includes('.py')) return 'python';
    if (p.includes('javascript') || p.includes('.js') || p.includes('node')) return 'javascript';
    if (p.includes('typescript') || p.includes('.ts')) return 'typescript';
    if (p.includes('bash') || p.includes('shell') || p.includes('.sh')) return 'bash';
    return null;
  }

  private extractMathExpression(text: string): string | null {
    const match = text.match(/([\d\s+\-*/().^]+=[\d\s+\-*/().^]+)/);
    return match ? match[1].trim() : null;
  }

  private formatAgentResult(result: any): string {
    if (result?.output?.code) {
      return `\u250C\u2500\u2500\u2500 Agente: ${result.agentId} (score: ${result.output.score || '?'}) \u2510\n${result.output.code}\n\u2514\u2500\u2500\u2500 ${result.output.explanation || ''} \u2518`;
    }
    if (Array.isArray(result?.output)) {
      return result.output.map((o: any, i: number) => `${i + 1}. ${o.prompt || JSON.stringify(o)}`).join('\n');
    }
    return JSON.stringify(result?.output, null, 2);
  }
}
