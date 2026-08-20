import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const execAsync = promisify(exec);

export type OSType = 'windows' | 'linux' | 'macos' | 'unknown';

export interface DockerStatus {
  available: boolean;
  running: boolean;
  version: string | null;
  os: OSType;
  wsl2: boolean;
  dockerDesktop: boolean;
  error?: string;
}

/**
 * DockerManager: gerencia Docker cross-platform.
 * 
 * - Detecta OS (Windows/Linux/macOS)
 * - Verifica se Docker está rodando
 * - Tenta iniciar Docker Desktop no Windows
 * - Detecta WSL2 no Windows
 * - Adapta comandos conforme o OS
 */
export class DockerManager {
  private os: OSType;
  private status: DockerStatus | null = null;

  constructor() {
    this.os = this.detectOS();
    logger.info({ os: this.os }, 'OS detectado');
  }

  detectOS(): OSType {
    const platform = os.platform();
    if (platform === 'win32') return 'windows';
    if (platform === 'linux') return 'linux';
    if (platform === 'darwin') return 'macos';
    return 'unknown';
  }

  getOS(): OSType {
    return this.os;
  }

  isWindows(): boolean {
    return this.os === 'windows';
  }

  isLinux(): boolean {
    return this.os === 'linux';
  }

  /**
   * Verifica status completo do Docker no host.
   */
  async checkStatus(): Promise<DockerStatus> {
    const status: DockerStatus = {
      available: false,
      running: false,
      version: null,
      os: this.os,
      wsl2: false,
      dockerDesktop: false,
    };

    try {
      // Tenta obter versão do Docker
      const { stdout } = await execAsync('docker version --format "{{.Server.Version}}"');
      status.version = stdout.trim();
      status.available = true;
      status.running = true;
      logger.info({ version: status.version, os: this.os }, 'Docker detectado');
      this.status = status;
      return status;
    } catch {
      // Docker não está rodando ou não está instalado
      logger.warn({ os: this.os }, 'Docker não detectado');
    }

    // No Windows, verifica WSL2 e Docker Desktop
    if (this.os === 'windows') {
      status.wsl2 = await this.checkWSL2();
      status.dockerDesktop = await this.checkDockerDesktop();

      if (status.dockerDesktop && !status.running) {
        logger.info('Docker Desktop instalado mas não rodando. Tentando iniciar...');
        const started = await this.startDockerDesktop();
        if (started) {
          // Re-verifica
          return this.checkStatus();
        }
      }
    }

    this.status = status;
    return status;
  }

  /**
   * Verifica se WSL2 está disponível no Windows.
   */
  private async checkWSL2(): Promise<boolean> {
    if (this.os !== 'windows') return false;
    try {
      const { stdout } = await execAsync('wsl --status');
      return stdout.includes('Default Version: 2') || stdout.includes('versão padrão: 2');
    } catch {
      return false;
    }
  }

  /**
   * Verifica se Docker Desktop está instalado no Windows.
   */
  private async checkDockerDesktop(): Promise<boolean> {
    if (this.os !== 'windows') return false;
    try {
      // Verifica se o executável existe
      await execAsync('where docker.exe');
      return true;
    } catch {
      try {
        // Verifica no PATH padrão
        await execAsync('docker --version');
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Tenta iniciar Docker Desktop no Windows.
   */
  private async startDockerDesktop(): Promise<boolean> {
    if (this.os !== 'windows') return false;
    try {
      // Caminhos comuns do Docker Desktop
      const possiblePaths = [
        '"C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"',
        '"C:\\Program Files (x86)\\Docker\\Docker\\Docker Desktop.exe"',
        'docker-desktop',
      ];

      for (const dockerPath of possiblePaths) {
        try {
          // Tenta iniciar sem esperar (detached)
          spawn('cmd', ['/c', 'start', '', dockerPath], {
            detached: true,
            windowsHide: true,
            stdio: 'ignore',
          });
          logger.info({ path: dockerPath }, 'Tentando iniciar Docker Desktop...');

          // Aguarda até 30s para o Docker subir
          for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
              await execAsync('docker version --format "{{.Server.Version}}"');
              logger.info('Docker Desktop iniciado com sucesso!');
              return true;
            } catch {
              // Ainda não subiu
            }
          }
        } catch (err: any) {
          logger.warn({ path: dockerPath, error: err.message }, 'Falha ao iniciar Docker Desktop');
        }
      }

      return false;
    } catch (error: any) {
      logger.error({ error: error.message }, 'Erro ao iniciar Docker Desktop');
      return false;
    }
  }

  /**
   * Retorna o comando docker adaptado ao OS.
   * No Windows com WSL2, pode usar `wsl docker` se necessário.
   */
  getDockerCommand(): string {
    return 'docker';
  }

  /**
   * Executa comando docker adaptado ao OS.
   */
  async execDocker(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const cmd = this.getDockerCommand();
    const fullCmd = `${cmd} ${args.join(' ')}`;
    logger.info({ cmd: fullCmd }, 'Executando comando Docker');
    return execAsync(fullCmd);
  }

  /**
   * Retorna informações do ambiente para debug.
   */
  getEnvironmentInfo(): Record<string, any> {
    return {
      os: this.os,
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      cpus: os.cpus().length,
      dockerStatus: this.status,
    };
  }
}
