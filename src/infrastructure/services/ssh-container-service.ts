import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const execAsync = promisify(exec);

export interface SSHContainerConfig {
  containerName: string;
  hostSshPort: number;
  containerSshPort: number;
  image: string;
  username: string;
  password: string;
  workDir: string;
  memoryLimitMb: number;
  cpuPercent: number;
  networkEnabled: boolean;
  dockerSocket: boolean;
}

const DEFAULT_CONFIG: SSHContainerConfig = {
  containerName: 'carcara-ssh-bastion',
  hostSshPort: 2222,
  containerSshPort: 22,
  image: 'alpine:3.19',
  username: 'carcara',
  password: 'carcara123',
  workDir: '/home/carcara/workspace',
  memoryLimitMb: 512,
  cpuPercent: 50,
  networkEnabled: true,
  dockerSocket: true,
};

export interface SSHContainerStatus {
  running: boolean;
  containerName: string;
  hostSshPort: number;
  image: string;
  username: string;
  connectCommand: string;
  workDir: string;
}

/**
 * SSHContainerService: container persistente com SSH.
 * 
 * - NÃO usa docker build no startup (era lento/travava)
 * - Usa imagem Alpine pré-existente + setup via docker exec
 * - Startup em ~3-5 segundos (só docker run + exec)
 * - Porta 2222 do host -> 22 do container
 * - Ubuntu-like environment com bash, python3, node, git, openssh
 */
export class SSHContainerService {
  private config: SSHContainerConfig;
  private baseDir: string;
  private _running: boolean = false;

  constructor(config: Partial<SSHContainerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.baseDir = path.join(process.cwd(), '.carcara', 'ssh-bastion');
  }

  /**
   * Inicializa o container SSH. Chamado no startup do proxy.
   * NÃO faz docker build — usa imagem pré-existente + exec.
   */
  async init(): Promise<SSHContainerStatus> {
    const startTime = Date.now();
    logger.info({ container: this.config.containerName, port: this.config.hostSshPort }, 'Iniciando SSH Bastion...');

    await this.ensureDir();

    // Remove container antigo se existir
    try {
      await execAsync(`docker rm -f ${this.config.containerName}`, { timeout: 10000 });
      logger.info({ container: this.config.containerName }, 'Container antigo removido');
    } catch {
      // Não existia
    }

    // 1. Run do container Alpine com entrypoint que mantém rodando
    const dockerArgs = [
      'run', '-d',
      '--name', this.config.containerName,
      '--hostname', 'carcara-bastion',
      '-p', `${this.config.hostSshPort}:${this.config.containerSshPort}`,
      '--memory=' + this.config.memoryLimitMb + 'm',
      '--memory-swap=' + this.config.memoryLimitMb + 'm',
      '--cpus=' + (this.config.cpuPercent / 100),
      '--restart=unless-stopped',
      '-v', `${this.baseDir}/workspace:${this.config.workDir}:rw`,
    ];

    if (this.config.networkEnabled) dockerArgs.push('--network=bridge');
    else dockerArgs.push('--network=none');

    if (this.config.dockerSocket) {
      dockerArgs.push('-v', '/var/run/docker.sock:/var/run/docker.sock:rw');
    }

    dockerArgs.push(this.config.image, 'sh', '-c', 'while true; do sleep 3600; done');

    logger.info({ image: this.config.image }, 'Subindo container Alpine...');
    const { stderr } = await execAsync(`docker ${dockerArgs.join(' ')}`, { timeout: 30000 });
    if (stderr && !stderr.includes(this.config.containerName)) {
      logger.warn({ stderr }, 'Docker run stderr');
    }

    // 2. Setup via docker exec (muito mais rápido que docker build)
    logger.info('Configurando SSH server no container...');
    await this.setupContainer();

    // 3. Inicia SSHD
    logger.info('Iniciando SSHD...');
    await execAsync(`docker exec ${this.config.containerName} sh -c "nohup /usr/sbin/sshd -D > /dev/null 2>&1 &"`, { timeout: 10000 });

    // 4. Aguarda SSH subir (max 10s)
    logger.info('Aguardando SSH server...');
    let sshReady = false;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        await execAsync(`docker exec ${this.config.containerName} pgrep sshd`, { timeout: 5000 });
        sshReady = true;
        break;
      } catch {
        // Ainda não subiu
      }
    }

    if (!sshReady) {
      throw new Error('SSH server não iniciou no container');
    }

    this._running = true;
    const status = this.getStatus();
    const elapsed = Date.now() - startTime;
    logger.info({ 
      connect: status.connectCommand,
      port: status.hostSshPort,
      elapsedMs: elapsed,
    }, 'SSH Bastion pronto');
    return status;
  }

  /**
   * Configura o container Alpine com tudo necessário via docker exec.
   * Muito mais rápido que docker build porque não precisa baixar Ubuntu.
   */
  private async setupContainer(): Promise<void> {
    const setupCommands = [
      // Instala pacotes
      'apk add --no-cache openssh-server openssh-client bash sudo curl wget git python3 py3-pip nodejs npm htop vim nano docker-cli',

      // Cria usuário
      `adduser -D -s /bin/bash ${this.config.username}`,
      `echo "${this.config.username}:${this.config.password}" | chpasswd`,
      `echo "${this.config.username} ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers`,

      // Cria workspace
      `mkdir -p ${this.config.workDir}`,
      `chown -R ${this.config.username}:${this.config.username} ${this.config.workDir}`,

      // Gera host keys
      'ssh-keygen -A',

      // Configura SSH
      `sed -i "s/#PermitRootLogin.*/PermitRootLogin no/" /etc/ssh/sshd_config`,
      `sed -i "s/#PasswordAuthentication.*/PasswordAuthentication yes/" /etc/ssh/sshd_config`,
      `echo "AllowUsers ${this.config.username}" >> /etc/ssh/sshd_config`,
      `echo "ListenAddress 0.0.0.0" >> /etc/ssh/sshd_config`,

      // Ajusta permissões
      'mkdir -p /var/run/sshd',
      'chmod 755 /var/run/sshd',
    ];

    for (const cmd of setupCommands) {
      try {
        await execAsync(`docker exec ${this.config.containerName} sh -c "${cmd}"`, { timeout: 60000 });
      } catch (err: any) {
        logger.warn({ cmd: cmd.slice(0, 50), error: err.message }, 'Setup command falhou (pode ser OK se já existir)');
      }
    }
  }

  /**
   * Executa comando diretamente no container SSH via docker exec.
   */
  async exec(command: string, asUser: boolean = true): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const userFlag = asUser ? `-u ${this.config.username}` : '-u root';
    const { stdout, stderr } = await execAsync(
      `docker exec ${userFlag} ${this.config.containerName} bash -c "${command.replace(/"/g, '\"')}"`,
      { timeout: 30000 }
    );
    return { stdout, stderr, exitCode: 0 };
  }

  /**
   * Executa código em uma linguagem específica no container.
   */
  async executeCode(code: string, language: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const tmpFile = `/tmp/carcara_exec_${Date.now()}`;
    let cmd: string;

    switch (language) {
      case 'python': cmd = `python3 ${tmpFile}.py`; break;
      case 'javascript': cmd = `node ${tmpFile}.js`; break;
      case 'typescript': cmd = `npx tsx ${tmpFile}.ts`; break;
      case 'bash':
      case 'sh': cmd = `bash ${tmpFile}.sh`; break;
      default: throw new Error(`Linguagem não suportada: ${language}`);
    }

    const ext = language === 'typescript' ? 'ts' : language === 'javascript' ? 'js' : language === 'python' ? 'py' : 'sh';
    await this.exec(`cat > ${tmpFile}.${ext} << 'EOF'\n${code}\nEOF`);
    const result = await this.exec(cmd);
    await this.exec(`rm -f ${tmpFile}.*`);
    return result;
  }

  getStatus(): SSHContainerStatus {
    return {
      running: this._running,
      containerName: this.config.containerName,
      hostSshPort: this.config.hostSshPort,
      image: this.config.image,
      username: this.config.username,
      connectCommand: `ssh ${this.config.username}@localhost -p ${this.config.hostSshPort}`,
      workDir: this.config.workDir,
    };
  }

  async stop(): Promise<void> {
    try {
      await execAsync(`docker stop ${this.config.containerName}`, { timeout: 10000 });
      logger.info({ container: this.config.containerName }, 'Container SSH parado');
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Erro ao parar container SSH');
    }
    this._running = false;
  }

  async destroy(): Promise<void> {
    try {
      await execAsync(`docker rm -f ${this.config.containerName}`, { timeout: 10000 });
      logger.info({ container: this.config.containerName }, 'Container SSH destruído');
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Erro ao destruir container SSH');
    }
    this._running = false;
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.mkdir(path.join(this.baseDir, 'workspace'), { recursive: true });
  }
}
