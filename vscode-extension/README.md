# Carcara - VSCode Extension

Frontend para interagir com modelos Qwen, DeepSeek e agentes via Carcara Proxy.

## Funcionalidades

- 💬 **Chat em Tempo Real**: Interface de chat com streaming de respostas
- 🤖 **Modo Agente**: Suporte a execução de ferramentas via tags XML
- 📁 **Integração com Arquivos**: Leitura e escrita de arquivos no workspace
- ⚙️ **Configuração de Modelo**: Seleção de modelos Qwen, DeepSeek e outros
- 🎨 **Tema Integrado**: UI que segue o tema do VSCode

## Comandos

- `Carcara: Open Chat Panel` - Abre o painel de chat na sidebar
- `Carcara: New Chat` - Inicia uma nova conversa
- `Carcara: Configure Model` - Configura modelo e URL do proxy

## Instalação

1. Abra o terminal na pasta `vscode-extension`
2. Execute `npm install`
3. Execute `npm run compile`
4. Pressione `F5` no VSCode para iniciar a extensão em modo debug

Ou instale o `.vsix`:
```bash
npm install -g @vscode/vsce
vsce package
# Instale o arquivo .vsix gerado no VSCode
```

## Configuração

No VSCode, vá em Settings → Extensions → Carcara e configure:

- **Model**: Nome do modelo (ex: `Qwen3.6-35B-A3B`, `DeepSeek-v4-Flash-0731`)
- **Proxy URL**: URL do Carcara Proxy (padrão: `http://localhost:3030/v1`)

## Uso

1. Certifique-se que o Carcara Proxy está rodando em `localhost:3030`
2. Clique no ícone do Carcara na barra lateral do VSCode
3. Digite sua mensagem e pressione `Ctrl+Enter` ou clique em Send
4. Para novo chat, clique em "New Chat" no cabeçalho

## Tags de Agente

O agente suporta as seguintes tags para executar ações:

- `<think>` - Pensamento interno
- `<read_file>` - Ler arquivo
- `<write_file>` - Escrever arquivo
- `<run_command>` - Executar comando
- `<search_web>` - Buscar na web
- `<browse_url>` - Navegar em URL
- `<final>` - Resposta final

Exemplo:
```
<think>Vou analisar o arquivo...</think>
<read_file>{"path": "./src/main.ts"}</read_file>
<final>O arquivo contém...</final>
```

## Requisitos

- VSCode 1.85.0+
- Carcara Proxy rodando em localhost:3030
- Node.js 18+
