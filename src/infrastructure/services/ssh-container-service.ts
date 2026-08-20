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
  dockerSocket: boolean; // mapear /var/run/docker.sock
}

const DEFAULT_CONFIG: SSHContainerConfig = {
  containerName: 'carcara-ssh-bastion',
  hostSshPort: 2222,
  containerSshPort: 22,
  image: 'ubuntu:22.04',
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
 * SSHContainerService: gerencia um container Docker persistente com SSH.
 * 
 * - Subido no init do proxy (não sob demanda)
 * - Porta 2222 do host -> 22 do container
 * - Ubuntu 22.04 com OpenSSH server
 * - Usuário 'carcara' com senha configurável
n * - Volume persistente para workspace
 * - Opcional: acesso ao Docker socket (Docker-in-Docker)
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
   */
  async init(): Promise<SSHContainerStatus> {
    logger.info({ container: this.config.containerName, port: this.config.hostSshPort }, 'Iniciando SSH Bastion...');

    // Gera script de setup do container
    await this.ensureDir();
    await this.writeSetupScript();

    // Verifica se já existe
    try {
      const { stdout } = await execAsync(`docker inspect -f "{{.State.Running}}" ${this.config.containerName}`);
      if (stdout.trim() === 'true') {
        logger.info({ container: this.config.containerName }, 'Container SSH já rodando');
        this._running = true;
        return this.getStatus();
      }
      // Container existe mas parado, remove
      await execAsync(`docker rm -f ${this.config.containerName}`);
    } catch {
      // Não existe, segue
    }

    // Build da imagem customizada com SSH
    const dockerfile = this.generateDockerfile();
    const dockerfilePath = path.join(this.baseDir, 'Dockerfile');
    await fs.writeFile(dockerfilePath, dockerfile, 'utf-8');

    logger.info({ image: this.config.image }, 'Buildando imagem SSH...');
    try {
      await execAsync(`docker build -t ${this.config.containerName}:latest -f ${dockerfilePath} ${this.baseDir}`);
    } catch (err: any) {
      logger.error({ error: err.message }, 'Falha no build da imagem SSH');
      throw err;
    }

    // Run do container
    const dockerArgs = [
      'run', '-d',
      '--name', this.config.containerName,
      '--hostname', 'carcara-bastion',
      '-p', `${this.config.hostSshPort}:${this.config.containerSshPort}`,
      '--memory=' + this.config.memoryLimitMb + 'm',
      '--memory-swap=' + this.config.memoryLimitMb + 'm',
      '--cpus=' + (this.config.cpuPercent / 100),
      '--restart=unless-stopped',
      '--user=root',
      '-v', `${this.baseDir}/workspace:${this.config.workDir}:rw`,
    ];

    if (this.config.networkEnabled) {
      dockerArgs.push('--network=bridge');
    } else {
      dockerArgs.push('--network=none');
    }

    if (this.config.dockerSocket) {
      dockerArgs.push('-v', '/var/run/docker.sock:/var/run/docker.sock:rw');
    }

    dockerArgs.push(`${this.config.containerName}:latest`);

    logger.info({ args: dockerArgs }, 'Subindo container SSH...');
    const { stderr } = await execAsync(`docker ${dockerArgs.join(' ')}`);
    if (stderr && !stderr.includes(this.config.containerName)) {
      logger.warn({ stderr }, 'Docker run stderr');
    }

    // Aguarda SSH subir
    logger.info('Aguardando SSH server...');
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const { stdout } = await execAsync(`docker exec ${this.config.containerName} pgrep sshd`);
        if (stdout.trim()) {
          logger.info('SSH server pronto!');
          break;
        }
      } catch {
        // Ainda não subiu
      }
    }

    this._running = true;
    const status = this.getStatus();
    logger.info({ 
      connect: status.connectCommand,
      port: status.hostSshPort 
    }, 'SSH Bastion pronto');
    return status;
  }

  /**
   * Executa comando diretamente no container SSH via docker exec.
   * Útil para o proxy executar sem precisar de SSH.
   */
  async exec(command: string, asUser: boolean = true): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const userFlag = asUser ? `-u ${this.config.username}` : '-u root';
    const { stdout, stderr } = await execAsync(`docker exec ${userFlag} ${this.config.containerName} bash -c "${command.replace(/"/g, '\"')}"`);
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
    await this.exec(`cat > ${tmpFile}.${ext} << 'EOF'
${code}
EOF`);
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
      await execAsync(`docker stop ${this.config.containerName}`);
      logger.info({ container: this.config.containerName }, 'Container SSH parado');
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Erro ao parar container SSH');
    }
    this._running = false;
  }

  async destroy(): Promise<void> {
    try {
      await execAsync(`docker rm -f ${this.config.containerName}`);
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

  private async writeSetupScript(): Promise<void> {
    // Nada necessário, o Dockerfile faz tudo
  }

  private generateDockerfile(): string {
    return `FROM ${this.config.image}

# Instala dependências
RUN apt-get update && apt-get install -y \
    openssh-server \
    sudo \
    curl \
    wget \
    git \
    python3 \
    python3-pip \
    nodejs \
    npm \
    bash \
    htop \
    vim \
    nano \
    && rm -rf /var/lib/apt/lists/*

# Instala Docker CLI (para Docker-in-Docker)
RUN curl -fsSL https://get.docker.com | sh || true

# Configura usuário
RUN useradd -m -s /bin/bash ${this.config.username} \
    && echo "${this.config.username}:${this.config.password}" | chpasswd \
    && usermod -aG sudo ${this.config.username} \
    && echo "${this.config.username} ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Configura SSH
RUN mkdir -p /var/run/sshd \
    && sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/#ListenAddress 0.0.0.0/ListenAddress 0.0.0.0/' /etc/ssh/sshd_config \
    && echo "AllowUsers ${this.config.username}" >> /etc/ssh/sshd_config

# Cria workspace
RUN mkdir -p ${this.config.workDir} \
    && chown -R ${this.config.username}:${this.config.username} ${this.config.workDir}

EXPOSE ${this.config.containerSshPort}

CMD ["/usr/sbin/sshd", "-D"]
`;
  }
}
