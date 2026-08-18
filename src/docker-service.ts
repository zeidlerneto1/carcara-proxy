import { spawn, exec } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import pino from 'pino';
import { promisify } from 'util';

const logger = pino({ level: 'info' });
const execAsync = promisify(exec);

export interface DockerStatus {
  available: boolean;
  version?: string;
  containersRunning: number;
  canRunContainers: boolean;
  error?: string;
}

export interface SandboxContainerConfig {
  imageName: string;
  containerName: string;
  port: number;
  volumePath: string;
  memoryLimit: string;
  cpuLimit: string;
}

const DEFAULT_CONTAINER_CONFIG: SandboxContainerConfig = {
  imageName: 'python:3.11-alpine',
  containerName: 'carcara-sandbox',
  port: 8080,
  volumePath: '/tmp/carcara-sandbox',
  memoryLimit: '512m',
  cpuLimit: '1.0',
};

/**
 * DockerService - Verifica e gerencia Docker no sistema.
 * 
 * Funcionalidades:
 *   - Verifica se Docker está instalado e acessível
 *   - Verifica se containers podem ser executados
 *   - Oferece comando para subir container sandbox
 *   - Modo fallback: proxy-only se Docker indisponível
 */
export class DockerService {
  private config: SandboxContainerConfig;

  constructor(config?: Partial<SandboxContainerConfig>) {
    this.config = { ...DEFAULT_CONTAINER_CONFIG, ...config };
  }

  /**
   * Verifica status completo do Docker no sistema.
   */
  async checkDockerStatus(): Promise<DockerStatus> {
    const result: DockerStatus = {
      available: false,
      containersRunning: 0,
      canRunContainers: false,
    };

    // 1. Verifica se Docker está instalado
    try {
      const { stdout } = await execAsync('docker --version');
      result.version = stdout.trim();
      result.available = true;
      logger.info({ version: result.version }, 'Docker disponível');
    } catch (error: any) {
      result.error = 'Docker não está instalado ou não está no PATH';
      logger.warn('Docker não disponível:', result.error);
      return result;
    }

    // 2. Verifica se daemon está rodando
    try {
      await execAsync('docker info');
    } catch (error: any) {
      result.error = 'Docker daemon não está rodando';
      logger.warn('Docker daemon indisponível:', result.error);
      return result;
    }

    // 3. Conta containers rodando
    try {
      const { stdout } = await execAsync('docker ps --format "{{.Names}}"');
      const containers = stdout.trim().split('\n').filter(c => c.length > 0);
      result.containersRunning = containers.length;
      
      // Verifica se nosso container sandbox já está rodando
      if (containers.includes(this.config.containerName)) {
        logger.info({ name: this.config.containerName }, 'Container sandbox já está rodando');
      }
    } catch (error: any) {
      logger.warn('Falha ao listar containers:', error.message);
    }

    // 4. Testa se pode rodar containers
    try {
      await execAsync(`docker run --rm hello-world`, { timeout: 30000 });
      result.canRunContainers = true;
      logger.info('Docker pode executar containers');
    } catch (error: any) {
      // Tenta com imagem python como fallback
      try {
        await execAsync(`docker run --rm ${this.config.imageName} echo "test"`, { timeout: 30000 });
        result.canRunContainers = true;
        logger.info('Docker pode executar containers (teste com Python)');
      } catch (fallbackError: any) {
        result.error = 'Docker não tem permissão para rodar containers';
        logger.warn('Docker não pode rodar containers:', result.error);
      }
    }

    return result;
  }

  /**
   * Gera comando para subir container sandbox.
   */
  getStartContainerCommand(): string {
    const args = [
      'docker run -d',
      `--name ${this.config.containerName}`,
      `--memory=${this.config.memoryLimit}`,
      `--cpus=${this.config.cpuLimit}`,
      '--network=none',
      '--read-only',
      '--security-opt=no-new-privileges:true',
      '--cap-drop=ALL',
      `-v ${this.config.volumePath}:/sandbox:rw`,
      '-w /sandbox',
      `--restart unless-stopped`,
      this.config.imageName,
      'tail -f /dev/null',
    ];

    return args.join(' \\\n  ');
  }

  /**
   * Sobe container sandbox interativamente.
   */
  async startSandboxContainer(): Promise<{ success: boolean; message: string }> {
    try {
      // Para container existente se houver
      try {
        await execAsync(`docker stop ${this.config.containerName}`);
        await execAsync(`docker rm ${this.config.containerName}`);
        logger.info('Container anterior removido');
      } catch {}

      // Cria volume directory
      await fs.mkdir(this.config.volumePath, { recursive: true });

      // Sobe novo container
      const command = this.getStartContainerCommand();
      await execAsync(command.replace(/\\\n/g, ' '), { timeout: 60000 });

      logger.info({ name: this.config.containerName }, 'Container sandbox iniciado');
      
      return {
        success: true,
        message: `Container '${this.config.containerName}' iniciado com sucesso!\nVolume: ${this.config.volumePath}\nImagem: ${this.config.imageName}`,
      };
    } catch (error: any) {
      logger.error('Falha ao iniciar container:', error.message);
      return {
        success: false,
        message: `Erro ao iniciar container: ${error.message}`,
      };
    }
  }

  /**
   * Para e remove container sandbox.
   */
  async stopSandboxContainer(): Promise<boolean> {
    try {
      await execAsync(`docker stop ${this.config.containerName}`);
      await execAsync(`docker rm ${this.config.containerName}`);
      logger.info('Container sandbox parado');
      return true;
    } catch (error: any) {
      logger.warn('Falha ao parar container:', error.message);
      return false;
    }
  }

  /**
   * Verifica se container sandbox está rodando.
   */
  async isSandboxContainerRunning(): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`docker ps --filter "name=${this.config.containerName}" --format "{{.Names}}"`);
      return stdout.trim().includes(this.config.containerName);
    } catch {
      return false;
    }
  }

  /**
   * Prompt interativo para usuário decidir sobre Docker.
   */
  async promptForDockerSetup(): Promise<'container' | 'proxy-only'> {
    const status = await this.checkDockerStatus();

    if (!status.available) {
      logger.warn('⚠️  Docker não encontrado. Iniciando em modo PROXY-ONLY.');
      logger.warn('   Para usar sandbox com Docker, instale: https://docs.docker.com/get-docker/');
      return 'proxy-only';
    }

    if (!status.canRunContainers) {
      logger.warn('⚠️  Docker não tem permissão para rodar containers.');
      logger.warn('   Verifique se usuário está no grupo docker ou se daemon está rodando.');
      logger.warn('   Iniciando em modo PROXY-ONLY.');
      return 'proxy-only';
    }

    // Docker disponível e funcional
    const alreadyRunning = await this.isSandboxContainerRunning();

    if (alreadyRunning) {
      logger.info('✅ Container sandbox já está rodando!');
      return 'container';
    }

    logger.info('✅ Docker disponível e funcional!');
    logger.info('📦 Container sandbox recomendado para execução isolada de código.');
    logger.info('');
    logger.info('Comando para subir container:');
    logger.info('─'.repeat(60));
    logger.info(this.getStartContainerCommand());
    logger.info('─'.repeat(60));
    logger.info('');

    // Em ambiente non-TTY, assume proxy-only
    if (!process.stdin.isTTY) {
      logger.info('Modo non-TTY detectado. Use variável de ambiente FORCE_SANDBOX=true para forçar.');
      if (process.env.FORCE_SANDBOX === 'true') {
        logger.info('FORCE_SANDBOX=true detectado. Tentando subir container...');
        const result = await this.startSandboxContainer();
        if (result.success) {
          return 'container';
        }
      }
      return 'proxy-only';
    }

    // Ambiente TTY - pergunta ao usuário
    return new Promise((resolve) => {
      logger.info('Deseja subir o container sandbox agora?');
      logger.info('  [Y] Sim - sobe container e usa sandbox Docker');
      logger.info('  [N] Não - inicia em modo proxy-only (enter ignora)');
      logger.info('');

      process.stdout.write('Opção [Y/N]: ');

      const onData = (data: Buffer) => {
        const input = data.toString().trim().toLowerCase();
        process.stdin.removeListener('data', onData);

        if (input === 'y' || input === 'yes') {
          this.startSandboxContainer().then((result) => {
            if (result.success) {
              logger.info('✅ Container iniciado! Usando sandbox Docker.');
              resolve('container');
            } else {
              logger.warn('⚠️  Falha ao iniciar container. Usando modo proxy-only.');
              resolve('proxy-only');
            }
          });
        } else {
          logger.info('Iniciando em modo PROXY-ONLY (sem sandbox Docker).');
          resolve('proxy-only');
        }
      };

      process.stdin.once('data', onData);

      // Timeout de 30 segundos
      setTimeout(() => {
        process.stdin.removeListener('data', onData);
        logger.info('Timeout. Iniciando em modo PROXY-ONLY.');
        resolve('proxy-only');
      }, 30000);
    });
  }

  getConfig(): SandboxContainerConfig {
    return { ...this.config };
  }
}
