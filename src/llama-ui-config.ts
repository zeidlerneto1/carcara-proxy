import { Page } from 'playwright';

const LLAMA_UI_PREFIX = 'LlamaUi';

export interface LlamaUIConfig {
  theme?: string;
  apiKey?: string;
  systemMessage?: string;
  pasteLongTextToFileLen?: number;
  sendOnEnter?: boolean;
  copyTextAttachmentsAsPlainText?: boolean;
  enableContinueGeneration?: boolean;
  pdfAsImage?: boolean;
  askForTitleConfirmation?: boolean;
  titleGenerationUseFirstLine?: boolean;
  titleGenerationUseLLM?: boolean;
  titleGenerationPrompt?: string;
  maxImageMPixels?: number;
  showMessageStats?: boolean;
  showThoughtInProgress?: boolean;
  showToolCallInProgress?: boolean;
  keepStatsVisible?: boolean;
  autoMicOnEmpty?: boolean;
  renderUserContentAsMarkdown?: boolean;
  fullHeightCodeBlocks?: boolean;
  disableAutoScroll?: boolean;
  alwaysShowSidebarOnDesktop?: boolean;
  showRawModelNames?: boolean;
  showModelQuantization?: boolean;
  showModelTags?: boolean;
  alwaysShowAgenticTurns?: boolean;
  samplers?: string;
  backend_sampling?: boolean;
  agenticMaxTurns?: number;
  agenticMaxToolPreviewLines?: number;
  preEncodeConversation?: boolean;
  disableReasoningParsing?: boolean;
  excludeReasoningFromContext?: boolean;
  enableThinking?: boolean;
  showRawOutputSwitch?: boolean;
  customJson?: string;
  customCss?: string;
  mcpRequestTimeoutSeconds?: number;
  showSystemMessage?: boolean;
  mcpServers?: string; // JSON string
}

export interface MCPServerConfig {
  id: string;
  enabled: boolean;
  name: string;
  url: string;
  requestTimeoutSeconds: number;
  useProxy: boolean;
}

export class LlamaUIConfigService {
  private page: Page | null = null;

  setPage(page: Page): void {
    this.page = page;
  }

  private ensurePage(): Page {
    if (!this.page || this.page.isClosed()) {
      throw new Error('Pagina do LlamaUI nao disponivel');
    }
    return this.page;
  }

  // ==========================================================================
  // LEITURA
  // ==========================================================================

  async getConfig(): Promise<LlamaUIConfig | null> {
    const page = this.ensurePage();
    const raw = await page.evaluate((prefix) => {
      const data = localStorage.getItem(`${prefix}.config`);
      return data;
    }, LLAMA_UI_PREFIX);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  async getSystemMessage(): Promise<string> {
    const cfg = await this.getConfig();
    return cfg?.systemMessage || '';
  }

  async getMcpServers(): Promise<MCPServerConfig[]> {
    const cfg = await this.getConfig();
    if (!cfg?.mcpServers) return [];
    try { return JSON.parse(cfg.mcpServers); } catch { return []; }
  }

  async getEnableThinking(): Promise<boolean> {
    const cfg = await this.getConfig();
    return cfg?.enableThinking ?? true;
  }

  async getBackendSampling(): Promise<boolean> {
    const cfg = await this.getConfig();
    return cfg?.backend_sampling ?? false;
  }

  async getTheme(): Promise<string> {
    const cfg = await this.getConfig();
    return cfg?.theme || 'system';
  }

  async getRaw(key: string): Promise<string | null> {
    const page = this.ensurePage();
    return page.evaluate((fullKey) => localStorage.getItem(fullKey), key);
  }

  // ==========================================================================
  // ESCRITA
  // ==========================================================================

  async setConfig(updates: Partial<LlamaUIConfig>): Promise<void> {
    const page = this.ensurePage();
    await page.evaluate((prefix, updates) => {
      const key = `${prefix}.config`;
      const existing = localStorage.getItem(key);
      const current = existing ? JSON.parse(existing) : {};
      const merged = { ...current, ...updates };
      localStorage.setItem(key, JSON.stringify(merged));
    }, LLAMA_UI_PREFIX, updates);
  }

  async setSystemMessage(message: string): Promise<void> {
    await this.setConfig({ systemMessage: message });
  }

  async setEnableThinking(enabled: boolean): Promise<void> {
    await this.setConfig({ enableThinking: enabled });
  }

  async setBackendSampling(enabled: boolean): Promise<void> {
    await this.setConfig({ backend_sampling: enabled });
  }

  async setTheme(theme: string): Promise<void> {
    await this.setConfig({ theme });
  }

  async setMcpServers(servers: MCPServerConfig[]): Promise<void> {
    await this.setConfig({ mcpServers: JSON.stringify(servers) });
  }

  async addMcpServer(server: MCPServerConfig): Promise<void> {
    const servers = await this.getMcpServers();
    const idx = servers.findIndex(s => s.id === server.id);
    if (idx >= 0) servers[idx] = server;
    else servers.push(server);
    await this.setMcpServers(servers);
  }

  async removeMcpServer(id: string): Promise<void> {
    const servers = await this.getMcpServers();
    await this.setMcpServers(servers.filter(s => s.id !== id));
  }

  async setRaw(key: string, value: string): Promise<void> {
    const page = this.ensurePage();
    await page.evaluate((k, v) => localStorage.setItem(k, v), key, value);
  }

  async deleteRaw(key: string): Promise<void> {
    const page = this.ensurePage();
    await page.evaluate((k) => localStorage.removeItem(k), key);
  }

  // ==========================================================================
  // UTILS
  // ==========================================================================

  async getAllKeys(): Promise<string[]> {
    const page = this.ensurePage();
    return page.evaluate(() => Object.keys(localStorage));
  }

  async getAllLlamaUiData(): Promise<Record<string, any>> {
    const page = this.ensurePage();
    const keys = await this.getAllKeys();
    const result: Record<string, any> = {};
    for (const key of keys) {
      if (key.startsWith(LLAMA_UI_PREFIX)) {
        const raw = await this.getRaw(key);
        try { result[key] = JSON.parse(raw || ''); } catch { result[key] = raw; }
      }
    }
    return result;
  }

  async resetConfig(): Promise<void> {
    const page = this.ensurePage();
    await page.evaluate((prefix) => {
      const keys = Object.keys(localStorage).filter(k => k.startsWith(prefix));
      keys.forEach(k => localStorage.removeItem(k));
    }, LLAMA_UI_PREFIX);
  }
}
