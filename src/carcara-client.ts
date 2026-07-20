// src/carcara-client.ts - VERSÃO CORRIGIDA E FUNCIONAL
/// <reference lib="dom" />

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { 
  CarcaraConfig, 
  LlamaMessage, 
  ConversationNode, 
  ChatCompletionResponse, 
  MCPListResponse,
  LoginPayload,
  ModelInfo,
  ModelsResponse,
  LoginScript,
  LoginStep,
  StoredSession
} from './types';

dotenv.config();

// ============================================================================
// CONSTANTES (Definidas como variáveis normais, não como objeto)
// ============================================================================

const CARCARA_BASE_URL = process.env.CARCARA_URL || 'https://carcara.sinapad.lncc.br';
const LOGIN_PAGE = '/apps/login/';
const LOGIN_API = '/apps/login/action/loginAction.php';
const SERVICE_PATH = '/service';
const MODELS_API = '/v1/models';
const CHAT_API = '/v1/chat/completions';
const MCP_API = '/mcp';

const DB_NAME = 'LlamaUi';
const DB_STORE_CONVERSATIONS = 'conversations';
const DB_STORE_MESSAGES = 'messages';

const DEFAULT_DOMAIN = 'LNCC';
const DEFAULT_MODEL = 'meta-llama/llama-3.1-70b-instruct';
const DEFAULT_TITLE = 'Nova Conversa LNCC';
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 1024;

const ENV_USER = 'LNCC_USER';
const ENV_PASS = 'LNCC_PASS';

const TIMEOUT_NAVIGATION = 30000;
const TIMEOUT_ELEMENT = 10000;
const TIMEOUT_API = 15000;
const TIMEOUT_RETRY = 1000;
const TIMEOUT_CHAT = 60000;
const TIMEOUT_SESSION_EXPIRY = 24 * 60 * 60 * 1000;
const MAX_RETRIES = 2;

// ============================================================================
// CLASSE DE RECORDER
// ============================================================================

class LoginRecorder {
  private steps: LoginStep[] = [];
  private isRecording = false;
  private readonly basePath: string;

  constructor() {
    this.basePath = path.join(process.cwd(), '.carcara');
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true });
    }
  }

  get scriptPath(): string { return path.join(this.basePath, 'login-script.json'); }
  get sessionPath(): string { return path.join(this.basePath, 'session.json'); }
  get logPath(): string { return path.join(this.basePath, 'login-history.log'); }
  get modelsPath(): string { return path.join(this.basePath, 'models-cache.json'); }

  startRecording(): void {
    this.isRecording = true;
    this.steps = [];
    this.log('🎬 Gravando processo de login...');
  }

  stopRecording(): void {
    this.isRecording = false;
    this.log('⏹️ Gravação finalizada');
  }

  recordStep(step: LoginStep): void {
    if (this.isRecording) {
      this.steps.push(step);
      this.log(`📝 ${step.type}: ${step.description || ''}`);
    }
  }

  saveLoginScript(): void {
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

    fs.writeFileSync(this.scriptPath, JSON.stringify(script, null, 2), 'utf-8');
    this.log(`✅ Script salvo (${this.steps.length} passos)`);
  }

  async saveSession(page: Page, token?: string): Promise<void> {
    try {
      const cookies = await page.context().cookies();
      const phpsessid = cookies.find(c => c.name === 'PHPSESSID')?.value;
      const carcareAuth = cookies.find(c => c.name === 'carcara_auth')?.value;

      const session: StoredSession = {
        token: token || '',
        cookies: cookies as any,
        phpsessid,
        timestamp: Date.now(),
      };

      if (carcareAuth) {
        (session as any).carcaraAuth = carcareAuth;
      }

      fs.writeFileSync(this.sessionPath, JSON.stringify(session, null, 2), 'utf-8');
      this.log('💾 Sessão salva');
      this.log(`   PHPSESSID: ${phpsessid ? phpsessid.substring(0, 10) + '...' : 'N/A'}`);
      this.log(`   carcara_auth: ${carcareAuth ? carcareAuth.substring(0, 10) + '...' : 'N/A'}`);
    } catch (error) {
      this.log(`⚠️ Erro ao salvar sessão: ${error}`);
    }
  }

  async restoreSession(page: Page): Promise<StoredSession | null> {
    try {
      if (!fs.existsSync(this.sessionPath)) {
        return null;
      }

      const session: StoredSession = JSON.parse(
        fs.readFileSync(this.sessionPath, 'utf-8')
      );

      // Verificar expiração
      if (Date.now() - session.timestamp > TIMEOUT_SESSION_EXPIRY) {
        this.log('⚠️ Sessão expirada (>24h)');
        return null;
      }

      // Restaurar cookies
      if (session.cookies && session.cookies.length > 0) {
        await page.context().addCookies(session.cookies as any);
        this.log('🍪 Cookies restaurados');
      }

      // Navegar para a página de serviço (importante para setar tokens)
      const serviceUrl = `${CARCARA_BASE_URL}${SERVICE_PATH}/`;
      if (session.token) {
        await page.goto(`${serviceUrl}?token=${session.token}`, {
          waitUntil: 'networkidle',
          timeout: TIMEOUT_NAVIGATION,
        });
      } else {
        await page.goto(serviceUrl, {
          waitUntil: 'networkidle',
          timeout: TIMEOUT_NAVIGATION,
        });
      }

      await page.waitForTimeout(2000);
      return session;
    } catch (error) {
      this.log(`❌ Erro ao restaurar sessão: ${error}`);
      return null;
    }
  }

  saveModelsCache(models: ModelInfo[]): void {
    const cache = {
      timestamp: Date.now(),
      models,
    };
    fs.writeFileSync(this.modelsPath, JSON.stringify(cache, null, 2), 'utf-8');
    this.log(`💾 Cache de ${models.length} modelos salvo`);
  }

  loadModelsCache(): ModelInfo[] | null {
    try {
      if (fs.existsSync(this.modelsPath)) {
        const cache = JSON.parse(fs.readFileSync(this.modelsPath, 'utf-8'));
        if (Date.now() - cache.timestamp < 60 * 60 * 1000) {
          this.log(`📂 Cache de modelos carregado (${cache.models.length} modelos)`);
          return cache.models;
        }
      }
    } catch {}
    return null;
  }

  log(message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    
    console.log(`  ${message}`);
    fs.appendFileSync(this.logPath, logMessage, 'utf-8');
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
  
  private authToken: string | null = null;
  private phpsessid: string | null = null;
  private carcareAuth: string | null = null;
  private currentConversationId: string | null = null;
  private isInitialized = false;
  private availableModels: ModelInfo[] = [];

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
  }

  private createAxiosInstance(): AxiosInstance {
    return axios.create({
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
  }

  // ==========================================================================
  // INICIALIZAÇÃO PRINCIPAL
  // ==========================================================================

  async init(): Promise<void> {
    if (this.isInitialized) {
      console.log('ℹ️ Cliente já inicializado');
      return;
    }

    console.log('🚀 Iniciando Carcara Client...');
    console.log(`   URL: ${this.config.baseUrl}`);
    console.log(`   Domínio: ${this.config.domain}`);

    try {
      await this.launchBrowser();
      await this.handleAuthentication();
      
      // IMPORTANTE: Navegar para /service/ para setar cookies corretos
      await this.navigateToService();
      
      await this.fetchModels();
      
      this.isInitialized = true;
      console.log('✅ Carcara Client inicializado com sucesso!');
    } catch (error) {
      console.error('❌ Falha na inicialização:', error);
      await this.cleanup();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.cleanup();
  }

  // ==========================================================================
  // GERENCIAMENTO DO NAVEGADOR
  // ==========================================================================

    private async launchBrowser(): Promise<void> {
    console.log('🌐 Iniciando navegador em modo silencioso...');
    
    this.browser = await chromium.launch({ 
        headless: true, // MUDAR PARA TRUE - modo silencioso
        args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--no-first-run',
        '--disable-default-apps',
        '--hide-scrollbars',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-zygote',
        ],
    });
    
    this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    });
    
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(TIMEOUT_NAVIGATION);
    
    console.log('✅ Navegador iniciado em background');
    }

  // ==========================================================================
  // NAVEGAÇÃO PARA /SERVICE/ (IMPORTANTE PARA SETAR COOKIES)
  // ==========================================================================

  private async navigateToService(): Promise<void> {
    console.log('🔗 Navegando para /service/ para inicializar sessão...');
    
    const serviceUrl = `${this.config.baseUrl}${SERVICE_PATH}/`;
    
    // Se tem token, usar ele
    if (this.authToken) {
      await this.page!.goto(`${serviceUrl}?token=${this.authToken}`, {
        waitUntil: 'networkidle',
        timeout: TIMEOUT_NAVIGATION,
      });
    } else {
      await this.page!.goto(serviceUrl, {
        waitUntil: 'networkidle',
        timeout: TIMEOUT_NAVIGATION,
      });
    }

    await this.page!.waitForTimeout(3000);

    // Atualizar cookies após navegar para /service/
    const cookies = await this.context!.cookies([this.config.baseUrl]);
    const carcareAuthCookie = cookies.find(c => c.name === 'carcara_auth');
    
    if (carcareAuthCookie) {
      this.carcareAuth = carcareAuthCookie.value;
      console.log(`🔑 carcara_auth: ${this.carcareAuth.substring(0, 15)}...`);
    } else {
      console.log('⚠️ Cookie carcara_auth não encontrado após navegar para /service/');
    }

    // Atualizar PHPSESSID
    const phpsessidCookie = cookies.find(c => c.name === 'PHPSESSID');
    if (phpsessidCookie) {
      this.phpsessid = phpsessidCookie.value;
    }

    // Salvar sessão atualizada
    await this.recorder.saveSession(this.page!, this.authToken || undefined);
  }

  // ==========================================================================
  // AUTENTICAÇÃO VIA API DIRETA
  // ==========================================================================

  private async handleAuthentication(): Promise<void> {
    // 1. Tentar restaurar sessão
    console.log('🔍 Verificando sessão salva...');
    const restoredSession = await this.recorder.restoreSession(this.page!);
    
    if (restoredSession) {
      this.phpsessid = restoredSession.phpsessid || null;
      this.authToken = restoredSession.token || null;
      this.carcareAuth = (restoredSession as any).carcaraAuth || null;
      
      // Verificar se está logado
      const currentUrl = this.page!.url();
      if (!currentUrl.includes('/login')) {
        console.log('✅ Sessão restaurada com sucesso!');
        return;
      }
      
      console.log('⚠️ Sessão expirada, precisa fazer login novamente');
    }

    // 2. Login via API direta
    const envConfig = this.getEnvConfig();
    
    if (envConfig) {
      console.log('🔐 Tentando login via API...');
      const apiLoginSuccess = await this.apiLogin(envConfig.username, envConfig.password);
      
      if (apiLoginSuccess) {
        console.log('✅ Login via API realizado com sucesso!');
        return;
      }
      
      console.log('⚠️ Login via API falhou, tentando via navegador...');
    }

    // 3. Login via navegador (fallback)
    await this.browserLogin(envConfig);
  }

  private async apiLogin(username: string, password: string): Promise<boolean> {
    try {
      console.log('📡 Enviando requisição de login via API...');
      
      // Navegar para página principal para obter PHPSESSID
      await this.page!.goto(this.config.baseUrl, { 
        waitUntil: 'networkidle',
        timeout: TIMEOUT_NAVIGATION,
      });
      
      await this.page!.waitForTimeout(2000);
      
      // Extrair PHPSESSID
      const cookies = await this.context!.cookies([this.config.baseUrl]);
      const phpsessid = cookies.find(c => c.name === 'PHPSESSID')?.value;
      
      if (phpsessid) {
        this.phpsessid = phpsessid;
        console.log(`🔑 PHPSESSID: ${phpsessid.substring(0, 10)}...`);
      }

      // Requisição de login
      const payload: LoginPayload = {
        action: 'login',
        user: username,
        password: password,
        domain: this.config.domain,
      };

      // Usar o axios da página para manter os cookies
      const response = await this.axiosInstance.post(
        LOGIN_API,
        payload,
        {
          headers: {
            'Cookie': `PHPSESSID=${phpsessid}`,
            'Content-Type': 'application/json;charset=UTF-8',
            'Accept': 'application/json, text/plain, */*',
          },
          timeout: TIMEOUT_API,
        }
      );

      console.log(`📥 Resposta: Status ${response.status}`);
      console.log(`   Data: ${JSON.stringify(response.data)}`);

      if (response.status === 200 && response.data?.status === 'OK') {
        // Aguardar um momento para os cookies serem setados
        await this.page!.waitForTimeout(2000);
        
        // Recarregar a página para obter cookies atualizados
        await this.page!.reload({ waitUntil: 'networkidle' });
        await this.page!.waitForTimeout(2000);
        
        // Verificar cookies após login
        const updatedCookies = await this.context!.cookies([this.config.baseUrl]);
        const carcareAuthCookie = updatedCookies.find(c => c.name === 'carcara_auth');
        
        if (carcareAuthCookie) {
          this.carcareAuth = carcareAuthCookie.value;
          console.log(`🔑 carcara_auth: ${this.carcareAuth.substring(0, 15)}...`);
        }
        
        // Extrair token da URL se disponível
        const currentUrl = this.page!.url();
        try {
          const urlObj = new URL(currentUrl);
          this.authToken = urlObj.searchParams.get('token') || null;
          if (this.authToken) {
            console.log(`🔑 Token: ${this.authToken.substring(0, 15)}...`);
          }
        } catch {}

        await this.recorder.saveSession(this.page!, this.authToken || undefined);
        return true;
      }

      return false;

    } catch (error: any) {
      console.error('❌ Erro na API de login:', error.message);
      return false;
    }
  }

  // ==========================================================================
  // LOGIN VIA NAVEGADOR (FALLBACK)
  // ==========================================================================

  private async browserLogin(envConfig?: { username: string; password: string } | null): Promise<void> {
    if (envConfig) {
      console.log('🤖 Tentando login automático via navegador...');
      
      const loginUrl = `${this.config.baseUrl}${LOGIN_PAGE}`;
      await this.page!.goto(loginUrl, { waitUntil: 'networkidle' });
      
      // Preencher credenciais
      await this.fillField(
        ['input[name="user"]', 'input[type="text"]', 'input[type="email"]'],
        envConfig.username,
        'usuário'
      );
      
      await this.fillField(
        ['input[type="password"]', 'input[name="password"]'],
        envConfig.password,
        'senha'
      );

      await this.clickSubmit();
      await this.page!.waitForTimeout(3000);
      
      if (!this.isOnLoginPage()) {
        await this.recorder.saveSession(this.page!);
        return;
      }
    }

    // Login manual
    console.log('\n👤 LOGIN MANUAL NECESSÁRIO');
    console.log('═══════════════════════════════');
    console.log('   O navegador abrirá para login');
    console.log('   Após logar, aguarde o programa continuar');
    console.log('═══════════════════════════════\n');

    if (!this.isOnLoginPage()) {
      await this.page!.goto(`${this.config.baseUrl}${LOGIN_PAGE}`, {
        waitUntil: 'networkidle',
      });
    }

    // Aguardar sair da página de login (timeout infinito)
    await this.page!.waitForURL(
      (url) => !url.toString().includes('/login'),
      { timeout: 0 }
    );

    console.log('✅ Login manual detectado!');
    await this.recorder.saveSession(this.page!);
    await this.saveCredentialsFromPage();
  }

  // ==========================================================================
  // BUSCAR MODELOS
  // ==========================================================================

  private async fetchModels(): Promise<void> {
    console.log('📋 Buscando modelos disponíveis...');

    // Tentar cache primeiro
    const cachedModels = this.recorder.loadModelsCache();
    if (cachedModels && cachedModels.length > 0) {
      this.availableModels = cachedModels;
      this.displayModels();
      return;
    }

    try {
      // Usar os cookies da sessão atual
      const cookies = await this.context!.cookies([this.config.baseUrl]);
      const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

      console.log(`🍪 Cookies: ${cookieString.substring(0, 100)}...`);

      const modelsAxios = axios.create({
        baseURL: this.config.apiBaseUrl,
        headers: {
          'Cookie': cookieString,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
          'Origin': this.config.baseUrl,
          'Referer': `${this.config.baseUrl}${SERVICE_PATH}/`,
        },
        validateStatus: () => true,
      });

      const response = await modelsAxios.get<ModelsResponse>(
        MODELS_API,
        { timeout: TIMEOUT_API }
      );

      console.log(`📥 Models Response: Status ${response.status}`);

      if (response.status === 200 && response.data?.data) {
        this.availableModels = response.data.data;
        this.recorder.saveModelsCache(this.availableModels);
        console.log(`✅ ${this.availableModels.length} modelos disponíveis`);
        this.displayModels();
      } else if (response.status === 403) {
        console.log('⚠️ Acesso negado (403) - verificando cookies...');
        
        // Tentar novamente após recarregar a página
        await this.page!.reload({ waitUntil: 'networkidle' });
        await this.page!.waitForTimeout(2000);
        
        const newCookies = await this.context!.cookies([this.config.baseUrl]);
        const newCookieString = newCookies.map(c => `${c.name}=${c.value}`).join('; ');
        
        console.log(`🍪 Novos cookies: ${newCookieString.substring(0, 100)}...`);
        
        const retryResponse = await modelsAxios.get<ModelsResponse>(
          MODELS_API,
          { 
            headers: { 'Cookie': newCookieString },
            timeout: TIMEOUT_API,
          }
        );
        
        if (retryResponse.status === 200 && retryResponse.data?.data) {
          this.availableModels = retryResponse.data.data;
          this.recorder.saveModelsCache(this.availableModels);
          console.log(`✅ ${this.availableModels.length} modelos disponíveis (2ª tentativa)`);
          this.displayModels();
        }
      }
    } catch (error: any) {
      console.warn('⚠️ Não foi possível buscar modelos:', error.message);
      
      // Usar cache expirado se disponível
      try {
        const cachePath = this.recorder.modelsPath;
        if (fs.existsSync(cachePath)) {
          const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
          this.availableModels = cache.models || [];
          console.log(`📂 Usando cache com ${this.availableModels.length} modelos`);
        }
      } catch {}
    }
  }

  private displayModels(): void {
    if (this.availableModels.length === 0) return;
    
    console.log('\n📋 Modelos disponíveis:');
    this.availableModels.slice(0, 10).forEach(model => {
      console.log(`   - ${model.id}`);
    });
    if (this.availableModels.length > 10) {
      console.log(`   ... e mais ${this.availableModels.length - 10}`);
    }
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    return this.availableModels;
  }

  // ==========================================================================
  // MÉTODOS AUXILIARES
  // ==========================================================================

  private async fillField(selectors: string[], value: string, fieldName: string): Promise<boolean> {
    for (const selector of selectors) {
      const element = await this.page!.$(selector);
      if (element && await element.isVisible()) {
        await element.fill(value);
        console.log(`   ✓ ${fieldName} preenchido`);
        return true;
      }
    }
    console.log(`   ✗ Campo ${fieldName} não encontrado`);
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
        console.log('   ✓ Botão de login clicado');
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
        this.updateEnvFile(username, password);
      }
    } catch {}
  }

  private updateEnvFile(username: string, password: string): void {
    const envPath = path.join(process.cwd(), '.env');
    let content = '';

    try {
      content = fs.readFileSync(envPath, 'utf-8');
    } catch {}

    const updates: Record<string, string> = {
      [ENV_USER]: username,
      [ENV_PASS]: password,
    };

    Object.entries(updates).forEach(([key, value]) => {
      const regex = new RegExp(`^${key}=.*`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
      } else {
        content += content ? `\n${key}=${value}` : `${key}=${value}`;
      }
    });

    if (!content.includes('CARCARA_URL=')) {
      content += `\nCARCARA_URL=${this.config.baseUrl}`;
    }

    fs.writeFileSync(envPath, content.trim() + '\n', 'utf-8');
    console.log('💾 Credenciais salvas no .env');
    dotenv.config();
  }

  private isOnLoginPage(): boolean {
    if (!this.page) return true;
    const url = this.page.url();
    return url.includes('/login');
  }

  private getCookieString(): Promise<string> {
    return this.context!.cookies([this.config.baseUrl]).then(
      cookies => cookies.map(c => `${c.name}=${c.value}`).join('; ')
    );
  }

  // ==========================================================================
// MÉTODOS INDEXEDDB (CORRIGIDO - apenas 1 argumento)
// ==========================================================================

private async executeInBrowser<T>(fn: string, arg?: any): Promise<T> {
  if (!this.page || this.page.isClosed()) {
    throw new Error('Página não disponível');
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Playwright só aceita 1 argumento - passar como objeto
      return await this.page.evaluate(fn, arg);
    } catch (error: any) {
      if (error.message?.includes('Execution context was destroyed') && attempt < MAX_RETRIES) {
        await this.page.waitForTimeout(TIMEOUT_RETRY);
        continue;
      }
      throw error;
    }
  }
  throw new Error('Falha na execução no browser');
}

async getConversations(): Promise<ConversationNode[]> {
  this.ensureInitialized();
  
  try {
    const result = await this.executeInBrowser<ConversationNode[]>(`
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
    
    // Garantir que sempre retorna um array
    return Array.isArray(result) ? result : [];
  } catch (error) {
    console.error('Erro ao buscar conversas:', error);
    return [];
  }
}

async saveConversation(conversation: ConversationNode): Promise<void> {
  this.ensureInitialized();
  
  await this.executeInBrowser<void>(`
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

async getConversationMessages(conversationId: string): Promise<LlamaMessage[]> {
  this.ensureInitialized();
  
  return this.executeInBrowser<LlamaMessage[]>(`
    async (conversationId) => {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('${DB_NAME}');
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('${DB_STORE_MESSAGES}')) {
            const store = db.createObjectStore('${DB_STORE_MESSAGES}', { keyPath: 'id' });
            store.createIndex('conversationId', 'conversationId', { unique: false });
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('${DB_STORE_MESSAGES}')) {
            resolve([]);
            return;
          }
          const tx = db.transaction('${DB_STORE_MESSAGES}', 'readonly');
          const index = tx.objectStore('${DB_STORE_MESSAGES}').index('conversationId');
          const req = index.getAll(conversationId);
          req.onsuccess = () => {
            const messages = req.result;
            messages.sort((a, b) => a.timestamp - b.timestamp);
            resolve(messages);
          };
          req.onerror = () => reject(req.error);
        };
      });
    }
  `, conversationId);
}

async saveMessage(message: LlamaMessage, conversationId: string): Promise<void> {
  this.ensureInitialized();
  
  const messageData = { ...message, conversationId };
  await this.executeInBrowser<void>(`
    async (messageData) => {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('${DB_NAME}');
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('${DB_STORE_MESSAGES}')) {
            const store = db.createObjectStore('${DB_STORE_MESSAGES}', { keyPath: 'id' });
            store.createIndex('conversationId', 'conversationId', { unique: false });
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('${DB_STORE_MESSAGES}', 'readwrite');
          tx.objectStore('${DB_STORE_MESSAGES}').put(messageData);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      });
    }
  `, messageData);
}

  // ==========================================================================
  // CHAT E MCP
  // ==========================================================================

  async createNewConversation(
    title: string = DEFAULT_TITLE,
    model: string = DEFAULT_MODEL
  ): Promise<string> {
    this.ensureInitialized();
    
    const id = `conv_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    const conversation: ConversationNode = {
      id,
      name: title,
      currNode: id,
      lasModified: Date.now(),
      model,
      system: '',
    };

    await this.saveConversation(conversation);
    this.currentConversationId = id;
    console.log(`📝 Conversa criada: ${id}`);
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

    const modelToUse = model || DEFAULT_MODEL;
    const cookieString = await this.getCookieString();

    const payload: any = {
      model: modelToUse,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      temperature: DEFAULT_TEMPERATURE,
      max_tokens: DEFAULT_MAX_TOKENS,
    };

    if (tools?.length) payload.tools = tools;

    console.log(`💬 Enviando mensagem para ${modelToUse}...`);

    const chatAxios = axios.create({
      baseURL: this.config.apiBaseUrl,
      headers: {
        'Cookie': cookieString,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': this.config.baseUrl,
        'Referer': `${this.config.baseUrl}${SERVICE_PATH}/`,
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      },
    });

    const response = await chatAxios.post<ChatCompletionResponse>(
      CHAT_API,
      payload,
      { timeout: TIMEOUT_CHAT }
    );

    const choice = response.data.choices[0];
    const aiMessage: LlamaMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      type: choice.message.tool_calls?.length ? 'tool_call' : 'assistant',
      role: choice.message.role,
      timestamp: Date.now(),
      content: choice.message.content || '',
      parentId: this.currentConversationId || undefined,
      children: [],
      tool_calls: choice.message.tool_calls || [],
    };

    await this.saveMessage(aiMessage, this.currentConversationId!);
    console.log('✅ Resposta recebida e salva');
    return response.data;
  }

  async callMcpTool(serverId: string, method: string, params: any = {}): Promise<any> {
    this.ensureInitialized();
    
    const cookieString = await this.getCookieString();

    const mcpAxios = axios.create({
      baseURL: this.config.apiBaseUrl,
      headers: {
        'Cookie': cookieString,
        'Content-Type': 'application/json',
      },
    });

    const response = await mcpAxios.post(
      `${MCP_API}/${serverId}`,
      { jsonrpc: '2.0', id: 1, method, params }
    );

    return response.data;
  }

  async listSdumontTools(): Promise<MCPListResponse | null> {
    try {
      console.log('🛠️ Listando ferramentas MCP...');
      const result = await this.callMcpTool('lncc-sdumont', 'tools/list', {});
      console.log(`✅ ${result.result?.tools?.length || 0} ferramentas encontradas`);
      return result as MCPListResponse;
    } catch (error: any) {
      console.warn('⚠️ Não foi possível listar ferramentas:', error.message);
      return null;
    }
  }

  // ==========================================================================
  // LIMPEZA E VALIDAÇÕES
  // ==========================================================================

  private async cleanup(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      console.log('🛑 Navegador fechado');
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isInitialized = false;
  }

  private ensureInitialized(): void {
    if (!this.isInitialized || !this.page) {
      throw new Error('Cliente não inicializado. Execute init() primeiro.');
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
}