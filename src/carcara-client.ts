import { chromium, Browser, BrowserContext, Page } from 'playwright';
import axios, { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import pino from 'pino';
import { LlamaUIConfigService } from './llama-ui-config.js';
import {
  CarcaraConfig, LlamaMessage, ConversationNode, ChatCompletionResponse,
  MCPListResponse, LoginPayload, ModelInfo, LoginScript, LoginStep, StoredSession
} from './types.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// ============================================================================
// CONSTANTES
// ============================================================================

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
// LOGGER / RECORDER (async, non-blocking)
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
      version: '2.0',
      url: CARCARA_BASE_URL,
      createdAt: new Date().toISOString(),
      steps: this.steps,
      successIndicators: {
        cookieNames: ['PHPSESSID', 'carcara_auth'],
        responseStatus: 200,
      },
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
        token: token || '',
        cookies: cookies as any,
        phpsessid,
        timestamp: Date.now(),
      };

      if (carcaraAuth) {
        (session as any).carcaraAuth = carcaraAuth;
      }

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

    this.config = {
      baseUrl,
      apiBaseUrl: config.apiBaseUrl || `${baseUrl}${SERVICE_PATH}`,
      domain,
    };

    this.axiosInstance = this.createAxiosInstance();
    this.recorder = new LoginRecorder();
    this.llamaUIConfig = new LlamaUIConfigService();
  }

  // UMA unica instancia Axios com interceptor de cookies
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

    // Interceptor injeta cookies automaticamente
    instance.interceptors.request.use(async (cfg: InternalAxiosRequestConfig) => {
      if (!cfg.headers) cfg.headers = new axios.AxiosHeaders();
      const cookies = await this.getCookieString();
      if (cookies) {
        cfg.headers.set('Cookie', cookies);
      }
      return cfg;
    });

    return instance;
  }

  // Cache de cookie string (invalidado a cada 5s ou quando muda)
  private async getCookieString(): Promise<string> {
    if (!this.context || this.page?.isClosed()) return this.cookieStringCache;

    const now = Date.now();
    if (now - this.cookieStringCacheTime < 5000 && this.cookieStringCache) {
      return this.cookieStringCache;
    }

    const cookies = await this.context.cookies([this.config.baseUrl]);
    this.cookieStringCache = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    this.cookieStringCacheTime = now;
    return this.cookieStringCache;
  }

  private invalidateCookieCache(): void {
    this.cookieStringCache = '';
    this.cookieStringCacheTime = 0;
  }

  // ==========================================================================
  // INICIALIZACAO
  // ==========================================================================

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

  async close(): Promise<void> {
    await this.cleanup();
  }

  // ==========================================================================
  // NAVEGADOR
  // ==========================================================================

  public tryParseJSON(text: string): any {
    try { return JSON.parse(text); } catch { return text; }
  }

  private async launchBrowser(): Promise<void> {
    logger.info('Iniciando navegador em modo silencioso');

    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    });

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(TIMEOUT_NAVIGATION);

    // Intercepta trafego do chat (async, nao bloqueante)
    this.page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/v1/chat/completions') && response.request().method() === 'POST') {
        this.saveTraffic(response).catch(() => {});
      }
    });

    logger.info('Navegador iniciado');
  }

  private async saveTraffic(response: any): Promise<void> {
    try {
      const requestBody = response.request().postData();
      const responseBody = await response.text();
      const chatDir = path.join(process.cwd(), '.carcara', 'chats');
      await fs.mkdir(chatDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = path.join(chatDir, `traffic_${timestamp}.json`);

      const data = {
        timestamp: new Date().toISOString(),
        url,
        status: response.status(),
        request: requestBody ? this.tryParseJSON(requestBody) : null,
        response: this.tryParseJSON(responseBody),
      };

      await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
      logger.info({ file: `traffic_${timestamp}.json` }, 'Trafego salvo');
    } catch {
      // Silencioso
    }
  }

  private async navigateToService(): Promise<void> {
    logger.info('Navegando para /service/');

    const serviceUrl = `${this.config.baseUrl}${SERVICE_PATH}/`;
    const url = this.authToken ? `${serviceUrl}?token=${this.authToken}` : serviceUrl;

    await this.page!.goto(url, { waitUntil: 'networkidle', timeout: TIMEOUT_NAVIGATION });
    await this.page!.waitForTimeout(3000);

    const cookies = await this.context!.cookies([this.config.baseUrl]);
    const carcaraAuthCookie = cookies.find(c => c.name === 'carcara_auth');
    if (carcaraAuthCookie) {
      this.carcaraAuth = carcaraAuthCookie.value;
      logger.info({ auth: this.carcaraAuth.slice(0, 15) }, 'carcara_auth obtido');
    }

    const phpsessidCookie = cookies.find(c => c.name === 'PHPSESSID');
    if (phpsessidCookie) {
      this.phpsessid = phpsessidCookie.value;
    }

    this.invalidateCookieCache();
    await this.recorder.saveSession(this.page!, this.authToken || undefined);
  }

  // ==========================================================================
  // AUTENTICACAO
  // ==========================================================================

  private async handleAuthentication(): Promise<void> {
    logger.info('Verificando sessao salva');
    const restoredSession = await this.recorder.restoreSession(this.page!);

    if (restoredSession) {
      this.phpsessid = restoredSession.phpsessid || null;
      this.authToken = restoredSession.token || null;
      this.carcaraAuth = (restoredSession as any).carcaraAuth || null;
      this.invalidateCookieCache();

      const currentUrl = this.page!.url();
      if (!currentUrl.includes('/login')) {
        logger.info('Sessao restaurada com sucesso');
        return;
      }
      logger.warn('Sessao expirada, refazendo login');
    }

    const envConfig = this.getEnvConfig();
    if (envConfig) {
      logger.info('Tentando login via API');
      const apiLoginSuccess = await this.apiLogin(envConfig.username, envConfig.password);
      if (apiLoginSuccess) {
        logger.info('Login via API realizado');
        return;
      }
      logger.warn('Login via API falhou, tentando navegador');
    }

    await this.browserLogin(envConfig);
  }

  private async apiLogin(username: string, password: string): Promise<boolean> {
    try {
      logger.info('Enviando requisicao de login via API');

      await this.page!.goto(this.config.baseUrl, { waitUntil: 'networkidle', timeout: TIMEOUT_NAVIGATION });
      await this.page!.waitForTimeout(2000);

      const cookies = await this.context!.cookies([this.config.baseUrl]);
      const phpsessid = cookies.find(c => c.name === 'PHPSESSID')?.value;
      if (phpsessid) {
        this.phpsessid = phpsessid;
        logger.info({ sessid: phpsessid.slice(0, 10) }, 'PHPSESSID obtido');
      }

      const payload: LoginPayload = {
        action: 'login',
        user: username,
        password: password,
        domain: this.config.domain,
      };

      const response = await this.axiosInstance.post(LOGIN_API, payload, {
        headers: {
          'Cookie': `PHPSESSID=${phpsessid}`,
          'Content-Type': 'application/json;charset=UTF-8',
        },
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

      await this.fillField(
        ['input[name="user"]', 'input[type="text"]', 'input[type="email"]'],
        envConfig.username, 'usuario'
      );
      await this.fillField(
        ['input[type="password"]', 'input[name="password"]'],
        envConfig.password, 'senha'
      );
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

  // ==========================================================================
  // MODELOS (com cache em memoria)
  // ==========================================================================

  private async fetchModels(): Promise<void> {
    logger.info('Buscando modelos disponiveis');

    // Cache em memoria (1h)
    if (Date.now() - this.modelsCacheTime < MODELS_CACHE_TTL && this.availableModels.length) {
      logger.info({ count: this.availableModels.length }, 'Usando cache em memoria');
      return;
    }

    // Cache em disco
    const cachedModels = await this.recorder.loadModelsCache();
    if (cachedModels?.length) {
      this.availableModels = cachedModels;
      this.modelsCacheTime = Date.now();
      this.displayModels();
      return;
    }

    try {
      const response = await this.axiosInstance.get(MODELS_API, {
        baseURL: this.config.apiBaseUrl,
        timeout: TIMEOUT_API,
      });

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

  async getAvailableModels(): Promise<ModelInfo[]> {
    return this.availableModels;
  }

  getDefaultModel(): string {
    return this.availableModels[0]?.id || DEFAULT_MODEL;
  }

  // ==========================================================================
  // AUXILIARES
  // ==========================================================================

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
    const selectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Login")',
      'button:has-text("Entrar")',
    ];
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
      const username = await this.page!.$eval(
        'input:not([type="password"])',
        (el: HTMLInputElement) => el.value
      ).catch(() => null);
      const password = await this.page!.$eval(
        'input[type="password"]',
        (el: HTMLInputElement) => el.value
      ).catch(() => null);

      if (username && password) {
        await this.updateEnvFile(username, password);
      }
    } catch {}
  }

  private async updateEnvFile(username: string, password: string): Promise<void> {
    const envPath = path.join(process.cwd(), '.env');
    let content = '';
    try { content = await fs.readFile(envPath, 'utf-8'); } catch {}

    const updates: Record<string, string> = {
      [ENV_USER]: username,
      [ENV_PASS]: password,
    };

    for (const [key, value] of Object.entries(updates)) {
      const regex = new RegExp(`^${key}=.*`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
      } else {
        content += content ? `\\n${key}=${value}` : `${key}=${value}`;
      }
    }

    if (!content.includes('CARCARA_URL=')) {
      content += `\\nCARCARA_URL=${this.config.baseUrl}`;
    }

    await fs.writeFile(envPath, content.trim() + '\\n', 'utf-8');
    logger.info('Credenciais salvas no .env');
  }

  private isOnLoginPage(): boolean {
    return this.page?.url().includes('/login') ?? true;
  }

  // ==========================================================================
  // INDEXEDDB (mantido - necessario para LlamaUI)
  // ==========================================================================

  private async executeInBrowser(fn: string, arg?: any): Promise<any> {
    if (!this.page || this.page.isClosed()) {
      throw new Error('Pagina nao disponivel');
    }
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
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('${DB_STORE_CONVERSATIONS}')) {
              db.createObjectStore('${DB_STORE_CONVERSATIONS}', { keyPath: 'id' });
            }
          };
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('${DB_STORE_CONVERSATIONS}', 'readwrite');
            tx.objectStore('${DB_STORE_CONVERSATIONS}').put(conversation);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          };
        });
      }
    `, conversation);
  }

  async getConversationMessages(convId: string): Promise<LlamaMessage[]> {
    this.ensureInitialized();
    return this.executeInBrowser(`
      async (convId) => {
        return new Promise((resolve, reject) => {
          const request = indexedDB.open('${DB_NAME}');
          request.onerror = () => reject(request.error);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('${DB_STORE_MESSAGES}')) {
              const store = db.createObjectStore('${DB_STORE_MESSAGES}', { keyPath: 'id' });
              store.createIndex('convId', 'convId', { unique: false });
            }
          };
          request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('${DB_STORE_MESSAGES}')) { resolve([]); return; }
            const tx = db.transaction('${DB_STORE_MESSAGES}', 'readonly');
            const index = tx.objectStore('${DB_STORE_MESSAGES}').index('convId');
            const req = index.getAll(convId);
            req.onsuccess = () => {
              const messages = req.result || [];
              messages.sort((a, b) => a.timestamp - b.timestamp);
              resolve(messages);
            };
            req.onerror = () => reject(req.error);
          };
        });
      }
    `, convId);
  }

  async saveMessage(message: LlamaMessage): Promise<void> {
    this.ensureInitialized();
    await this.executeInBrowser(`
      async (msg) => {
        return new Promise((resolve, reject) => {
          const request = indexedDB.open('${DB_NAME}');
          request.onerror = () => reject(request.error);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('${DB_STORE_MESSAGES}')) {
              const store = db.createObjectStore('${DB_STORE_MESSAGES}', { keyPath: 'id' });
              store.createIndex('convId', 'convId', { unique: false });
            }
          };
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('${DB_STORE_MESSAGES}', 'readwrite');
            tx.objectStore('${DB_STORE_MESSAGES}').put(msg);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          };
        });
      }
    `, message);
  }

  async saveConversationToFile(convId: string): Promise<string> {
    this.ensureInitialized();
    const conversations = await this.getConversations();
    const conv = conversations.find(c => c.id === convId);
    if (!conv) throw new Error('Conversa nao encontrada');

    const messages = await this.getConversationMessages(convId);
    const chatDir = path.join(process.cwd(), '.carcara', 'chats');
    await fs.mkdir(chatDir, { recursive: true });

    const safeName = conv.name.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
    const fileName = `${safeName}_${convId.substring(0, 8)}.json`;
    const filePath = path.join(chatDir, fileName);

    const data = {
      conversa: {
        id: conv.id,
        nome: conv.name,
        data: new Date(conv.lastModified).toISOString(),
        servidoresMCP: conv.mcpServerOverrides?.length || 0,
      },
      mensagens: messages.map(m => ({
        papel: m.role,
        tipo: m.type,
        conteudo: m.content,
        data: new Date(m.timestamp).toISOString(),
      })),
    };

    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    logger.info({ file: filePath }, 'Conversa salva');
    return filePath;
  }

  // ==========================================================================
  // CHAT E MCP
  // ==========================================================================

  async createNewConversation(
    title: string = DEFAULT_TITLE,
    model?: string
  ): Promise<string> {
    this.ensureInitialized();
    const id = crypto.randomUUID ? crypto.randomUUID() : `conv_${Date.now()}`;
    const conversation: ConversationNode = {
      id,
      name: title,
      currNode: id,
      lastModified: Date.now(),
      thinkingEnabled: false,
    };

    const systemMsg: LlamaMessage = {
      id: crypto.randomUUID ? crypto.randomUUID() : `msg_${Date.now()}`,
      convId: id,
      role: 'system',
      type: 'root',
      content: '',
      children: [],
      timestamp: Date.now(),
    };

    await this.saveConversation(conversation);
    await this.saveMessage(systemMsg);
    this.currentConversationId = id;
    logger.info({ id, title }, 'Conversa criada');
    return id;
  }

  async chatCompletion(
    prompt: string,
    model?: string,
    tools?: any[]
  ): Promise<ChatCompletionResponse> {
    this.ensureInitialized();
    if (!this.currentConversationId) {
      await this.createNewConversation();
    }

    const modelToUse = model || this.getDefaultModel();
    const convId = this.currentConversationId!;

    // Busca conversa para saber o currNode (última mensagem ativa)
    const conversations = await this.getConversations();
    const conv = conversations.find(c => c.id === convId);
    const parentId = conv?.currNode || null;

    // Cria mensagem do usuário
    const userMsgId = crypto.randomUUID ? crypto.randomUUID() : `msg_${Date.now()}`;
    const userMsg: LlamaMessage = {
      id: userMsgId,
      convId,
      role: 'user',
      type: 'text',
      content: prompt,
      parent: parentId,
      children: [],
      timestamp: Date.now(),
    };
    await this.saveMessage(userMsg);

    // Atualiza parent (adiciona este userMsg aos children do pai)
    if (parentId) {
      await this.addChildToMessage(parentId, userMsgId);
    }

    const payload: any = {
      model: modelToUse,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      temperature: DEFAULT_TEMPERATURE,
      max_tokens: DEFAULT_MAX_TOKENS,
      return_progress: true,
      reasoning_format: 'auto',
      chat_template_kwargs: { enable_thinking: false },
      reasoning_control: true,
      backend_sampling: false,
      timings_per_token: false,
    };
    if (tools?.length) payload.tools = tools;

    logger.info({ model: modelToUse }, 'Enviando para modelo');

    const response = await this.axiosInstance.post(CHAT_API, payload, {
      baseURL: this.config.apiBaseUrl,
      timeout: TIMEOUT_CHAT,
    });

    const choice = response.data.choices[0];

    // Cria mensagem do assistant com dados reais do modelo
    const assistantMsgId = crypto.randomUUID ? crypto.randomUUID() : `msg_${Date.now()}`;
    const assistantMsg: LlamaMessage = {
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
      toolCalls: choice.message.tool_calls ? JSON.stringify(choice.message.tool_calls) : '',
    };
    await this.saveMessage(assistantMsg);

    // Atualiza userMsg (adiciona assistant como filho)
    await this.addChildToMessage(userMsgId, assistantMsgId);

    // Atualiza conversa: currNode aponta para a resposta do assistant
    if (conv) {
      conv.currNode = assistantMsgId;
      conv.lastModified = Date.now();
      await this.saveConversation(conv);
    }

    // Salva em arquivo unico por conversa (append, nao sobrescreve)
    try {
      const chatDir = path.join(process.cwd(), '.carcara', 'chats');
      await fs.mkdir(chatDir, { recursive: true });
      const filePath = path.join(chatDir, `${convId}.jsonl`);

      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        model: modelToUse,
        role: 'user',
        content: prompt,
      }) + '\n';

      const responseEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        model: modelToUse,
        role: 'assistant',
        content: choice.message.content,
        toolCalls: choice.message.tool_calls || null,
        completionId: response.data.id,
        timings: choice.timings || response.data.timings,
      }) + '\n';

      await fs.appendFile(filePath, entry + responseEntry, 'utf-8');
      logger.info({ file: `${convId}.jsonl` }, 'Mensagens appendadas');
    } catch (e: any) {
      logger.warn({ error: e.message }, 'Erro ao salvar arquivo');
    }

    logger.info('Resposta salva no IndexedDB');
    return response.data;
  }

  // ==========================================================================
  // MANIPULAÇÃO DE ÁRVORE (parent/children)
  // ==========================================================================

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
    // Ordena por timestamp mas mantém estrutura de árvore
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

  // ==========================================================================
  // LIMPEZA
  // ==========================================================================

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
    if (this.page && !this.page.isClosed()) {
      this.llamaUIConfig.setPage(this.page);
    }
    return this.llamaUIConfig;
  }
}
