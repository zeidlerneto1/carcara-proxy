# Agent Loop Engineering - Client-Side

## Visão Geral

Implementação de um **agente com loop de engenharia** no lado do cliente, permitindo execução automática de múltiplas iterações (rolls) com configuração personalizável.

## Funcionalidades

### Configuração Padrão
- **5 rolls** como default (configurável de 1 a 20)
- Condições de parada automáticas
- Auto-reflexão entre rolls
- Suporte a tool use (ferramentas)

### Métodos Principais

#### 1. `setAgentMaxRolls(maxRolls: number)`
Muda o número máximo de rolls dinamicamente.

```typescript
// Muda para 3 rolls
client.setAgentMaxRolls(3);

// Muda para 10 rolls
client.setAgentMaxRolls(10);
```

#### 2. `executeAgentLoop(task: string, model?: string)`
Executa o loop completo do agente automaticamente.

```typescript
const result = await client.executeAgentLoop(
  'Analise este código e sugira melhorias',
  'Qwen3.6-35B'
);

console.log(`Total de rolls: ${result.totalRolls}`);
console.log(`Conteúdo final: ${result.finalContent}`);
console.log(`Parou por: ${result.stoppedByCondition}`);
```

#### 3. `updateAgentLoopConfig(config)`
Atualiza configuração completa do agent loop.

```typescript
client.updateAgentLoopConfig({
  maxRolls: 7,
  enableToolUse: true,
  enableSelfReflection: true,
  temperature: 0.8,
  stopConditions: ['task completed', 'done']
});
```

#### 4. `getAgentLoopConfig()`
Retorna configuração atual.

```typescript
const config = client.getAgentLoopConfig();
console.log(`Max rolls: ${config.maxRolls}`);
```

#### 5. `executeSingleAgentRoll(task, previousRolls?, model?)`
Executa um único roll manualmente (controle fino).

```typescript
const rolls = [];

// Roll 1
const roll1 = await client.executeSingleAgentRoll('Tarefa inicial');
rolls.push(roll1);

// Roll 2 (com contexto anterior)
const roll2 = await client.executeSingleAgentRoll(
  'Continue a tarefa',
  rolls
);
rolls.push(roll2);
```

## Estrutura de Resposta

```typescript
interface AgentLoopResult {
  success: boolean;              // Se executou sem erros
  rolls: AgentRollResult[];      // Array de todos os rolls
  finalContent: string;          // Conteúdo da última resposta
  totalRolls: number;            // Quantidade de rolls executados
  stoppedByCondition?: string;   // Condição que parou o loop
}

interface AgentRollResult {
  rollNumber: number;            // Número do roll (1, 2, 3...)
  content: string;               // Conteúdo gerado
  toolCalls?: ToolCall[];        // Ferramentas chamadas (se houver)
  finishReason: string;          // Motivo da finalização
  needsAnotherRoll: boolean;     // Se precisa de outro roll
  error?: string;                // Erro (se ocorreu)
}
```

## Condições de Parada

O loop para quando:
1. Atinge `maxRolls` (default: 5)
2. Detecta palavras-chave como:
   - "task completed"
   - "goal achieved"
   - "no further action needed"
   - "final answer"
3. Ocorre erro crítico

## Exemplo Completo

```typescript
import { CarcaraClient } from './carcara-client.js';

const client = new CarcaraClient();
await client.init();

// Configura para 7 rolls
client.setAgentMaxRolls(7);

// Executa loop automático
const result = await client.executeAgentLoop(
  'Crie uma função Python que ordene uma lista usando merge sort e explique passo a passo',
  'Qwen3.6-35B'
);

console.log('=== RESULTADO ===');
console.log(`Rolls executados: ${result.totalRolls}`);
console.log(`Sucesso: ${result.success}`);
console.log(`Parou por: ${result.stoppedByCondition || 'conclusão natural'}`);
console.log('\n=== CONTEÚDO FINAL ===');
console.log(result.finalContent);

// Acessa rolls individuais
result.roll.forEach((roll, idx) => {
  console.log(`\n--- Roll ${idx + 1} ---`);
  console.log(roll.content.substring(0, 200) + '...');
});

await client.close();
```

## Customização Avançada

```typescript
client.updateAgentLoopConfig({
  maxRolls: 10,
  stopConditions: [
    'task completed',
    'tarefa concluída',
    'resposta final',
    'não é necessário mais nada'
  ],
  enableToolUse: true,
  enableSelfReflection: true,
  temperature: 0.7,
  maxTokens: 4096
});
```

## Vantagens

1. **Automático**: Executa múltiplas iterações sem intervenção manual
2. **Configurável**: Ajuste número de rolls e condições de parada
3. **Reflexivo**: Cada roll considera o histórico anterior
4. **Flexível**: Modo automático ou manual (roll por roll)
5. **Seguro**: Limites máximos previnem loops infinitos

## Arquivos

- `src/agent-loop-service.ts` - Serviço principal do agent loop
- `src/carcara-client.ts` - Integração com o client (métodos expostos)
