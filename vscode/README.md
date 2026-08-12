# 🦙 Carcara Chat - Extensão VS Code

Chat com IA **Carcara LNCC** diretamente no VS Code, conectado ao seu proxy local.

## ✨ Funcionalidades

- 💬 **Chat completo** com streaming em tempo real
- 🧠 **Múltiplos modelos** via proxy Carcara (OpenAI/Ollama compatible)
- 🐳 **Sandbox integrado** para executar código Python, JS, Bash
- 🔍 **Busca web** (DuckDuckGo, Wikipedia)
- 🌳 **Árvore de conversas** na sidebar
- 🎨 **Markdown renderizado** com syntax highlighting
- 📝 **Inserir código** diretamente no editor
- ⚙️ **Configurações** via VS Code settings

## 🚀 Instalação

### Pré-requisitos

1. Ter o [Carcara Proxy](https://github.com/zeidlerneto1/carcara-proxy) rodando:
   ```bash
   npm run dev
   ```

2. VS Code 1.85+

### Instalar a Extensão

```bash
cd vscode
npm install
npm run compile
# Pressione F5 para abrir a janela de debug
```

Ou instale o `.vsix`:
```bash
npm run package
code --install-extension carcara-chat-1.0.0.vsix
```

## ⚙️ Configuração

Acesse `File > Preferences > Settings` e procure por "Carcara":

| Configuração | Padrão | Descrição |
|-------------|--------|-----------|
| `carcara.proxyUrl` | `http://localhost:3030` | URL do proxy |
| `carcara.defaultModel` | `DeepSeek-v4-Flash-0731` | Modelo padrão |
| `carcara.streamEnabled` | `true` | Streaming de respostas |
| `carcara.systemMessage` | `...` | Mensagem de sistema |
| `carcara.maxHistoryMessages` | `20` | Histórico máximo |
| `carcara.theme` | `auto` | Tema do chat |
| `carcara.sandboxTimeout` | `30000` | Timeout sandbox (ms) |
| `carcara.enableThinking` | `false` | Modo thinking |

## 🎮 Uso

### Atalhos

| Atalho | Ação |
|--------|------|
| `Ctrl+Shift+C` | Abrir chat |
| `Ctrl+Shift+S` | Executar seleção no sandbox |

### Comandos

- `/quit` - Fechar chat
- `/clear` - Limpar histórico
- `/model <nome>` - Trocar modelo
- `/sandbox <lang> <código>` - Executar no sandbox
- `/stream on|off` - Toggle streaming
- `/search <query>` - Buscar na web

## 📁 Estrutura

```
vscode/
├── src/
│   ├── extension.ts          # Ponto de entrada
│   ├── chatPanel.ts          # WebView do chat
│   ├── apiClient.ts          # Cliente HTTP para o proxy
│   ├── types.ts              # Tipos TypeScript
│   ├── treeProvider.ts       # Provider da árvore de conversas
│   ├── sandboxPanel.ts       # WebView do sandbox
│   └── configManager.ts      # Gerenciador de config
├── media/
│   ├── chat.css              # Estilos do chat
│   ├── chat.js               # Lógica do chat (WebView)
│   └── icon.svg              # Ícone
└── package.json              # Manifesto da extensão
```

## 📝 Licença

MIT - Peter Zeidler
