# Agent Loop com Tag Parsing (Estilo Kimi Chat)

## Visão Geral

Implementação de **Agent Loop** no lado do cliente com suporte a **parsing de tags** no estilo Kimi Chat, permitindo que modelos de IA sem acesso nativo a tools possam executar ações através de tags estruturadas na resposta.

## Funcionalidades

### 1. Tag Parser Service (`src/tag-parser-service.ts`)

Parser que extrai tags da resposta do modelo e converte em tool calls executáveis.

#### Tags Suportadas:

| Tag | Formato | Tool Resultante | Descrição |
|-----|---------|-----------------|-----------|
| `<search>` | `<search>{"query": "..."}</search>` | `web_search` | Busca na web |
| `<browse>` | `<browse>{"url": "..."}</browse>` | `browser_navigate` | Navega em URL |
| `<code>` | `<code language="python">...</code>` | `code_interpreter` | Executa código |
| `<read_file>` | `<read_file>{"path": "..."}</read_file>` | `file_read` | Lê arquivo |
| `<write_file>` | `<write_file>{"path": "...", "content": "..."}</write_file>` | `file_write` | Escreve arquivo |
| `<run_command>` | `<run_command>{"command": "..."}</run_command>` | `shell_command` | Comando shell |
| `<think>` | `<think>...</think>` | (nenhuma) | Pensamento interno |
| `<final>` | `<final>...</final>` | (nenhuma) | Resposta final |

#### Formatos Alternativos:

```xml
<!-- Com nome explícito -->
<tool name="search">{"query": "Python 3.12"}</tool>

<!-- Self-closing -->
<tool name="search" args='{"query": "Python 3.12"}'/>

<!-- Simples -->
<search>{"query": "Python 3.12"}</search>
```

### 2. Agent Loop Service Atualizado (`src/agent-loop-service.ts`)

Loop de agente agora suporta:

- **Parsing automático de tags** nas respostas
- **System prompt gerado automaticamente** instruindo o modelo a usar tags
- **Extração de tool calls** das tags parseadas
- **Conteúdo limpo** (sem tags) para exibição ao usuário

#### Configurações Novas:

```typescript
interface AgentLoopConfig {
  enableTagParsing?: boolean;     // Default: true
  useTagsForTools?: boolean;      // Default: true
  availableTools?: string[];      // Tools disponíveis para o prompt
  // ... outras configs
}
```

## Como Funciona

### Fluxo Completo:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Usuário envia tarefa                                     │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. System Prompt + Instruções de Tags                       │
│    (gerado automaticamente pelo TagParserService)           │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. Modelo gera resposta COM TAGS                            │
│    Ex: <think>...</think><search>{...}</search>             │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. TagParserService.parse() extrai tags                     │
│    - Converte para ToolCalls                                │
│    - Remove tags do conteúdo visível                        │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 5. Agent Loop executa tools e decide próxima ação           │
│    - Se tem tool calls → próximo roll                       │
│    - Se <final> ou condição de parada → termina             │
└─────────────────────────────────────────────────────────────┘
```

## Uso

### Exemplo Básico:

```typescript
import { AgentLoopService } from './agent-loop-service.js';

const agent = new AgentLoopService({
  maxRolls: 5,
  enableTagParsing: true,
  useTagsForTools: true,
  availableTools: ['search', 'browse', 'code'],
});

const result = await agent.executeLoop(
  'Pesquise sobre Python 3.12 e resuma as novas features',
  async (prompt, config) => {
    // Chame sua API de chat aqui
    const response = await fetch('https://api.example.com/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await response.json();
    
    return {
      content: data.choices[0].message.content,
      toolCalls: data.choices[0].message.tool_calls,
      finishReason: data.choices[0].finish_reason,
    };
  }
);

console.log('Resultado:', result.finalContent);
console.log('Tool calls:', result.rolls.flatMap(r => r.toolCalls || []));
```

### Exemplo de Resposta do Modelo:

```
<think>Preciso buscar informações sobre Python 3.12 primeiro</think>
<search>{"query": "Python 3.12 novas features 2024"}</search>
```

Após parsing:
- **toolCalls**: `[{ id: "call_...", type: "function", function: { name: "web_search", arguments: '{"query": "Python 3.12 novas features 2024"}' } }]`
- **plainText**: `"Preciso buscar informações sobre Python 3.12 primeiro"`

### Customização do System Prompt:

```typescript
import { TagParserService } from './tag-parser-service.js';

const systemPrompt = TagParserService.generateSystemPrompt({
  availableTools: ['search', 'code'],
  customInstructions: 'Sempre use search antes de responder perguntas factuais.',
  enableThinking: true,
});

// Use systemPrompt no início das suas mensagens
```

## Vantagens

1. **Modelos sem tool calling nativo**: Funciona com qualquer modelo que gere texto
2. **Transparente**: Usuário vê apenas o conteúdo limpo, sem tags
3. **Flexível**: Múltiplos formatos de tag suportados
4. **Extensível**: Fácil adicionar novas tags/tools
5. **Debuggable**: Logs detalhados do parsing

## Configuração no Carcara Client

O `carcara-client.ts` foi atualizado para suportar as novas opções:

```typescript
// Habilitar tag parsing
await client.updateAgentLoopConfig({
  enableTagParsing: true,
  useTagsForTools: true,
  availableTools: ['search', 'browse', 'code', 'read_file', 'write_file'],
});

// Executar loop
const result = await client.executeAgentLoop('Sua tarefa', 'Qwen3.6-35B');
```

## Logs e Debug

Logs exemplo:

```
INFO  Tags parsed and converted to tool calls { tagsFound: 2 }
INFO  Tool calls detected, another roll needed { toolCallsCount: 2 }
INFO  Agent loop stopped { reason: 'final answer', roll: 3 }
```

## Próximos Passos Sugeridos

1. **Execução real de tools**: Implementar `executeTools()` no agent loop
2. **Feedback de resultados**: Inserir resultados das tools no próximo roll
3. **Timeout por roll**: Evitar loops infinitos
4. **Retry em erro**: Tentativas automáticas em falhas de parsing
5. **UI no LlamaUI**: Mostrar tags sendo processadas em tempo real

## Referências

- Inspirado no funcionamento do **Kimi Chat**
- Compatível com formato OpenAI Tool Calling
- Integrado com MCP Tools do projeto
