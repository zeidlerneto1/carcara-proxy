# Carcara Proxy 🦙

Um **wrapper de API REST compatível com Ollama** para o sistema LNCC Carcara, que fornece acesso a modelos de linguagem (Llama, etc.) hospedados no LNCC através de uma interface OpenRouter-like com suporte a **MCP Tools** e **integração de buscas**.

---

## 📋 Índice

- [O que é](#o-que-é)
- [Como funciona](#como-funciona)
- [Stack técnico](#stack-técnico)
- [Organização do projeto](#organização-do-projeto)
- [Requisitos](#requisitos)
- [Setup e Instalação](#setup-e-instalação)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Como executar](#como-executar)
- [Endpoints da API](#endpoints-da-api)
- [Exemplos de uso](#exemplos-de-uso)
- [MCP Tools](#mcp-tools)
- [Troubleshooting](#troubleshooting)

---

## O que é

**Carcara Proxy** é um servidor Node.js/TypeScript que atua como intermediário (proxy) entre clientes HTTP e o sistema **Carcara do LNCC** (Laboratório Nacional de Computação Científica). 

Ele:
- ✅ Faz login automático no Carcara via navegador headless (Playwright) + API direta
- ✅ Gerencia sessões e cookies automaticamente
- ✅ Expõe a API em formato **compatível com Ollama** (`/api/chat`, `/api/generate`, etc.)
- ✅ Fornece **MCP Tools customizadas** (web_search, weather, calculator, etc.)
- ✅ Integra **buscas** (DuckDuckGo, Wikipedia, SerpAPI, Brave Search)
- ✅ Mantém histórico de conversas em **IndexedDB**

---

## Como funciona

### Fluxo de inicialização

```
1. Cliente HTTP solicita /api/health ou inicia chat
   ↓
2. CarcaraProxy verifica se cliente está autenticado
   ↓
3. Se não autenticado:
   a) Tenta restaurar sessão salva em .carcara/session.json
   b) Se expirada, tenta login via API (ENV: LNCC_USER/LNCC_PASS)
   c) Se API falhar, abre navegador para login manual
   ↓
4. Após autenticado:
   a) Navega para /service/ para setar cookies corretos
   b) Busca lista de modelos disponíveis
   c) Carrega cache de modelos (com TTL de 1h)
   ↓
5. Cliente pronto para chat/completion
```

### Fluxo de chat

```
Cliente
  ↓
POST /api/chat (ou /api/generate)
  ↓
CarcaraRouter → CarcaraClient
  ↓
Extrai cookies + carcara_auth
  ↓
POST /v1/chat/completions (API interna LNCC)
  ↓
Resposta salva em IndexedDB
  ↓
Retorna response (formato Ollama)
```

---

## Stack técnico

- **Linguagem:** TypeScript 5.5+
- **Runtime:** Node.js 18+
- **Framework Web:** Express.js 4.21+
- **Automação:** Playwright 1.47+ (navegador headless Chromium)
- **HTTP Client:** Axios 1.7+
- **Middleware:** CORS, express.json
- **Build:** TypeScript Compiler (tsc)
- **DevTools:** ESLint, Prettier, @playwright/test

---

## Organização do projeto

```
carcara-proxy/
├── src/
│   ├── index.ts                 # Entry point - exemplo de uso
│   ├── server.ts                # Entry point do servidor Express
│   ├── carcara-client.ts         # Cliente principal (login + chat + models)
│   ├── api-router.ts             # Rotas Express (Ollama + MCP + Search)
│   ├── types.ts                  # Interfaces TypeScript
│   ├── mcp-tools.ts              # Ferramentas MCP customizadas
│   └── search-service.ts         # Serviço de buscas integrado
├── dist/                         # Código compilado (gerado por build)
├── .carcara/                     # Cache local (gerado em runtime)
│   ├── session.json              # Sessão salva
│   ├── login-script.json         # Steps de login
│   ├── models-cache.json         # Cache de modelos
│   └── login-history.log         # Logs de login
├── package.json                  # Dependências e scripts
├── tsconfig.json                 # Configuração TypeScript
├── .env.example                  # Template de variáveis de ambiente
└── README.md                     # Este arquivo

**Como se relacionam:**

1. **server.ts** → inicia express e CarcaraRouter
2. **api-router.ts** → define rotas e usa CarcaraClient
3. **carcara-client.ts** → gerencia login, sessão, modelos e chat
4. **types.ts** → tipos compartilhados entre todos
5. **mcp-tools.ts** → ferramentas executáveis
6. **search-service.ts** → provedores de busca (DuckDuckGo, Wikipedia, etc.)
```

---

## Requisitos

- **Node.js** ≥ 18.0.0
- **npm** ≥ 9.0.0
- **Credentials LNCC** (usuário e senha para autenticação)
  - Domínio: LNCC (padrão, configurável)
  - URL: https://carcara.sinapad.lncc.br (padrão, configurável)

---

## Setup e Instalação

### 1. Clone o repositório

```bash
git clone https://github.com/zeidlerneto1/carcara-proxy.git
cd carcara-proxy
```

### 2. Instale as dependências

```bash
npm install
# ou
npm run setup  # instala + configura Playwright
```

Isso faz:
- Instala pacotes npm
- Baixa Chromium (via Playwright)

### 3. Configure variáveis de ambiente

```bash
cp .env.example .env
# Editar .env com suas credenciais
```

---

## Variáveis de ambiente

Crie um arquivo `.env` na raiz do projeto:

```bash
# Autenticação LNCC
LNCC_USER=seu_usuario_lncc
LNCC_PASS=sua_senha_lncc

# URL base (opcional)
CARCARA_URL=https://carcara.sinapad.lncc.br

# Search providers (opcional)
SERPAPI_KEY=sua_api_key_serpapi    # Para SerpAPI
BRAVE_API_KEY=sua_api_key_brave    # Para Brave Search
```

> ⚠️ **Segurança:** Nunca commite `.env` com credenciais! Use `.env.example` como template.

---

## Como executar

### 1. Compilar TypeScript

```bash
npm run build
# Gera arquivos em ./dist/
```

### 2. Iniciar servidor

**Modo produção:**
```bash
npm start
# Executa: node dist/server.js
```

**Modo desenvolvimento (auto-reload):**
```bash
npm run dev
# Executa: ts-node src/index.ts
```

**Servidor com ts-node direto:**
```bash
npm run server
# Executa: ts-node src/server.ts
```

### 3. Testar se está rodando

```bash
curl http://localhost:3030/api/health
# Resposta esperada:
# {"status":"ok","initialized":true}
```

---

## Endpoints da API

### Health & Status

```http
GET /api/health
→ { status: "ok", initialized: true/false }

GET /ping
→ { pong: true }
```

### Ollama-compatible (standard)

```http
GET /api/tags
→ { models: [ { name, model, size, digest, details }, ... ] }

POST /api/show
Body: { name: "meta-llama/llama-3.1-70b-instruct" }
→ { license, modelfile, details, model_info }

POST /api/generate
Body: { model, prompt, system?, template?, stream?, options? }
→ { model, response, done, context, ... }

POST /api/chat
Body: { model, messages: [ {role, content}, ... ], stream? }
→ { model, message: {role, content, tool_calls?}, done, ... }

POST /api/embed
Body: { model, input }
→ { embeddings: [ [...] ], ... }
```

### MCP Tools

```http
GET /mcp/list
→ { tools: [ { name, description, inputSchema }, ... ] }

POST /mcp/call
Body: { name: "web_search", arguments: { query: "..." } }
→ { result: { ... } }
```

### Search Integration

```http
POST /api/search
Body: { query: "python tutorial", providers: ["duckduckgo", "wikipedia"] }
→ { query, results: [ { title, snippet, url, provider }, ... ] }

POST /api/search/ddg
Body: { query: "weather" }
→ { query, results: [ ... ] }

POST /api/search/wiki
Body: { query: "machine learning" }
→ { query, results: [ ... ] }
```

### Conversations & History

```http
GET /api/conversations
→ { conversations: [ { id, name, model, lasModified }, ... ] }

GET /api/conversations/:id/messages
→ { messages: [ { id, role, content, timestamp }, ... ] }

POST /api/tools/:server/:method
Body: { ... }
→ { result: { ... } }

GET /api/debug/conversations
→ { total, conversations: [ { id, name, messages: [ ... ] }, ... ] }
```

---

## Exemplos de uso

### Exemplo 1: Chat simples com curl

```bash
curl -X POST http://localhost:3030/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta-llama/llama-3.1-70b-instruct",
    "messages": [
      { "role": "user", "content": "Olá! Como você está?" }
    ]
  }'
```

### Exemplo 2: Usar MCP Tool (web search)

```bash
curl -X POST http://localhost:3030/mcp/call \
  -H "Content-Type: application/json" \
  -d '{
    "name": "web_search",
    "arguments": { "query": "Como usar Ollama" }
  }'
```

### Exemplo 3: Listar modelos disponíveis

```bash
curl http://localhost:3030/api/tags
```

### Exemplo 4: Generate (compatível com Ollama)

```bash
curl -X POST http://localhost:3030/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta-llama/llama-3.1-70b-instruct",
    "prompt": "Qual é a capital de Portugal?",
    "stream": false
  }'
```

### Exemplo 5: Busca unificada

```bash
curl -X POST http://localhost:3030/api/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "inteligência artificial",
    "providers": ["duckduckgo", "wikipedia"]
  }'
```

---

## MCP Tools

O projeto inclui ferramentas MCP (Model Context Protocol) customizadas:

### web_search
Busca na web usando DuckDuckGo.
```json
{
  "name": "web_search",
  "arguments": { "query": "string" }
}
```

### get_weather
Obtém clima atual para um local.
```json
{
  "name": "get_weather",
  "arguments": { "location": "São Paulo" }
}
```

### calculate
Realiza cálculos matemáticos.
```json
{
  "name": "calculate",
  "arguments": { "expression": "2 + 2 * 3" }
}
```

### get_time
Retorna hora em um timezone.
```json
{
  "name": "get_time",
  "arguments": { "timezone": "America/Sao_Paulo" }
}
```

### run_command
Executa comandos shell (cuidado!).
```json
{
  "name": "run_command",
  "arguments": { "command": "ls -la" }
}
```

---

## Scripts úteis

```bash
# Build e deploy
npm run build              # Compila TypeScript

# Desenvolvimento
npm run dev               # Executa em modo dev (ts-node)
npm run server            # Executa server com ts-node
npm run debug             # Debug com login interativo

# Qualidade de código
npm run lint              # Verifica linting (ESLint)
npm run lint:fix          # Corrige erros de linting
npm run format            # Formata código (Prettier)
npm run format:check      # Verifica formatação

# Testes
npm test                  # Roda testes (Playwright)
npm run test:headed       # Testes com UI visível

# Limpeza
npm run clean             # Remove dist/ e .carcara/
npm run clean:logs        # Remove apenas logs
```

---

## Troubleshooting

### ❌ Erro: "PHPSESSID não encontrado"

**Causa:** Falha na navegação para `/service/`

**Solução:**
1. Verifique `CARCARA_URL` no `.env`
2. Confirme credenciais `LNCC_USER` e `LNCC_PASS`
3. Tente limpar cache: `npm run clean`
4. Re-execute com `npm run dev`

### ❌ Erro: "Acesso negado (403)"

**Causa:** Cookie `carcara_auth` inválido ou expirado

**Solução:**
1. Limpe cache: `npm run clean`
2. Força novo login: exclua `.carcara/session.json`
3. Re-inicie o servidor

### ❌ Erro: "Chromium não encontrado"

**Causa:** Playwright não instalou o navegador

**Solução:**
```bash
npx playwright install chromium
# ou
npm run setup
```

### ❌ Timeout em `/api/chat`

**Causa:** Modelo lento ou conexão ruim

**Solução:**
1. Aumente `TIMEOUT_CHAT` em `src/carcara-client.ts` (padrão: 60s)
2. Tente modelo mais rápido
3. Verifique conexão com LNCC

### ⚠️ Login manual é necessário (headless mode)

Se o login automático falhar, o navegador será aberto para login manual:

```
👤 LOGIN MANUAL NECESSÁRIO
═══════════════════════════════
   O navegador abrirá para login
   Após logar, aguarde o programa continuar
═══════════════════════════════
```

1. Faça login normalmente no navegador
2. O programa detectará automaticamente após sua autenticação

---

## Estrutura de dados

### Session (salva em `.carcara/session.json`)

```typescript
{
  token: string;
  phpsessid: string;
  carcaraAuth: string;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
  }>;
  timestamp: number;
}
```

### Conversation (IndexedDB)

```typescript
{
  id: string;
  name: string;
  currNode: string;
  lasModified: number;
  model: string;
  system: string;
}
```

### Message (IndexedDB)

```typescript
{
  id: string;
  type: 'user' | 'assistant' | 'system' | 'tool_call';
  role: string;
  timestamp: number;
  content: string;
  parentId?: string;
  children: string[];
  conversationId: string;
  tool_calls?: ToolCall[];
}
```

---

## Performance & Otimizações

- ✅ **Cache de modelos:** TTL 1h na memória + arquivo
- ✅ **Sessão persistida:** Reutiliza cookies por 24h
- ✅ **Headless Chromium:** Sem GUI = menor overhead
- ✅ **IndexedDB local:** Histórico sem banco de dados externo
- ✅ **Connection pooling:** Axios reutiliza conexões

---

## Segurança

⚠️ **IMPORTANTE:**

1. **Nunca** commite `.env` com credenciais
2. Use variáveis de ambiente para produção
3. Não exponha `localhost:3030` na internet sem autenticação
4. A ferramenta `run_command` é perigosa - considere removê-la em produção
5. Logs em `.carcara/*.log` podem conter informações sensíveis

---

## Contribuindo

1. Fork o repositório
2. Crie uma branch (`git checkout -b feature/xyz`)
3. Commit suas mudanças (`git commit -am 'Add xyz'`)
4. Push para a branch (`git push origin feature/xyz`)
5. Abra um Pull Request

---

## License

MIT

---

## Suporte

- 📧 **Email:** peter@example.com
- 🐛 **Issues:** https://github.com/zeidlerneto1/carcara-proxy/issues
- 📚 **Docs LNCC:** https://carcara.sinapad.lncc.br

---

## Autores

- **Peter Zeidler** - Criador inicial

---

**Última atualização:** 2026-07-20  
**Versão:** 1.0.0
