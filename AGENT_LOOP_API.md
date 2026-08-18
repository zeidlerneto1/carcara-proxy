# Agent Loop API - Documentação

## Visão Geral

O Agent Loop permite que modelos de IA sem tool calling nativo (como Qwen, DeepSeek) executem ferramentas usando **tags XML** no estilo Kimi Chat.

## Fluxo de Funcionamento

```
1. Cliente envia mensagem → Carcara Proxy
2. Proxy encaminha para modelo (Qwen/DeepSeek via localhost:3030)
3. Modelo responde com tags: <read_file>{"path": "arquivo.txt"}</read_file>
4. Proxy parseia as tags → converte em ToolCalls
5. Proxy executa ferramentas localmente
6. Resultados são retornados ao modelo para próxima iteração
7. Loop continua até tarefa completa ou limite de iterações
```

## Endpoints da API

### 1. POST `/api/agent/parse-tags`

Parseia resposta do modelo extraindo tags XML e convertendo em tool calls.

**Request:**
```json
{
  "content": "<think>Preciso ler o arquivo</think><read_file>{\"path\": \"teste.txt\"}</read_file>",
  "enableTagParsing": true
}
```

**Response:**
```json
{
  "tags": [
    {
      "type": "tool",
      "name": "read_file",
      "args": {"path": "teste.txt"},
      "rawContent": "{\"path\": \"teste.txt\"}",
      "startOffset": 44,
      "endOffset": 89
    }
  ],
  "plainText": "Preciso ler o arquivo",
  "hasToolCalls": true,
  "toolCalls": [
    {
      "id": "call_1234567890_abc123",
      "type": "function",
      "function": {
        "name": "file_read",
        "arguments": "{\"path\":\"teste.txt\"}"
      }
    }
  ]
}
```

### 2. POST `/api/agent/execute-tools`

Executa ferramentas localmente baseado nos tool calls parseados.

**Request:**
```json
{
  "toolCalls": [
    {
      "id": "call_123",
      "type": "function",
      "function": {
        "name": "read_file",
        "arguments": "{\"path\": \"teste.txt\"}"
      }
    }
  ]
}
```

**Response:**
```json
{
  "results": [
    {
      "tool_call_id": "call_123",
      "name": "read_file",
      "success": true,
      "output": "Conteúdo do arquivo aqui..."
    }
  ]
}
```

### 3. GET `/api/agent/system-prompt`

Gera system prompt instruindo modelo a usar tags corretamente.

**Request:**
```
GET /api/agent/system-prompt?tools=read_file,write_file,run_command
```

**Response:**
```json
{
  "systemPrompt": "Você é um assistente AI com capacidades agênticas. Para executar ações, use TAGS ESPECÍFICAS...\n\n## FORMATO DE TAGS SUPORTADAS:\n\n### 1. Ler Arquivo\n<read_file>{\"path\": \"/caminho/arquivo.txt\"}</read_file>\n\n### 2. Escrever Arquivo\n<write_file>{\"path\": \"/caminho/arquivo.txt\", \"content\": \"conteúdo\"}</write_file>\n\n..."
}
```

## Tags Suportadas

| Tag | Ferramenta | Descrição |
|-----|------------|-----------|
| `<read_file>` | file_read | Lê conteúdo de arquivo |
| `<write_file>` | file_write | Escreve conteúdo em arquivo |
| `<run_command>` | shell_command | Executa comando shell |
| `<search>` | web_search | Busca na web (DuckDuckGo) |
| `<browse>` | browser_navigate | Navega em URL |
| `<code>` | code_interpreter | Executa código |
| `<think>` | (interno) | Pensamento interno (não executado) |
| `<final>` | (interno) | Resposta final |

## Exemplo de Uso Completo

### Passo 1: Obter System Prompt
```bash
curl http://localhost:3030/api/agent/system-prompt \
  -G --data-urlencode "tools=read_file,write_file,run_command"
```

### Passo 2: Enviar Mensagem com System Prompt
```bash
curl http://localhost:3030/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen3.6-35B",
    "messages": [
      {
        "role": "system",
        "content": "Use tags XML para executar ferramentas..."
      },
      {
        "role": "user",
        "content": "Leia o arquivo contexto.txt e crie um resumo em resumo.md"
      }
    ]
  }'
```

### Passo 3: Parsear Resposta
```bash
curl http://localhost:3030/api/agent/parse-tags \
  -H "Content-Type: application/json" \
  -d '{
    "content": "<read_file>{\"path\": \"contexto.txt\"}</read_file>",
    "enableTagParsing": true
  }'
```

### Passo 4: Executar Ferramentas
```bash
curl http://localhost:3030/api/agent/execute-tools \
  -H "Content-Type: application/json" \
  -d '{
    "toolCalls": [...]
  }'
```

### Passo 5: Enviar Resultado ao Modelo
```bash
curl http://localhost:3030/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen3.6-35B",
    "messages": [
      {"role": "user", "content": "Leia o arquivo..."},
      {"role": "assistant", "content": "<read_file>...</read_file>"},
      {"role": "tool", "content": "Conteúdo do arquivo..."}
    ]
  }'
```

## Segurança

- **Path Validation**: Previne directory traversal fora do workspace
- **Blocked Commands**: `rm -rf`, `del /s`, `format`, `mkfs`, `fdisk`
- **Timeout**: Comandos shell tem timeout de 30s (configurável)
- **Max Buffer**: 10MB de saída máxima

## Workspace

O workspace padrão é o diretório atual (`process.cwd()`). Todas as operações de arquivo são restritas a este diretório.

## Links

- Branch: https://github.com/zeidlerneto1/carcara-proxy/tree/qwen-version
- Tag Parser: `/workspace/src/tag-parser-service.ts`
- Local Tool Executor: `/workspace/src/local-tool-executor.ts`
- API Router: `/workspace/src/api-router.ts`
