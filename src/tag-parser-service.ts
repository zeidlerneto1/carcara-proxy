import pino from 'pino';
import { ToolCall } from './types.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Resultado do parsing de tags no estilo Kimi Chat
 */
export interface ParsedTag {
  type: 'tool' | 'search' | 'code' | 'browse' | 'think' | 'final';
  name: string;
  args: Record<string, any>;
  rawContent: string;
  startOffset: number;
  endOffset: number;
}

export interface ParseResult {
  tags: ParsedTag[];
  plainText: string; // Texto sem tags
  hasToolCalls: boolean;
  toolCalls: ToolCall[];
}

/**
 * Parser de Tags no Estilo Kimi Chat
 * 
 * Extrai tags estruturadas da resposta do modelo e converte em tool calls executáveis.
 * Suporta múltiplos formatos de tags:
 * - <tool name="search">{"query": "..."}</tool>
 * - <search>{"query": "..."}</search>
 * - <code language="python">...</code>
 * - <think>...</think>
 * - <final>...</final>
 */
export class TagParserService {
  
  /**
   * Tags suportadas e seus tipos
   */
  private static readonly SUPPORTED_TAGS = [
    'tool',
    'search',
    'code',
    'browse',
    'think',
    'final',
    'execute',
    'read_file',
    'write_file',
    'run_command',
  ];

  /**
   * Mapeamento de tags para nomes de tools
   */
  private static readonly TAG_TO_TOOL: Record<string, string> = {
    'search': 'web_search',
    'browse': 'browser_navigate',
    'code': 'code_interpreter',
    'execute': 'code_execute',
    'read_file': 'file_read',
    'write_file': 'file_write',
    'run_command': 'shell_command',
  };

  /**
   * Regex patterns para diferentes formatos de tags
   */
  private static readonly PATTERNS = {
    // <tool name="search">{"args": ...}</tool>
    toolWithName: /<(tool)\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/\1>/gi,
    
    // <search>{"args": ...}</search>
    simpleTag: /<(search|browse|code|think|final|execute|read_file|write_file|run_command)\s*>([\s\S]*?)<\/\1>/gi,
    
    // <tool name="search" args='{"query": "..."}'/> (self-closing)
    selfClosing: /<(tool)\s+name=["']([^"']+)["']\s+args=['"]([^'"]+)['"]\s*\/>/gi,
    
    // JSON dentro de tags
    jsonContent: /^\s*(\{[\s\S]*\})\s*$/g,
  };

  /**
   * Parseia resposta do modelo extraindo tags
   */
  static parse(response: string): ParseResult {
    const tags: ParsedTag[] = [];
    let plainText = response;

    logger.debug({ responseLength: response.length }, 'Starting tag parsing');

    // 1. Extrair tags com nome explícito: <tool name="search">...</tool>
    this.extractToolTags(response, tags);

    // 2. Extrair tags simples: <search>...</search>
    this.extractSimpleTags(response, tags);

    // 3. Extrair tags self-closing: <tool name="x" args='{}'/>
    this.extractSelfClosingTags(response, tags);

    // 4. Ordenar por posição
    tags.sort((a, b) => a.startOffset - b.startOffset);

    // 5. Remover duplicatas (sobreposições)
    const uniqueTags = this.removeOverlaps(tags);

    // 6. Extrair texto puro (sem tags)
    plainText = this.extractPlainText(response, uniqueTags);

    // 7. Converter para ToolCalls
    const toolCalls = this.convertToToolCalls(uniqueTags);

    logger.info({ 
      totalTags: uniqueTags.length, 
      toolCallsCount: toolCalls.length,
      plainTextLength: plainText.length 
    }, 'Tag parsing completed');

    return {
      tags: uniqueTags,
      plainText,
      hasToolCalls: toolCalls.length > 0,
      toolCalls,
    };
  }

  /**
   * Extrai tags no formato <tool name="...">...</tool>
   */
  private static extractToolTags(response: string, tags: ParsedTag[]): void {
    const matches = [...response.matchAll(this.PATTERNS.toolWithName)];
    
    for (const match of matches) {
      const [fullMatch, tagName, toolName, content] = match;
      const startOffset = match.index || 0;
      
      try {
        // Tenta parsear conteúdo como JSON
        let args: Record<string, any> = {};
        const jsonMatch = content.match(this.PATTERNS.jsonContent);
        
        if (jsonMatch) {
          args = JSON.parse(jsonMatch[0]);
        } else {
          // Se não for JSON, usa como argumento único
          args = { input: content.trim() };
        }

        tags.push({
          type: toolName === 'think' || toolName === 'final' ? toolName as any : 'tool',
          name: toolName,
          args,
          rawContent: content.trim(),
          startOffset,
          endOffset: startOffset + fullMatch.length,
        });
      } catch (error: any) {
        logger.warn({ toolName, error: error.message }, 'Failed to parse tool tag JSON');
      }
    }
  }

  /**
   * Extrai tags simples: <search>...</search>
   */
  private static extractSimpleTags(response: string, tags: ParsedTag[]): void {
    const matches = [...response.matchAll(this.PATTERNS.simpleTag)];
    
    for (const match of matches) {
      const [fullMatch, tagName, content] = match;
      const startOffset = match.index || 0;
      
      try {
        let args: Record<string, any> = {};
        const jsonMatch = content.match(this.PATTERNS.jsonContent);
        
        if (jsonMatch) {
          args = JSON.parse(jsonMatch[0]);
        } else {
          args = { input: content.trim() };
        }

        const tagType = ['think', 'final'].includes(tagName) ? tagName as any : 'tool';
        
        tags.push({
          type: tagType,
          name: tagName,
          args,
          rawContent: content.trim(),
          startOffset,
          endOffset: startOffset + fullMatch.length,
        });
      } catch (error: any) {
        logger.warn({ tagName, error: error.message }, 'Failed to parse simple tag JSON');
      }
    }
  }

  /**
   * Extrai tags self-closing: <tool name="x" args='{}'/>
   */
  private static extractSelfClosingTags(response: string, tags: ParsedTag[]): void {
    const matches = [...response.matchAll(this.PATTERNS.selfClosing)];
    
    for (const match of matches) {
      const [fullMatch, tagName, toolName, argsStr] = match;
      const startOffset = match.index || 0;
      
      try {
        const args = JSON.parse(argsStr);
        
        tags.push({
          type: 'tool',
          name: toolName,
          args,
          rawContent: argsStr,
          startOffset,
          endOffset: startOffset + fullMatch.length,
        });
      } catch (error: any) {
        logger.warn({ toolName, error: error.message }, 'Failed to parse self-closing tag');
      }
    }
  }

  /**
   * Remove tags sobrepostas (mantém a primeira)
   */
  private static removeOverlaps(tags: ParsedTag[]): ParsedTag[] {
    if (tags.length <= 1) return tags;

    const sorted = [...tags].sort((a, b) => a.startOffset - b.startOffset);
    const result: ParsedTag[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i];
      const last = result[result.length - 1];

      // Se não sobrepõe, adiciona
      if (current.startOffset >= last.endOffset) {
        result.push(current);
      } else {
        logger.debug({ 
          tag1: last.name, 
          tag2: current.name,
          overlap: `${last.startOffset}-${last.endOffset} vs ${current.startOffset}-${current.endOffset}`
        }, 'Skipping overlapping tag');
      }
    }

    return result;
  }

  /**
   * Extrai texto puro removendo todas as tags
   */
  private static extractPlainText(response: string, tags: ParsedTag[]): string {
    if (tags.length === 0) return response;

    let result = '';
    let lastIndex = 0;

    for (const tag of tags) {
      // Adiciona texto antes da tag
      result += response.slice(lastIndex, tag.startOffset);
      lastIndex = tag.endOffset;
    }

    // Adiciona texto após última tag
    result += response.slice(lastIndex);

    // Limpeza: remove quebras extras
    return result.replace(/\n\s*\n\s*\n/g, '\n\n').trim();
  }

  /**
   * Converte parsed tags para ToolCalls no formato OpenAI
   */
  private static convertToToolCalls(tags: ParsedTag[]): ToolCall[] {
    const toolCalls: ToolCall[] = [];

    for (const tag of tags) {
      // Ignora tags de pensamento e final
      if (tag.type === 'think' || tag.type === 'final') {
        continue;
      }

      // Mapeia nome da tag para nome da tool
      const toolName = TagParserService.TAG_TO_TOOL[tag.name] || tag.name;

      toolCalls.push({
        id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: 'function',
        function: {
          name: toolName,
          arguments: JSON.stringify(tag.args),
        },
      });
    }

    return toolCalls;
  }

  /**
   * Gera system prompt para instruir modelo a usar tags
   */
  static generateSystemPrompt(options?: {
    availableTools?: string[];
    customInstructions?: string;
    enableThinking?: boolean;
  }): string {
    const { availableTools = [], customInstructions = '', enableThinking = true } = options || {};

    const toolsList = availableTools.length > 0 
      ? availableTools.map(t => `- ${t}`).join('\n')
      : 'search, browse, code, read_file, write_file, run_command';

    return `Você é um assistente AI com capacidades agênticas. Para executar ações, use TAGS ESPECÍFICAS na sua resposta.

## FORMATO DE TAGS SUPORTADAS:

### 1. Busca na Web
<search>{"query": "sua busca aqui"}</search>

### 2. Navegar em URL
<browse>{"url": "https://exemplo.com"}</browse>

### 3. Executar Código
<code language="python">
print("hello world")
</code>

### 4. Ler Arquivo
<read_file>{"path": "/caminho/arquivo.txt"}</read_file>

### 5. Escrever Arquivo
<write_file>{"path": "/caminho/arquivo.txt", "content": "conteúdo"}</write_file>

### 6. Comando Shell
<run_command>{"command": "ls -la"}</run_command>

### 7. Pensamento Interno (não executado)
${enableThinking ? '<think>análise interna aqui</think>' : '(desabilitado)'}

### 8. Resposta Final
<final>Sua resposta final formatada aqui</final>

## REGRAS IMPORTANTES:

1. Use APENAS uma tag por ação necessária
2. O conteúdo das tags DEVE ser JSON válido (exceto code)
3. Após cada tag de ação, aguarde o resultado antes de continuar
4. Use <think> para raciocínio interno antes de agir
5. Use <final> apenas quando a tarefa estiver completa
6. Se não precisar de ferramentas, responda normalmente sem tags

## FERRAMENTAS DISPONÍVEIS:
${toolsList}

${customInstructions ? `## INSTRUÇÕES ADICIONAIS:\n${customInstructions}` : ''}

Exemplo de uso correto:
<think>Preciso buscar informações sobre Python</think>
<search>{"query": "Python 3.12 novas features"}</search>
<final>Com base na busca, Python 3.12 introduziu...</final>
`;
  }
}
