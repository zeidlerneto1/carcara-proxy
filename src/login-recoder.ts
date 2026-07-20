// src/login-recorder.ts
import * as fs from 'fs';
import * as path from 'path';
import { Page } from 'playwright';
import { LoginStep, LoginScript } from './types';

export class LoginRecorder {
  private steps: LoginStep[] = [];
  private isRecording = false;
  private logPath: string;
  private scriptPath: string;
  private sessionPath: string;

  constructor() {
    const logsDir = path.join(process.cwd(), '.carcara');
    
    // Criar diretório se não existir
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    this.logPath = path.join(logsDir, 'login-history.log');
    this.scriptPath = path.join(logsDir, 'login-script.json');
    this.sessionPath = path.join(logsDir, 'session.json');
  }

  // Iniciar gravação
  startRecording(): void {
    this.isRecording = true;
    this.steps = [];
    this.log('🎬 Iniciando gravação do processo de login...');
  }

  // Parar gravação
  stopRecording(): void {
    this.isRecording = false;
    this.log('⏹️ Gravação finalizada');
  }

  // Salvar script de login
  saveLoginScript(successUrlPattern?: string): void {
    const script: LoginScript = {
      version: '1.0',
      url: this.steps[0]?.url || '',
      createdAt: new Date().toISOString(),
      steps: this.steps,
      successUrlPattern: successUrlPattern,
      successIndicators: {
        urlContains: ['/service', '/chat', '/dashboard'],
        cookieNames: ['PHPSESSID', 'carcara_auth', 'token'],
      },
    };

    fs.writeFileSync(this.scriptPath, JSON.stringify(script, null, 2), 'utf-8');
    this.log(`✅ Script de login salvo em: ${this.scriptPath}`);
    this.log(`📝 Total de passos: ${script.steps.length}`);
  }

  // Carregar script existente
  loadLoginScript(): LoginScript | null {
    try {
      if (fs.existsSync(this.scriptPath)) {
        const script = JSON.parse(fs.readFileSync(this.scriptPath, 'utf-8'));
        this.log(`📂 Script de login carregado: ${script.steps.length} passos`);
        return script;
      }
    } catch (error) {
      this.log(`⚠️ Erro ao carregar script: ${error}`);
    }
    return null;
  }

  // Executar script gravado
  async executeScript(page: Page, script: LoginScript): Promise<boolean> {
    this.log('▶️ Executando script de login gravado...');
    
    try {
      for (let i = 0; i < script.steps.length; i++) {
        const step = script.steps[i];
        this.log(`📍 Passo ${i + 1}/${script.steps.length}: ${step.type} - ${step.description || ''}`);
        
        await this.executeStep(page, step);
      }

      // Verificar sucesso
      const success = await this.verifyLoginSuccess(page, script);
      
      if (success) {
        this.log('✅ Login executado com sucesso!');
      } else {
        this.log('❌ Falha ao verificar sucesso do login');
      }
      
      return success;
    } catch (error) {
      this.log(`❌ Erro na execução do script: ${error}`);
      return false;
    }
  }

  // Executar um passo individual
  private async executeStep(page: Page, step: LoginStep): Promise<void> {
    switch (step.type) {
      case 'navigate':
        if (step.url) {
          await page.goto(step.url, { waitUntil: 'networkidle' });
          await page.waitForTimeout(step.timeout || 2000);
        }
        break;

      case 'fill':
        if (step.selector) {
          try {
            await page.waitForSelector(step.selector, { timeout: 10000 });
            await page.fill(step.selector, step.value || '');
            await page.waitForTimeout(500);
          } catch (error) {
            // Tentar seletores alternativos
            if (step.alternativeSelectors) {
              for (const altSelector of step.alternativeSelectors) {
                try {
                  await page.waitForSelector(altSelector, { timeout: 5000 });
                  await page.fill(altSelector, step.value || '');
                  this.log(`   ↳ Usando seletor alternativo: ${altSelector}`);
                  break;
                } catch {}
              }
            }
          }
        }
        break;

      case 'click':
        if (step.selector) {
          try {
            await page.waitForSelector(step.selector, { timeout: 10000 });
            await page.click(step.selector);
            await page.waitForTimeout(step.timeout || 2000);
          } catch (error) {
            if (step.alternativeSelectors) {
              for (const altSelector of step.alternativeSelectors) {
                try {
                  await page.waitForSelector(altSelector, { timeout: 5000 });
                  await page.click(altSelector);
                  this.log(`   ↳ Usando seletor alternativo: ${altSelector}`);
                  break;
                } catch {}
              }
            }
          }
        }
        break;

      case 'wait':
        await page.waitForTimeout(step.timeout || 3000);
        break;

      case 'press':
        if (step.selector && step.value) {
          await page.press(step.selector, step.value);
        }
        break;
    }
  }

  // Verificar se o login foi bem sucedido
  private async verifyLoginSuccess(page: Page, script: LoginScript): Promise<boolean> {
    if (!script.successIndicators) return true;

    try {
      const currentUrl = page.url();
      
      // Verificar padrões de URL
      if (script.successIndicators.urlContains) {
        const urlMatch = script.successIndicators.urlContains.some(pattern => 
          currentUrl.includes(pattern)
        );
        if (urlMatch) {
          this.log(`✓ URL contém padrão de sucesso`);
          return true;
        }
      }

      // Verificar cookies
      if (script.successIndicators.cookieNames) {
        const cookies = await page.context().cookies();
        const hasAuthCookies = script.successIndicators.cookieNames.some(name =>
          cookies.some(c => c.name.includes(name))
        );
        if (hasAuthCookies) {
          this.log(`✓ Cookies de autenticação encontrados`);
          return true;
        }
      }

      // Verificar elemento específico
      if (script.successIndicators.elementSelector) {
        const element = await page.$(script.successIndicators.elementSelector);
        if (element) {
          this.log(`✓ Elemento indicador de sucesso encontrado`);
          return true;
        }
      }

    } catch (error) {
      this.log(`⚠️ Erro na verificação: ${error}`);
    }

    return false;
  }

  // Salvar sessão ativa
  async saveSession(page: Page): Promise<void> {
    try {
      const cookies = await page.context().cookies();
      const url = page.url();
      
      // Extrair token da URL
      const urlObj = new URL(url);
      const token = urlObj.searchParams.get('token') || '';

      const session: StoredSession = {
        token,
        cookies: cookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
        })),
        timestamp: Date.now(),
      };

      fs.writeFileSync(this.sessionPath, JSON.stringify(session, null, 2), 'utf-8');
      this.log('💾 Sessão salva com sucesso');
    } catch (error) {
      this.log(`⚠️ Erro ao salvar sessão: ${error}`);
    }
  }

  // Restaurar sessão
  async restoreSession(page: Page): Promise<boolean> {
    try {
      if (!fs.existsSync(this.sessionPath)) {
        this.log('ℹ️ Nenhuma sessão salva encontrada');
        return false;
      }

      const session: StoredSession = JSON.parse(
        fs.readFileSync(this.sessionPath, 'utf-8')
      );

      // Verificar se a sessão não expirou (24 horas)
      const sessionAge = Date.now() - session.timestamp;
      if (sessionAge > 24 * 60 * 60 * 1000) {
        this.log('⚠️ Sessão expirada (mais de 24 horas)');
        return false;
      }

      // Restaurar cookies
      if (session.cookies.length > 0) {
        await page.context().addCookies(session.cookies);
        this.log('🍪 Cookies restaurados com sucesso');
      }

      // Se tem token, navegar com ele
      if (session.token) {
        const baseUrl = process.env.CARCARA_URL || 'https://carcara.sinapad.lncc.br';
        await page.goto(`${baseUrl}/service/?token=${session.token}`, {
          waitUntil: 'networkidle',
        });
        this.log('🔑 Token restaurado com sucesso');
      }

      return true;
    } catch (error) {
      this.log(`❌ Erro ao restaurar sessão: ${error}`);
      return false;
    }
  }

  // Registrar um passo manualmente
  recordStep(step: LoginStep): void {
    if (this.isRecording) {
      this.steps.push({
        ...step,
        description: step.description || this.describeStep(step),
      });
      this.log(`📝 Passo registrado: ${step.type} - ${step.description || ''}`);
    }
  }

  // Descrever automaticamente um passo
  private describeStep(step: LoginStep): string {
    switch (step.type) {
      case 'navigate':
        return `Navegar para ${step.url}`;
      case 'fill':
        return `Preencher ${step.selector} com ${step.value ? '***' : 'vazio'}`;
      case 'click':
        return `Clicar em ${step.selector}`;
      case 'wait':
        return `Aguardar ${step.timeout}ms`;
      case 'press':
        return `Pressionar ${step.value} em ${step.selector}`;
      default:
        return 'Passo desconhecido';
    }
  }

  // Log com timestamp
  private log(message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    
    console.log(message);
    
    // Salvar em arquivo de log
    fs.appendFileSync(this.logPath, logMessage + '\n', 'utf-8');
  }

  // Limpar logs antigos
  clearLogs(): void {
    if (fs.existsSync(this.logPath)) {
      fs.writeFileSync(this.logPath, '', 'utf-8');
    }
    this.log('🧹 Logs limpos');
  }

  // Obter estatísticas
  getStats(): { totalSteps: number; lastLogin: string; scriptExists: boolean } {
    return {
      totalSteps: this.steps.length,
      lastLogin: fs.existsSync(this.sessionPath) 
        ? new Date(
            JSON.parse(fs.readFileSync(this.sessionPath, 'utf-8')).timestamp
          ).toLocaleString()
        : 'Nunca',
      scriptExists: fs.existsSync(this.scriptPath),
    };
  }
}