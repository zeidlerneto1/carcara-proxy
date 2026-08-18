# AgentLoop Integration with Carcara Proxy

## Visão Geral

Este documento descreve a integração do **AgentLoop** (runtime TypeScript para agentes com ferramentas) com o **Carcara Proxy**, adicionando suporte para modelos **Qwen** e **DeepSeek**, sandbox Docker, e ponte entre o client do Carcara e o AgentLoop.

## Estrutura do Projeto

```
/workspace/
├── carcara-proxy/          # Projeto original Carcara Proxy
│   ├── src/
│   │   ├── agent-loop-service.ts
│   │   ├── carcara-client.ts
│   │   ├── tag-parser-service.ts
│   │   └── docker-service.ts
│   └── ...
├── agentloop-src/          # AgentLoop clonado e adaptado
│   ├── src/
│   │   ├── llm.ts          # Suporte Qwen/DeepSeek/Ollama/LM Studio
│   │   ├── config.ts       # Configuração expandida
│   │   ├── index.ts        # API principal do AgentLoop
│   │   ├── sandbox/
│   │   │   └── docker.ts   # Sandbox Docker integrada
│   │   └── tools/          # 22 ferramentas built-in
│   └── ...
└── ...
```

## Modelos Suportados

O AgentLoop agora suporta os seguintes provedores de LLM:

| Provedor | Variável de Ambiente | URL Base | Modelos Exemplo |
|----------|---------------------|----------|-----------------|
| `mistral` | `MISTRAL_API_KEY` | (default) | `mistral-large`, `open-mistral-nemo` |
| `openai` | `OPENAI_API_KEY` | (default) | `gpt-4o`, `gpt-4-turbo` |
| `anthropic` | `ANTHROPIC_API_KEY` | (default) | `claude-sonnet-4-20250514` |
| `qwen` | `DASHSCOPE_API_KEY` ou `QWEN_API_KEY` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-max`, `qwen-plus` |
| `deepseek` | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` | `deepseek-chat`, `deepseek-coder` |
| `ollama` | (opcional) | `http://localhost:11434/v1` | `llama3.1`, `qwen2.5` |
| `lmstudio` | (opcional) | `http://localhost:1234/v1` | `local-model` |

### Configurando Qwen

```bash
export LLM_PROVIDER=qwen
export QWEN_API_KEY=sk-xxxxx
export LLM_MODEL=qwen-max
# Ou use DASHSCOPE_API_KEY
export DASHSCOPE_API_KEY=sk-xxxxx
```

### Configurando DeepSeek

```bash
export LLM_PROVIDER=deepseek
export DEEPSEEK_API_KEY=sk-xxxxx
export LLM_MODEL=deepseek-chat
```

### Configurando Ollama (Local)

```bash
export LLM_PROVIDER=ollama
export LLM_MODEL=llama3.1
# Base URL padrão: http://localhost:11434/v1
```

### Configurando LM Studio (Local)

```bash
export LLM_PROVIDER=lmstudio
export LLM_MODEL=local-model
# Base URL padrão: http://localhost:1234/v1
```

### URL Base Customizada

Para outros provedores compatíveis com OpenAI:

```bash
export LLM_PROVIDER=openai
export OPENAI_API_KEY=qualquer-chave
export LLM_BASE_URL=https://api.seu-provedor.com/v1
export LLM_MODEL=nome-do-modelo
```

## Sandbox Docker

O AgentLoop inclui sandbox Docker para execução segura de código:

### Características:
- Container efêmero com `--rm` (auto-removido)
- Workspace montado como read-only (`:ro`)
- Rede desabilitada (`--network none`)
- Timeout configurável com kill forçado
- Environment variables injetadas explicitamente

### Uso no AgentLoop:

```typescript
import { runInDocker } from './agentloop-src/src/sandbox/docker';

const result = await runInDocker({
  executable: 'node',
  args: ['script.js'],
  cwd: '/workspace',
  workspaceRoot: '/absoluto/path/para/workspace',
  timeout: 30000, // 30 segundos
  env: { NODE_ENV: 'production' },
  image: 'node:20-alpine'
});

console.log(result.stdout);
console.log(result.exitCode);
```

### Integração com Carcara Docker Service

O serviço Docker do Carcara (`src/docker-service.ts`) pode ser usado em conjunto:

```typescript
import { DockerService } from './src/docker-service';

// Verifica se Docker está disponível
const isAvailable = await DockerService.isDockerAvailable();

if (isAvailable) {
  // Inicia container sandbox
  await DockerService.startSandboxContainer();
}
```

## Ponte Carcara Client ↔ AgentLoop

### Criando a Ponte

```typescript
// src/agentloop-bridge.ts
import { toolRegistry, executeWithTools } from './agentloop-src/src/index';
import { CarcaraClient } from './src/carcara-client';

export class AgentLoopBridge {
  private carcaraClient: CarcaraClient;

  constructor(carcaraClient: CarcaraClient) {
    this.carcaraClient = caracaraClient;
  }

  /**
   * Executa tarefa usando AgentLoop com ferramentas do Carcara
   */
  async executeTask(task: string, model?: string): Promise<string> {
    // Configura modelo se necessário
    if (model) {
      this.carcaraClient.setAgentMaxRolls(10); // Exemplo
    }

    // Usa AgentLoop para executar com ferramentas
    const result = await executeWithTools(task);
    return result.output;
  }

  /**
   * Registra ferramentas do Carcara no AgentLoop
   */
  async registerCarcaraTools(): Promise<void> {
    // Mapeia ferramentas do Carcara para o registry do AgentLoop
    // Implementação depende das ferramentas específicas
  }
}
```

### Uso com Tag Parser

Para modelos sem tool calling nativo (Qwen, Llama, etc.):

```typescript
import { TagParserService } from './src/tag-parser-service';

const parser = new TagParserService();

// System prompt com instruções de tags
const systemPrompt = parser.generateSystemPrompt({
  enableTagParsing: true,
  availableTools: ['web_search', 'read_file', 'write_file', 'run_command']
});

// Parse da resposta do modelo
const response = "<think>análise</think><search>{\"query\": \"Python\"}</search>";
const parsed = parser.parse(response);

// parsed.toolCalls contém as tool calls formatadas para OpenAI
// parsed.plainText contém o texto limpo (sem tags)
```

## Configuração em Camadas

O AgentLoop usa configuração em camadas (Task 4.3):

1. **Default** (`config/default.json`) - Valores padrão
2. **Repo** (`config/repo.json`) - Override por repositório
3. **User** (`~/.agentloop/config.json`) - Preferências do usuário
4. **Environment Variables** - Overrides finais

### Variáveis de Ambiente Suportadas

```bash
# LLM
LLM_PROVIDER=qwen
LLM_MODEL=qwen-max
LLM_TEMPERATURE=0.7
OPENAI_API_KEY=xxx
DASHSCOPE_API_KEY=xxx
DEEPSEEK_API_KEY=xxx
LLM_BASE_URL=https://...

# Agent Loop
MAX_ITERATIONS=20
MAX_TOKENS_BUDGET=100000
MAX_CONTEXT_TOKENS=128000

# Tools
TOOL_TIMEOUT_MS=60000
AUTO_APPROVE_ALL=false
TOOL_ALLOWLIST=web_search,read_file
TOOL_BLOCKLIST=delete_file

# Execution
EXECUTION_TIMEOUT_MS=30000
SANDBOX_MODE=docker
DOCKER_IMAGE=node:20-alpine

# Search
WEB_SEARCH_PROVIDER=duckduckgo
DUCKDUCKGO_MAX_RESULTS=5

# Security
MAX_FILE_SIZE_BYTES=1048576
MAX_SHELL_OUTPUT_BYTES=1048576

# Observability
LOG_LEVEL=info
LOG_ENABLED=true
TRACING_ENABLED=true
```

## Exemplo de Uso Completo

```typescript
import { CarcaraClient } from './src/carcara-client';
import { AgentLoopBridge } from './src/agentloop-bridge';

async function main() {
  // Inicializa client Carcara
  const client = new CarcaraClient({
    baseUrl: 'http://localhost:3000',
    apiKey: 'sua-api-key'
  });

  // Configura para usar Qwen
  client.setAgentMaxRolls(10);

  // Cria ponte com AgentLoop
  const bridge = new AgentLoopBridge(client);

  // Executa tarefa complexa
  const task = `
    1. Pesquise sobre Python async/await
    2. Leia o arquivo README.md
    3. Crie um exemplo de código
    4. Salve em examples/python_async.py
  `;

  const result = await bridge.executeTask(task, 'qwen-max');
  console.log(result);
}

main().catch(console.error);
```

## Ferramentas Disponíveis

O AgentLoop inclui 22 ferramentas built-in:

- **File Operations**: `read_file`, `write_file`, `edit_file`, `list_files`, `search_files`
- **Shell**: `run_shell_command`
- **Web**: `web_search`, `fetch_url`, `browse_website`
- **Code**: `run_code`, `code_search`
- **Git**: `git_clone`, `git_commit`, `git_push`
- **MCP**: Integração com servidores MCP externos

## Segurança

### Tool Permission Manager

- **Blocklist**: Ferramentas bloqueadas nunca executam
- **Allowlist**: Apenas ferramentas listadas podem executar
- **Auto-approve**: Quando true, pula confirmações
- **Concurrency Limiter**: Limita execuções simultâneas

### Sandbox Modes

- `none`: Execução direta no host (rápido, menos seguro)
- `docker`: Execução em container isolado (seguro, overhead)

## Troubleshooting

### Erro: "Unknown LLM provider"

Verifique se o provedor está na lista suportada em `src/llm.ts`.

### Erro: "Tool binding not supported"

Alguns modelos não suportam tool calling nativo. Use o Tag Parser Service.

### Erro: "Docker not available"

O AgentLoop fallback para modo proxy-only se Docker não estiver disponível.

### Timeout em Execuções Longas

Aumente `TOOL_TIMEOUT_MS` ou `EXECUTION_TIMEOUT_MS` nas variáveis de ambiente.

## Próximos Passos

1. **Sub-agentes**: Implementar hierarquia de agentes (Task 7.4)
2. **Perfis de Agente**: Configurar comportamentos específicos (Task 7.3)
3. **Streaming**: Suporte a streaming de respostas (Task 4.2)
4. **Observabilidade**: Tracing completo de execuções (Task 6.1)
5. **Benchmarks**: Testes de performance (Task 5.1)

## Links Úteis

- [AgentLoop Original](https://github.com/huberp/agentloop)
- [Documentação LangChain](https://js.langchain.com/)
- [DashScope API (Qwen)](https://help.aliyun.com/zh/dashscope/)
- [DeepSeek API](https://platform.deepseek.com/api-docs/)
- [Ollama](https://ollama.ai/)
- [LM Studio](https://lmstudio.ai/)
