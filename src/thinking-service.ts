import { SearchService } from './search-service.js';

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

export interface ThinkingConfig {
  enabled: boolean;
  level: ThinkingLevel;
  budgetTokens: number;
  reasoningControl: boolean;
  reasoningFormat: 'auto' | 'plain' | 'structured';
  sandboxEnabled: boolean;
  sandboxTools: string[];
}

const LEVEL_MAP: Record<ThinkingLevel, number> = {
  off: 0,
  low: 512,
  medium: 2048,
  high: 8192,
  max: 10000,
};

export class ThinkingService {
  private searchService = new SearchService();
  private config: ThinkingConfig = {
    enabled: true,
    level: 'low',
    budgetTokens: 512,
    reasoningControl: true,
    reasoningFormat: 'auto',
    sandboxEnabled: true,
    sandboxTools: ['web_search', 'get_time', 'calculate'],
  };

  // ==========================================================================
  // CONFIG (usado pelo carcara-client ao inicializar)
  // ==========================================================================

  setConfig(cfg: Partial<ThinkingConfig>): void {
    this.config = { ...this.config, ...cfg };
    if (cfg.level && !cfg.budgetTokens) {
      this.config.budgetTokens = LEVEL_MAP[cfg.level];
    }
  }

  getConfig(): ThinkingConfig {
    return { ...this.config };
  }

  setLevel(level: ThinkingLevel): void {
    this.config.level = level;
    this.config.budgetTokens = LEVEL_MAP[level];
    this.config.enabled = level !== 'off';
  }

  // ==========================================================================
  // APLICAR NO PAYLOAD DO CARCARA (chamado automaticamente pelo client)
  // ==========================================================================

  applyToPayload(payload: any): any {
    if (!this.config.enabled) {
      return {
        ...payload,
        enable_thinking: false,
        reasoning_control: false,
        chat_template_kwargs: { enable_thinking: false },
      };
    }

    return {
      ...payload,
      enable_thinking: true,
      reasoning_control: this.config.reasoningControl,
      reasoning_format: this.config.reasoningFormat,
      thinking_budget_tokens: this.config.budgetTokens,
      chat_template_kwargs: { enable_thinking: true },
      timings_per_token: true,
    };
  }

  // ==========================================================================
  // SANDBOX - ENRIQUECE PROMPT COM ACESSO CONTROLADO À REDE
  // ==========================================================================

  async executeSandbox(prompt: string, context?: string): Promise<string> {
    if (!this.config.sandboxEnabled || !this.config.enabled) {
      return prompt;
    }

    const enriched: string[] = [prompt];

    if (this.config.sandboxTools.includes('web_search')) {
      try {
        const search = await this.searchService.duckDuckGo(prompt);
        if (search.results?.length) {
          enriched.push(`\n[Contexto da web]:`);
          search.results.slice(0, 3).forEach((r: any, i: number) => {
            enriched.push(`${i + 1}. ${r.title}: ${r.snippet}`);
          });
        }
      } catch {}
    }

    if (this.config.sandboxTools.includes('get_time')) {
      try {
        const now = new Date();
        enriched.push(`\n[Data/Hora atual]: ${now.toISOString()}`);
      } catch {}
    }

    if (this.config.sandboxTools.includes('calculate')) {
      const mathExpr = this.extractMathExpression(prompt);
      if (mathExpr) {
        try {
          const result = Function(`'use strict'; return (${mathExpr})`)();
          enriched.push(`\n[Cálculo: ${mathExpr} = ${result}]`);
        } catch {}
      }
    }

    if (context) {
      enriched.push(`\n[Contexto anterior]:\n${context}`);
    }

    return enriched.join('\n');
  }

  private extractMathExpression(text: string): string | null {
    const match = text.match(/([\d\s+\-*/().^]+=[\d\s+\-*/().^]+)/);
    return match ? match[1].trim() : null;
  }
}
