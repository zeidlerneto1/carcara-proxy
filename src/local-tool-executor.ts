import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}

export class LocalToolExecutor {
  private workspaceRoot: string;

  constructor(workspaceRoot?: string) {
    this.workspaceRoot = workspaceRoot || process.cwd();
  }

  /**
   * Executa ferramenta read_file
   */
  async readFile(filePath: string): Promise<ToolResult> {
    try {
      // Resolve caminho relativo ou absoluto
      const resolvedPath = path.isAbsolute(filePath) 
        ? filePath 
        : path.join(this.workspaceRoot, filePath);

      // Segurança: previne directory traversal fora do workspace
      const normalizedPath = path.normalize(resolvedPath);
      if (!normalizedPath.startsWith(this.workspaceRoot)) {
        return {
          success: false,
          error: `Acesso negado: caminho fora do workspace (${filePath})`
        };
      }

      if (!fs.existsSync(normalizedPath)) {
        return {
          success: false,
          error: `Arquivo não encontrado: ${filePath}`
        };
      }

      const content = fs.readFileSync(normalizedPath, 'utf-8');
      return {
        success: true,
        output: content
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Erro ao ler arquivo: ${error.message}`
      };
    }
  }

  /**
   * Executa ferramenta write_file
   */
  async writeFile(filePath: string, content: string): Promise<ToolResult> {
    try {
      const resolvedPath = path.isAbsolute(filePath) 
        ? filePath 
        : path.join(this.workspaceRoot, filePath);

      const normalizedPath = path.normalize(resolvedPath);
      if (!normalizedPath.startsWith(this.workspaceRoot)) {
        return {
          success: false,
          error: `Acesso negado: caminho fora do workspace (${filePath})`
        };
      }

      // Cria diretórios pai se necessário
      const dir = path.dirname(normalizedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(normalizedPath, content, 'utf-8');
      return {
        success: true,
        output: `Arquivo escrito com sucesso: ${filePath} (${content.length} bytes)`
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Erro ao escrever arquivo: ${error.message}`
      };
    }
  }

  /**
   * Executa ferramenta run_command
   */
  async runCommand(command: string, timeout: number = 30000): Promise<ToolResult> {
    try {
      // Lista negra de comandos perigosos
      const blockedCommands = ['rm -rf', 'del /s', 'format', 'mkfs', 'fdisk'];
      for (const blocked of blockedCommands) {
        if (command.toLowerCase().includes(blocked)) {
          return {
            success: false,
            error: `Comando bloqueado por segurança: ${blocked}`
          };
        }
      }

      const { stdout, stderr } = await execAsync(command, {
        cwd: this.workspaceRoot,
        timeout,
        maxBuffer: 10 * 1024 * 1024 // 10MB
      });

      return {
        success: true,
        output: stderr ? `${stdout}\n[stderr]\n${stderr}` : stdout
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Erro ao executar comando: ${error.message}${error.stdout ? `\nSaída: ${error.stdout}` : ''}`
      };
    }
  }

  /**
   * Executa ferramenta search_web (via DuckDuckGo)
   */
  async searchWeb(query: string): Promise<ToolResult> {
    try {
      const response = await fetch('http://localhost:3030/api/search/ddg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const results = data.results?.slice(0, 5).map((r: any) => 
        `- [${r.title}](${r.url})\n  ${r.body}`
      ).join('\n\n') || 'Nenhum resultado encontrado.';

      return {
        success: true,
        output: `Resultados da busca para "${query}":\n\n${results}`
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Erro na busca web: ${error.message}`
      };
    }
  }

  /**
   * Executa ferramenta browse_url
   */
  async browseUrl(url: string): Promise<ToolResult> {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (AgentLoop Bot)' }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const html = await response.text();
      // Extrai texto básico do HTML (simples)
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 3000);

      return {
        success: true,
        output: `Conteúdo de ${url}:\n\n${text}`
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Erro ao acessar URL: ${error.message}`
      };
    }
  }
}
