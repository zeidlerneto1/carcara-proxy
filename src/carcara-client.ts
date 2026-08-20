import { chromium, Browser, BrowserContext, Page } from 'playwright';
import axios, { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import pino from 'pino';
import { Readable } from 'stream';
import { LlamaUIConfigService } from './llama-ui-config.js';
import { ThinkingService, ThinkingConfig } from './thinking-service.js';
import { AgentEngine } from './agent-engine.js';
import { MemoryService } from './memory-service.js';
import { MetricsService } from './metrics-service.js';
import {
  CarcaraConfig, LlamaMessage, ConversationNode, ChatCompletionResponse,
  MCPListResponse, LoginPayload, ModelInfo, LoginScript, LoginStep, StoredSession
} from './types.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const CARCARA_BASE_URL = process.env.CARCARA_URL || 'https://carcara.sinapad.lncc.br';
const LOGIN_PAGE = '/apps/login/';
const LOGIN_API = '/apps/login/action/loginAction.php';
const SERVICE_PATH = '/service';
const MODELS_API = '/v1/models';
const CHAT_API = '/v1/chat/completions';
const MCP_API = '/mcp';

const DB_NAME = 'LlamaUi';
const DB_NAME_LEGACY = 'LlamacppWebui';
const DB_NAMES = [DB_NAME, DB_NAME_LEGACY];
const DB_STORE_CONVERSATIONS = 'conversations';
const DB_STORE_MESSAGES = 'messages';

const DEFAULT_DOMAIN = 'LNCC';
const DEFAULT_MODEL = 'Qwen3.6-35B';
const DEFAULT_TITLE = 'Nova Conversa LNCC';
const DEFAULT_TEMPERATURE = 0.5;
const DEFAULT_MAX_TOKENS = parseInt(process.env.MAX_OUTPUT_TOKENS || "4096", 10);

const ENV_USER = 'LNCC_USER';
const ENV_PASS = 'LNCC_PASS';

const TIMEOUT_NAVIGATION = 30000;
const TIMEOUT_ELEMENT = 10000;
const TIMEOUT_API = 15000;
const TIMEOUT_RETRY = 1000;
const TIMEOUT_CHAT = 100000;
const TIMEOUT_SESSION_EXPIRY = 24 * 60 * 60 * 1000;
const MAX_RETRIES = 3;
const MODELS_CACHE_TTL = 60 * 60 * 1000;

// ============================================================================
// LOGIN RECORDER
// ============================================================================

class LoginRecorder {
  private steps: LoginStep[] = [];
  private isRecording = false;
  private readonly basePath: string;

  constructor() {
    this.basePath = path.join(process.cwd(), '.carcara');
    this.ensureDir().catch(() => {});
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
  }

  get scriptPath(): string { return path.join(this.basePath, 'login-script.json'); }
  get sessionPath(): string { return path.join(this.basePath, 'session.json'); }
  get logPath(): string { return path.join(this.basePath, 'login-history.log'); }
  get modelsPath(): string { return path.join(this.basePath, 'models-cache.json'); }

  startRecording(): void {
    this.isRecording = true;
    this.steps = [];
    logger.info('Gravando processo de login...');
  }

  stopRecording(): void {
    this.isRecording = false;
    logger.info('Gravacao finalizada');
  }

  recordStep(step: LoginStep): void {
    if (this.isRecording) {
      this.steps.push(step);
      logger.info({ step: step.type, desc: step.description }, 'Passo gravado');
    }
  }

  async saveLoginScript(): Promise<void> {
    const script: LoginScript = {
      version: '2.0', url: CARCARA_BASE_URL,
      createdAt: new Date().toISOString(), steps: this.steps,
      successIndicators: { cookieNames: ['PHPSESSID', 'carcara_auth'], responseStatus: 200 },
    };
    await fs.writeFile(this.scriptPath, JSON.stringify(script, null, 2), 'utf-8');
    logger.info({ steps: this.steps.length }, 'Script salvo');
  }

  async saveSession(page: Page, token?: string): Promise<void> {
    try {
      const cookies = await page.context().cookies();
      const phpsessid = cookies.find(c => c.name === 'PHPSESSID')?.value;
      const carcaraAuth = cookies.find(c => c.name === 'carcara_auth')?.value;
      const session: StoredSession = {
        token: token || '', cookies: cookies as any, phpsessid, timestamp: Date.now(),
      };
      if (carcaraAuth) (session as any).carcaraAuth = carcaraAuth;
      await fs.writeFile(this.sessionPath, JSON.stringify(session, null, 2), 'utf-8');
      logger.info({ phpsessid: phpsessid?.slice(0, 10), carcaraAuth: carcaraAuth?.slice(0, 10) }, 'Sessao salva');
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Erro ao salvar sessao');
    }
  }

  async restoreSession(page: Page): Promise<StoredSession | null> {
    try {
      const data = await fs.readFile(this.sessionPath, 'utf-8');
      const session: StoredSession = JSON.parse(data);
      if (Date.now() - session.timestamp > TIMEOUT_SESSION_EXPIRY) {
        logger.warn('Sessao expirada (>24h)');
        return null;
      }
      if (session.cookies?.length) {
        await page.context().addCookies(session.cookies as any);
        logger.info('Cookies restaurados');
      }
      const serviceUrl = `${CARCARA_BASE_URL}${SERVICE_PATH}/`;
      const url = session.token ? `${serviceUrl}?token=${session.token}` : serviceUrl;
      await page.goto(url, { waitUntil: 'networkidle', timeout: TIMEOUT_NAVIGATION });
      await page.waitForTimeout(2000);
      return session;
    } catch (error: any) {
      logger.error({ error: error.message }, 'Erro ao restaurar sessao');
      return null;
    }
  }

  async saveModelsCache(models: ModelInfo[]): Promise<void> {
    const cache = { timestamp: Date.now(), models };
    await fs.writeFile(this.modelsPath, JSON.stringify(cache, null, 2), 'utf-8');
    logger.info({ count: models.length }, 'Cache de modelos salvo');
  }

  async loadModelsCache(): Promise<ModelInfo[] | null> {
    try {
      const data = await fs.readFile(this.modelsPath, 'utf-8');
      const cache = JSON.parse(data);
      if (Date.now() - cache.timestamp < MODELS_CACHE_TTL) {
        logger.info({ count: cache.models.length }, 'Cache de modelos carregado');
        return cache.models;
      }
    } catch { /* no cache */ }
    return null;
  }

  log(message: string): void {
    logger.info(message);
  }
}

// ============================================================================
// CLASSE PRINCIPAL
// ============================================================================

export class CarcaraClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private axiosInstance: AxiosInstance;
  private config: { baseUrl: string; apiBaseUrl: string; domain: string };
  private recorder: LoginRecorder;
  private llamaUIConfig: LlamaUIConfigService;
  private thinkingService: ThinkingService;
  private agentEngine: AgentEngine | null = null;
  private memoryService: MemoryService | null = null;
  private metricsService: MetricsService | null = null;

  private authToken: string | null = null;
  private phpsessid: string | null = null;
  private carcaraAuth: string | null = null;
  private cookieStringCache: string = '';
  private cookieStringCacheTime: number = 0;
  private currentConversationId: string | null = null;
  private isInitialized = false;
  private availableModels: ModelInfo[] = [];
  private modelsCacheTime = 0;

  constructor(config: CarcaraConfig = {}) {
    const baseUrl = config.baseUrl || CARCARA_BASE_URL;
    const domain = config.domain || DEFAULT_DOMAIN;
    this.config = { baseUrl, apiBaseUrl: config.apiBaseUrl || `${baseUrl}${SERVICE_PATH}`, domain };
    this.axiosInstance = this.createAxiosInstance();
    this.recorder = new LoginRecorder();
    this.llamaUIConfig = new LlamaUIConfigService();
    this.thinkingService = new ThinkingService();
  }

  setAgentEngine(engine: AgentEngine): void {
    this.agentEngine = engine;
    this.thinkingService.setServices(engine, this.memoryService!, this.metricsService!, this);
  }

  setMemoryService(memory: MemoryService): void {
    this.memoryService = memory;
    if (this.agentEngine) this.thinkingService.setServices(this.agentEngine, memory, this.metricsService!, this);
  }

  setMetricsService(metrics: MetricsService): void {
    this.metricsService = metrics;
    if (this.agentEngine) this.thinkingService.setServices(this.agentEngine, this.memoryService!, metrics, this);
  }

  get thinking(): ThinkingService { return this.thinkingService; }

  private createAxiosInstance(): AxiosInstance {
    const instance = axios.create({
      baseURL: this.config.baseUrl,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        'Origin': this.config.baseUrl,
        'Referer': `${this.config.baseUrl}/`,
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
      maxRedirects: 5,
      validateStatus: () => true,
    });

    instance.interceptors.request.use(async (cfg: InternalAxiosRequestConfig) => {
      if (!cfg.headers) cfg.headers = new axios.AxiosHeaders();
      const cookies = await this.getCookieString();
      if (cookies) cfg.headers.set('Cookie', cookies);
      return cfg;
    });

    return instance;
  }

  private async getCookieString(): Promise<string> {
    if (!this.context || this.page?.isClosed()) return this.cookieStringCache;
    const now = Date.now();
    if (now - this.cookieStringCacheTime < 5000 && this.cookieStringCache) return this.cookieStringCache;
    const cookies = await this.context.cookies([this.config.baseUrl]);
    this.cookieStringCache = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    this.cookieStringCacheTime = now;
    return this.cookieStringCache;
  }

  private invalidateCookieCache(): void {
    this.cookieStringCache = '';
    this.cookieStringCacheTime = 0;
  }

  async init(): Promise<void> {
    if (this.isInitialized) {
      logger.info('Cliente ja inicializado');
      return;
    }
    logger.info({ url: this.config.baseUrl, domain: this.config.domain }, 'Iniciando Carcara Client');

    try {
      await this.launchBrowser();
      await this.handleAuthentication();
      await this.navigateToService();
      await this.fetchModels();
      this.isInitialized = true;
      logger.info('Carcara Client inicializado com sucesso');
    } catch (error: any) {
      logger.error({ error: error.message }, 'Falha na inicializacao');
      await this.cleanup();
      throw error;
    }
  }

  private async launchBrowser(): Promise<void> {
    logger.info('Lancando navegador');
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas', '--disable-gpu', '--no-zygote',
        '--disable-background-networking', '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows', '--disable-breakpad',
        '--disable-component-extensions-with-background-pages', '--disable-extensions',
        '--disable-features=TranslateUI', '--disable-ipc-flooding-protection',
        '--disable-renderer-backgrounding', '--force-color-profile=srgb',
        '--metrics-recording-only', '--mute-audio',
      ],
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
    });

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(TIMEOUT_ELEMENT);
    this.llamaUIConfig.setPage(this.page);
    logger.info('Navegador pronto');
  }

  private async handleAuthentication(): Promise<void> {
    const restored = await this.recorder.restoreSession(this.page!);
    if (restored) {
      logger.info('Sessao restaurada do disco');
      return;
    }

    const envConfig = this.getEnvConfig();
    if (envConfig) {
      const success = await this.apiLogin(envConfig);
      if (success) {
        logger.info('Login automatico via API');
        return;
      }
    }

    await this.browserLogin(envConfig);
  }

  private async navigateToService(): Promise<void> {
    const serviceUrl = `${this.config.baseUrl}${SERVICE_PATH}/`;
    if (!this.page?.url().includes(SERVICE_PATH)) {
      await this.page!.goto(serviceUrl, { waitUntil: 'networkidle', timeout: TIMEOUT_NAVIGATION });
      await this.page!.waitForTimeout(2000);
    }
    logger.info('Servico carregado');
  }

  private async apiLogin(envConfig: { username: string; password: string }): Promise<boolean> {
    try {
      this.recorder.startRecording();
      this.recorder.recordStep({ type: 'navigate', url: `${this.config.baseUrl}${LOGIN_PAGE}`, description: 'Pagina de login' });

      await this.page!.goto(`${this.config.baseUrl}${LOGIN_PAGE}`, { waitUntil: 'networkidle' });
      await this.page!.waitForTimeout(2000);

      const cookies = await this.context!.cookies([this.config.baseUrl]);
      const phpsessid = cookies.find(c => c.name === 'PHPSESSID')?.value;
      if (phpsessid) {
        this.phpsessid = phpsessid;
        logger.info({ sessid: phpsessid.slice(0, 10) }, 'PHPSESSID obtido');
      }

      const payload: LoginPayload = { action: 'login', user: envConfig.username, password: envConfig.password, domain: this.config.domain };
      const response = await this.axiosInstance.post(LOGIN_API, payload, {
        headers: { 'Cookie': `PHPSESSID=${phpsessid}`, 'Content-Type': 'application/json;charset=UTF-8' },
        timeout: TIMEOUT_API,
      });

      logger.info({ status: response.status }, 'Resposta do login API');

      if (response.status === 200 && response.data?.status === 'OK') {
        await this.page!.waitForTimeout(2000);
        await this.page!.reload({ waitUntil: 'networkidle' });
        await this.page!.waitForTimeout(2000);

        const updatedCookies = await this.context!.cookies([this.config.baseUrl]);
        const carcaraAuthCookie = updatedCookies.find(c => c.name === 'carcara_auth');
        if (carcaraAuthCookie) {
          this.carcaraAuth = carcaraAuthCookie.value;
          logger.info({ auth: this.carcaraAuth.slice(0, 15) }, 'carcara_auth apos login');
        }

        try {
          const urlObj = new URL(this.page!.url());
          this.authToken = urlObj.searchParams.get('token') || null;
        } catch {}

        this.invalidateCookieCache();
        await this.recorder.saveSession(this.page!, this.authToken || undefined);
        return true;
      }
      return false;
    } catch (error: any) {
      logger.error({ error: error.message }, 'Erro na API de login');
      return false;
    }
  }

  private async browserLogin(envConfig?: { username: string; password: string } | null): Promise<void> {
    if (envConfig) {
      logger.info('Tentando login automatico via navegador');
      const loginUrl = `${this.config.baseUrl}${LOGIN_PAGE}`;
      await this.page!.goto(loginUrl, { waitUntil: 'networkidle' });

      await this.fillField(['input[name="user"]', 'input[type="text"]', 'input[type="email"]'], envConfig.username, 'usuario');
      await this.fillField(['input[type="password"]', 'input[name="password"]'], envConfig.password, 'senha');
      await this.clickSubmit();
      await this.page!.waitForTimeout(3000);

      if (!this.isOnLoginPage()) {
        this.invalidateCookieCache();
        await this.recorder.saveSession(this.page!);
        return;
      }
    }

    logger.info('Login manual necessario');
    if (!this.isOnLoginPage()) {
      await this.page!.goto(`${this.config.baseUrl}${LOGIN_PAGE}`, { waitUntil: 'networkidle' });
    }
    await this.page!.waitForURL((url) => !url.toString().includes('/login'), { timeout: 0 });
    logger.info('Login manual detectado');
    this.invalidateCookieCache();
    await this.recorder.saveSession(this.page!);
    await this.saveCredentialsFromPage();
  }

  private async fetchModels(): Promise<void> {
    logger.info('Buscando modelos disponiveis');
    if (Date.now() - this.modelsCacheTime < MODELS_CACHE_TTL && this.availableModels.length) {
      logger.info({ count: this.availableModels.length }, 'Usando cache em memoria');
      return;
    }
    const cachedModels = await this.recorder.loadModelsCache();
    if (cachedModels?.length) {
      this.availableModels = cachedModels;
      this.modelsCacheTime = Date.now();
      this.displayModels();
      return;
    }
    try {
      const response = await this.axiosInstance.get(MODELS_API, { baseURL: this.config.apiBaseUrl, timeout: TIMEOUT_API });
      if (response.status === 200 && response.data?.data) {
        this.availableModels = response.data.data;
        this.modelsCacheTime = Date.now();
        await this.recorder.saveModelsCache(this.availableModels);
        logger.info({ count: this.availableModels.length }, 'Modelos carregados');
        this.displayModels();
      }
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Nao foi possivel buscar modelos');
    }
  }

  private displayModels(): void {
    if (!this.availableModels.length) return;
    logger.info('Modelos disponiveis:');
    this.availableModels.slice(0, 10).forEach(m => {
      logger.info({ model: m.id, tokens: (m as any).max_input_tokens || '?' });
    });
  }

  async getAvailableModels(): Promise<ModelInfo[]> { return this.availableModels; }
  getDefaultModel(): string { return this.availableModels[0]?.id || DEFAULT_MODEL; }

  private async fillField(selectors: string[], value: string, fieldName: string): Promise<boolean> {
    for (const selector of selectors) {
      const element = await this.page!.$(selector);
      if (element && await element.isVisible()) {
        await element.fill(value);
        logger.info({ field: fieldName }, 'Campo preenchido');
        return true;
      }
    }
    return false;
  }

  private async clickSubmit(): Promise<void> {
    const selectors = ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Login")', 'button:has-text("Entrar")'];
    for (const selector of selectors) {
      const button = await this.page!.$(selector);
      if (button && await button.isVisible()) {
        await button.click();
        logger.info('Botao de login clicado');
        return;
      }
    }
  }

  private getEnvConfig(): { username: string; password: string } | null {
    const username = process.env[ENV_USER];
    const password = process.env[ENV_PASS];
    if (!username || !password) return null;
    return { username, password };
  }

  private async saveCredentialsFromPage(): Promise<void> {
    try {
      const username = await this.page!.$eval('input:not([type="password"])', (el: HTMLInputElement) => el.value).catch(() => null);
      const password = await this.page!.$eval('input[type="password"]', (el: HTMLInputElement) => el.value).catch(() => null);
      if (username && password) await this.updateEnvFile(username, password);
    } catch {}
  }

  private async updateEnvFile(username: string, password: string): Promise<void> {
    const envPath = path.join(process.cwd(), '.env');
    let content = '';
    try { content = await fs.readFile(envPath, 'utf-8'); } catch {}
    const updates: Record<string, string> = { [ENV_USER]: username, [ENV_PASS]: password };
    for (const [key, value] of Object.entries(updates)) {
      const regex = new RegExp(`^${key}=.*`, 'm');
      if (regex.test(content)) content = content.replace(regex, `${key}=${value}`);
      else content += content ? `\n${key}=${value}` : `${key}=${value}`;
    }
    if (!content.includes('CARCARA_URL=')) content += `\nCARCARA_URL=${this.config.baseUrl}`;
    await fs.writeFile(envPath, content.trim() + '\n', 'utf-8');
    logger.info('Credenciais salvas no .env');
  }

  private isOnLoginPage(): boolean {
    return this.page?.url().includes('/login') ?? true;
  }

  private async executeInBrowser(fn: string, arg?: any): Promise<any> {
    if (!this.page || this.page.isClosed()) throw new Error('Pagina nao disponivel');
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.page.evaluate(fn, arg);
      } catch (error: any) {
        if (error.message?.includes('Execution context was destroyed') && attempt < MAX_RETRIES) {
          await this.page.waitForTimeout(TIMEOUT_RETRY);
          continue;
        }
        throw error;
      }
    }
    throw new Error('Falha na execucao no browser');
  }

  async getConversations(): Promise<ConversationNode[]> {
    this.ensureInitialized();
    try {
      const result = await this.executeInBrowser(`
        async () => {
          return new Promise((resolve, reject) => {
            const request = indexedDB.open('${DB_NAME}');
            request.onerror = () => reject(request.error);
            request.onupgradeneeded = () => {
              const db = request.result;
              if (!db.objectStoreNames.contains('${DB_STORE_CONVERSATIONS}')) {
                db.createObjectStore('${DB_STORE_CONVERSATIONS}', { keyPath: 'id' });
              }
            };
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction('${DB_STORE_CONVERSATIONS}', 'readonly');
              const store = tx.objectStore('${DB_STORE_CONVERSATIONS}');
              const req = store.getAll();
              req.onsuccess = () => resolve(req.result || []);
              req.onerror = () => reject(req.error);
            };
          });
        }
      `);
      return Array.isArray(result) ? result : [];
    } catch (error: any) {
      logger.error({ error: error.message }, 'Erro ao buscar conversas');
      return [];
    }
  }

  async saveConversation(conversation: ConversationNode): Promise<void> {
    this.ensureInitialized();
    await this.executeInBrowser(`
      async (conversation) => {
        return new Promise((resolve, reject) => {
          const request = indexedDB.open('${DB_NAME}');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('${DB_STORE_CONVERSATIONS}', 'readwrite');
            const store = tx.objectStore('${DB_STORE_CONVERSATIONS}');
            store.put(conversation);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          };
        });
      }
    `, conversation);
  }

  async getConversationMessages(convId: string): Promise<LlamaMessage[]> {
    this.ensureInitialized();
    try {
      const result = await this.executeInBrowser(`
        async (convId) => {
          return new Promise((resolve, reject) => {
            const request = indexedDB.open('${DB_NAME}');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction('${DB_STORE_MESSAGES}', 'readonly');
              const store = tx.objectStore('${DB_STORE_MESSAGES}');
              const index = store.index('convId');
              const req = index.getAll(convId);
              req.onsuccess = () => resolve(req.result || []);
              req.onerror = () => reject(req.error);
            };
          });
        }
      `, convId);
      return Array.isArray(result) ? result : [];
    } catch (error: any) {
      logger.error({ error: error.message }, 'Erro ao buscar mensagens');
      return [];
    }
  }

  async saveMessage(message: LlamaMessage): Promise<void> {
    this.ensureInitialized();
    await this.executeInBrowser(`
      async (message) => {
        return new Promise((resolve, reject) => {
          const request = indexedDB.open('${DB_NAME}');
          request.onerror = () => reject(request.error);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('${DB_STORE_MESSAGES}')) {
              const store = db.createObjectStore('${DB_STORE_MESSAGES}', { keyPath: 'id', autoIncrement: true });
              store.createIndex('convId', 'convId', { unique: false });
            }
          };
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('${DB_STORE_MESSAGES}', 'readwrite');
            const store = tx.objectStore('${DB_STORE_MESSAGES}');
            store.put(message);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          };
        });
      }
    `, message);
  }

  async createNewConversation(title?: string): Promise<string> {
    this.ensureInitialized();
    const id = crypto.randomUUID ? crypto.randomUUID() : `conv_${Date.now()}`;
    const conversation: ConversationNode = {
      id, name: title || DEFAULT_TITLE,
      lastModified: Date.now(), currNode: null, thinkingEnabled: true,
    };
    const systemMsg: LlamaMessage = {
      id: crypto.randomUUID ? crypto.randomUUID() : `msg_${Date.now()}`,
      convId: id, role: 'system', type: 'root', content: '', children: [], timestamp: Date.now(),
    };
    await this.saveConversation(conversation);
    await this.saveMessage(systemMsg);
    this.currentConversationId = id;
    logger.info({ id, title }, 'Conversa criada');
    return id;
  }

  async chatCompletionStream(prompt: string, model?: string, tools?: any[]): Promise<Readable> {
    this.ensureInitialized();
    if (!this.currentConversationId) await this.createNewConversation();

    const modelToUse = model || this.getDefaultModel();
    const convId = this.currentConversationId!;

    const conversations = await this.getConversations();
    const conv = conversations.find(c => c.id === convId);
    const parentId = conv?.currNode || null;

    const userMsgId = crypto.randomUUID ? crypto.randomUUID() : `msg_${Date.now()}`;
    const userMsg: LlamaMessage = {
      id: userMsgId, convId, role: 'user', type: 'text', content: prompt,
      parent: parentId, children: [], timestamp: Date.now(),
    };
    await this.saveMessage(userMsg);
    if (parentId) await this.addChildToMessage(parentId, userMsgId);

    const enrichedPrompt = await this.thinkingService.executeSandbox(prompt);

    const payload: any = {
      model: modelToUse, messages: [{ role: 'user', content: enrichedPrompt }],
      stream: true, temperature: DEFAULT_TEMPERATURE, max_tokens: DEFAULT_MAX_TOKENS,
      return_progress: true, backend_sampling: false, timings_per_token: true,
    };

    this.thinkingService.applyToPayload(payload);
    if (tools?.length) payload.tools = tools;

    logger.info({ model: modelToUse }, 'Streaming para modelo');

    const response = await this.axiosInstance.post(CHAT_API, payload, {
      baseURL: this.config.apiBaseUrl, timeout: TIMEOUT_CHAT, responseType: 'stream',
    });

    let fullContent = '';
    let assistantMsgId = '';
    let completionId = '';
    let finishReason = '';
    let timings: any = null;

    const sourceStream = response.data as Readable;
    const passThrough = new Readable({ read() {} });

    sourceStream.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') { passThrough.push(chunk); continue; }
        try {
          const parsed = JSON.parse(data);
          if (parsed.id && !completionId) completionId = parsed.id;
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) fullContent += delta.content;
          const fr = parsed.choices?.[0]?.finish_reason;
          if (fr) finishReason = fr;
          if (parsed.timings) timings = parsed.timings;
        } catch {}
        passThrough.push(chunk);
      }
    });

    sourceStream.on('end', async () => {
      passThrough.push(null);
      assistantMsgId = crypto.randomUUID ? crypto.randomUUID() : `msg_${Date.now()}`;
      const assistantMsg: LlamaMessage = {
        id: assistantMsgId, convId, role: 'assistant', type: 'text',
        content: fullContent, parent: userMsgId, children: [],
        timestamp: Date.now(), model: modelToUse,
        completionId: completionId || '', timings, toolCalls: '',
      };
      await this.saveMessage(assistantMsg);
      await this.addChildToMessage(userMsgId, assistantMsgId);

      if (conv) {
        conv.currNode = assistantMsgId;
        conv.lastModified = Date.now();
        await this.saveConversation(conv);
      }

      try {
        const chatDir = path.join(process.cwd(), '.carcara', 'chats');
        await fs.mkdir(chatDir, { recursive: true });
        const filePath = path.join(chatDir, `${convId}.jsonl`);
        const entry = JSON.stringify({ timestamp: new Date().toISOString(), model: modelToUse, role: 'user', content: prompt }) + '\n';
        const respEntry = JSON.stringify({ timestamp: new Date().toISOString(), model: modelToUse, role: 'assistant', content: fullContent, completionId, finishReason }) + '\n';
        await fs.appendFile(filePath, entry + respEntry, 'utf-8');
      } catch (e: any) {
        logger.warn({ error: e.message }, 'Erro ao salvar arquivo');
      }

      logger.info({ chars: fullContent.length, finishReason }, 'Stream completo');
    });

    sourceStream.on('error', (err: any) => { passThrough.destroy(err); });
    return passThrough;
  }

  async chatCompletionWithContinue(prompt: string, model?: string, tools?: any[]): Promise<ChatCompletionResponse> {
    this.ensureInitialized();
    let fullContent = '';
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let attempts = 0;
    const MAX_CONTINUES = 5;
    let lastCompletionId = '';
    let lastTimings: any = null;
    let lastToolCalls: ToolCall[] | undefined;

    while (attempts < MAX_CONTINUES) {
      const currentPrompt = attempts === 0
        ? prompt
        : `Continue exactly from where you stopped. Do not repeat what was already said.\n\nPrevious output:\n${fullContent.slice(-3000)}`;

      const response = await this.chatCompletion(currentPrompt, model, tools);
      const choice = response.choices[0];
      const content = choice.message.content || '';
      fullContent += content;
      lastCompletionId = response.id;
      lastTimings = response.timings;
      lastToolCalls = choice.message.tool_calls;
      totalPromptTokens += response.usage?.prompt_tokens || 0;
      totalCompletionTokens += response.usage?.completion_tokens || 0;

      if (choice.finish_reason !== 'length') break;
      attempts++;
      logger.info({ attempt: attempts, chars: fullContent.length }, 'Continue generation');
    }

    return {
      id: lastCompletionId || `chatcmpl-${Date.now()}`,
      object: 'chat.completion', created: Math.floor(Date.now() / 1000),
      model: model || this.getDefaultModel(),
      choices: [{
        index: 0, message: { role: 'assistant', content: fullContent, tool_calls: lastToolCalls },
        finish_reason: attempts > 0 ? 'stop' : (lastToolCalls?.length ? 'tool_calls' : 'stop'),
      }],
      usage: { prompt_tokens: totalPromptTokens, completion_tokens: totalCompletionTokens, total_tokens: totalPromptTokens + totalCompletionTokens },
    };
  }

  async chatCompletion(prompt: string, model?: string, tools?: any[]): Promise<ChatCompletionResponse> {
    this.ensureInitialized();
    if (!this.currentConversationId) await this.createNewConversation();

    const modelToUse = model || this.getDefaultModel();
    const convId = this.currentConversationId!;

    const conversations = await this.getConversations();
    const conv = conversations.find(c => c.id === convId);
    const parentId = conv?.currNode || null;

    const userMsgId = crypto.randomUUID ? crypto.randomUUID() : `msg_${Date.now()}`;
    const userMsg: LlamaMessage = {
      id: userMsgId, convId, role: 'user', type: 'text', content: prompt,
      parent: parentId, children: [], timestamp: Date.now(),
    };
    await this.saveMessage(userMsg);
    if (parentId) await this.addChildToMessage(parentId, userMsgId);

    const enrichedPrompt = await this.thinkingService.executeSandbox(prompt);

    const payload: any = {
      model: modelToUse, messages: [{ role: 'user', content: enrichedPrompt }],
      stream: false, temperature: DEFAULT_TEMPERATURE, max_tokens: DEFAULT_MAX_TOKENS,
      return_progress: true, backend_sampling: false, timings_per_token: false,
    };

    this.thinkingService.applyToPayload(payload);
    if (tools?.length) payload.tools = tools;

    logger.info({ model: modelToUse }, 'Enviando para modelo');

    const response = await this.axiosInstance.post(CHAT_API, payload, {
      baseURL: this.config.apiBaseUrl, timeout: TIMEOUT_CHAT,
    });

    const choice = response.data.choices[0];
    const assistantMsgId = crypto.randomUUID ? crypto.randomUUID() : `msg_${Date.now()}`;
    const assistantMsg: LlamaMessage = {
      id: assistantMsgId, convId, role: 'assistant', type: 'text',
      content: choice.message.content || '', parent: userMsgId, children: [],
      timestamp: Date.now(), model: modelToUse,
      completionId: response.data.id || '',
      timings: choice.timings || response.data.timings,
      toolCalls: choice.message.tool_calls ? JSON.stringify(choice.message.tool_calls) : '',
    };
    await this.saveMessage(assistantMsg);
    await this.addChildToMessage(userMsgId, assistantMsgId);

    if (conv) {
      conv.currNode = assistantMsgId;
      conv.lastModified = Date.now();
      await this.saveConversation(conv);
    }

    try {
      const chatDir = path.join(process.cwd(), '.carcara', 'chats');
      await fs.mkdir(chatDir, { recursive: true });
      const filePath = path.join(chatDir, `${convId}.jsonl`);
      const entry = JSON.stringify({ timestamp: new Date().toISOString(), model: modelToUse, role: 'user', content: prompt }) + '\n';
      const responseEntry = JSON.stringify({
        timestamp: new Date().toISOString(), model: modelToUse, role: 'assistant',
        content: choice.message.content, toolCalls: choice.message.tool_calls || null,
        completionId: response.data.id, timings: choice.timings || response.data.timings,
      }) + '\n';
      await fs.appendFile(filePath, entry + responseEntry, 'utf-8');
      logger.info({ file: `${convId}.jsonl` }, 'Mensagens appendadas');
    } catch (e: any) {
      logger.warn({ error: e.message }, 'Erro ao salvar arquivo');
    }

    logger.info('Resposta salva no IndexedDB');
    return response.data;
  }


  /**
   * Envia um array de mensagens completo para o modelo.
   * Usado pelo ChatUseCase para tool calling nativo com histórico.
   */
  async chatCompletionMessages(
    messages: any[],
    model?: string,
    tools?: any[]
  ): Promise<ChatCompletionResponse> {
    this.ensureInitialized();

    const modelToUse = model || this.getDefaultModel();
    const convId = this.currentConversationId || `conv_${Date.now()}`;

    const payload: any = {
      model: modelToUse,
      messages,
      stream: false,
      temperature: DEFAULT_TEMPERATURE,
      max_tokens: DEFAULT_MAX_TOKENS,
      return_progress: true,
      backend_sampling: false,
      timings_per_token: false,
    };

    this.thinkingService.applyToPayload(payload);
    if (tools?.length) payload.tools = tools;

    logger.info(
      { model: modelToUse, msgCount: messages.length, toolCount: tools?.length || 0 },
      'Enviando messages array para modelo'
    );

    const response = await this.axiosInstance.post(CHAT_API, payload, {
      baseURL: this.config.apiBaseUrl,
      timeout: TIMEOUT_CHAT,
    });

    const choice = response.data.choices[0];

    // Persiste no IndexedDB (melhor esforço)
    try {
      const lastUser = messages.filter((m: any) => m.role === 'user').pop();
      if (lastUser) {
        const userMsgId = crypto.randomUUID
          ? crypto.randomUUID()
          : `msg_${Date.now()}`;
        await this.saveMessage({
          id: userMsgId,
          convId,
          role: 'user',
          type: 'text',
          content:
            typeof lastUser.content === 'string'
              ? lastUser.content
              : JSON.stringify(lastUser.content),
          parent: null,
          children: [],
          timestamp: Date.now(),
        } as any);

        const assistantMsgId = crypto.randomUUID
          ? crypto.randomUUID()
          : `msg_${Date.now()}`;
        await this.saveMessage({
          id: assistantMsgId,
          convId,
          role: 'assistant',
          type: 'text',
          content: choice.message.content || '',
          parent: userMsgId,
          children: [],
          timestamp: Date.now(),
          model: modelToUse,
          completionId: response.data.id || '',
          timings: choice.timings || response.data.timings,
          toolCalls: choice.message.tool_calls
            ? JSON.stringify(choice.message.tool_calls)
            : '',
        } as any);
        await this.addChildToMessage(userMsgId, assistantMsgId);
      }
    } catch (dbErr: any) {
      logger.warn({ error: dbErr.message }, 'Falha ao persistir messages no IndexedDB');
    }

    return {
      id: response.data.id || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelToUse,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: choice.message.content || '',
            tool_calls: choice.message.tool_calls,
          },
          finish_reason:
            choice.finish_reason ||
            (choice.message.tool_calls?.length ? 'tool_calls' : 'stop'),
        },
      ],
      usage: response.data.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
  }

  async addChildToMessage(parentId: string | number, childId: string | number): Promise<void> {
    this.ensureInitialized();
    await this.executeInBrowser(`
      async (args) => {
        const [parentId, childId] = args;
        return new Promise((resolve, reject) => {
          const request = indexedDB.open('${DB_NAME}');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('${DB_STORE_MESSAGES}', 'readwrite');
            const store = tx.objectStore('${DB_STORE_MESSAGES}');
            const getReq = store.get(parentId);
            getReq.onsuccess = () => {
              const msg = getReq.result;
              if (msg) {
                if (!msg.children) msg.children = [];
                if (!msg.children.includes(childId)) {
                  msg.children.push(childId);
                  store.put(msg);
                }
              }
              resolve();
            };
            getReq.onerror = () => reject(getReq.error);
          };
        });
      }
    `, [parentId, childId]);
  }

  async getMessageTree(convId: string): Promise<LlamaMessage[]> {
    this.ensureInitialized();
    const messages = await this.getConversationMessages(convId);
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }

  async getMessageById(msgId: string | number): Promise<LlamaMessage | null> {
    this.ensureInitialized();
    const result = await this.executeInBrowser(`
      async (msgId) => {
        return new Promise((resolve, reject) => {
          const request = indexedDB.open('${DB_NAME}');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('${DB_STORE_MESSAGES}', 'readonly');
            const store = tx.objectStore('${DB_STORE_MESSAGES}');
            const getReq = store.get(msgId);
            getReq.onsuccess = () => resolve(getReq.result || null);
            getReq.onerror = () => reject(getReq.error);
          };
        });
      }
    `, msgId);
    return result as LlamaMessage | null;
  }

  async callMcpTool(serverId: string, method: string, params: any = {}): Promise<any> {
    this.ensureInitialized();
    const response = await this.axiosInstance.post(
      `${MCP_API}/${serverId}`,
      { jsonrpc: '2.0', id: 1, method, params }
    );
    return response.data;
  }

  async listSdumontTools(): Promise<MCPListResponse | null> {
    try {
      logger.info('Listando ferramentas MCP');
      const result = await this.callMcpTool('lncc-sdumont', 'tools/list', {});
      logger.info({ count: result.result?.tools?.length || 0 }, 'Ferramentas encontradas');
      return result as MCPListResponse;
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Nao foi possivel listar ferramentas');
      return null;
    }
  }

  private async cleanup(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      logger.info('Navegador fechado');
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isInitialized = false;
  }

  private ensureInitialized(): void {
    if (!this.isInitialized || !this.page) {
      throw new Error('Cliente nao inicializado. Execute init() primeiro.');
    }
  }

  get isReady(): boolean {
    return this.isInitialized && !this.page?.isClosed();
  }

  get activeConversationId(): string | null {
    return this.currentConversationId;
  }

  get models(): ModelInfo[] {
    return this.availableModels;
  }

  get llamaUI(): LlamaUIConfigService {
    if (this.page && !this.page.isClosed()) this.llamaUIConfig.setPage(this.page);
    return this.llamaUIConfig;
  }

  async close(): Promise<void> {
    await this.cleanup();
  }
}
