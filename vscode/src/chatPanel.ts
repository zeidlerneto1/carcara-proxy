import * as vscode from 'vscode';
import { CarcaraApiClient } from './apiClient';
import { ConversationsTreeProvider } from './treeProvider';
import { ConfigManager } from './configManager';
import { ChatMessage, Conversation } from './types';

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  public static readonly viewType = 'carcaraChat';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _api: CarcaraApiClient;
  private _treeProvider: ConversationsTreeProvider;
  private _currentConversation: Conversation | null = null;
  private _messages: ChatMessage[] = [];
  private _isGenerating = false;

  public static createOrShow(
    extensionUri: vscode.Uri,
    treeProvider: ConversationsTreeProvider,
    conversation?: Conversation
  ): ChatPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel._panel.reveal(column);
      if (conversation) {
        ChatPanel.currentPanel.loadConversation(conversation);
      }
      return ChatPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      ChatPanel.viewType,
      '🦙 Carcara Chat',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      }
    );

    ChatPanel.currentPanel = new ChatPanel(panel, extensionUri, treeProvider, conversation);
    return ChatPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    treeProvider: ConversationsTreeProvider,
    conversation?: Conversation
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._treeProvider = treeProvider;
    this._api = new CarcaraApiClient();

    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.type) {
          case 'sendMessage':
            await this._handleUserMessage(message.text);
            break;
          case 'executeCode':
            await this._handleExecuteCode(message.code, message.language);
            break;
          case 'search':
            await this._handleSearch(message.query);
            break;
          case 'newConversation':
            this._startNewConversation();
            break;
          case 'clearHistory':
            this._clearHistory();
            break;
          case 'abort':
            this._api.abort();
            this._isGenerating = false;
            break;
          case 'insertCode':
            await this._insertCode(message.code);
            break;
          case 'copyCode':
            await vscode.env.clipboard.writeText(message.code);
            vscode.window.showInformationMessage('Código copiado!');
            break;
          case 'openSettings':
            await ConfigManager.configureProxy();
            break;
          case 'getModels':
            await this._sendModels();
            break;
          case 'setModel':
            await ConfigManager.updateConfig({ defaultModel: message.model });
            this._panel.webview.postMessage({ type: 'modelSet', model: message.model });
            break;
          case 'getConfig':
            this._panel.webview.postMessage({
              type: 'config',
              config: this._api.getConfig(),
            });
            break;
        }
      },
      null,
      this._disposables
    );

    if (conversation) {
      this.loadConversation(conversation);
    } else {
      this._checkProxyHealth();
    }
  }

  private async _checkProxyHealth(): Promise<void> {
    const health = await this._api.checkHealth();
    this._panel.webview.postMessage({
      type: 'health',
      status: health.status,
      initialized: health.initialized,
    });
  }

  private async _sendModels(): Promise<void> {
    try {
      const models = await this._api.getModels();
      this._panel.webview.postMessage({ type: 'models', models });
    } catch (err: any) {
      this._panel.webview.postMessage({ type: 'error', message: err.message });
    }
  }

  private async _handleUserMessage(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Comandos especiais
    if (trimmed === '/quit') {
      this._panel.dispose();
      return;
    }
    if (trimmed === '/clear') {
      this._clearHistory();
      return;
    }
    if (trimmed.startsWith('/model ')) {
      const model = trimmed.slice(7).trim();
      await ConfigManager.updateConfig({ defaultModel: model });
      this._panel.webview.postMessage({
        type: 'systemMessage',
        text: `🔧 Modelo alterado para: ${model}`,
      });
      return;
    }
    if (trimmed.startsWith('/sandbox ')) {
      const rest = trimmed.slice(9).trim();
      const spaceIdx = rest.indexOf(' ');
      if (spaceIdx === -1) {
        this._panel.webview.postMessage({
          type: 'error',
          message: 'Uso: /sandbox <python|javascript|bash> <código>',
        });
        return;
      }
      const lang = rest.slice(0, spaceIdx);
      const code = rest.slice(spaceIdx + 1);
      await this._handleExecuteCode(code, lang);
      return;
    }
    if (trimmed.startsWith('/search ')) {
      await this._handleSearch(trimmed.slice(8).trim());
      return;
    }

    // Mensagem normal
    const userMsg: ChatMessage = {
      role: 'user',
      content: trimmed,
      id: `msg-${Date.now()}`,
      timestamp: Date.now(),
    };
    this._messages.push(userMsg);
    this._panel.webview.postMessage({ type: 'userMessage', message: userMsg });

    if (this._currentConversation) {
      this._currentConversation.messages = [...this._messages];
      this._treeProvider.updateConversation(this._currentConversation);
    }

    await this._generateResponse();
  }

  private async _generateResponse(): Promise<void> {
    if (this._isGenerating) return;
    this._isGenerating = true;

    const config = this._api.getConfig();
    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: '',
      id: `msg-${Date.now()}`,
      timestamp: Date.now(),
    };

    this._panel.webview.postMessage({
      type: 'assistantStart',
      message: assistantMsg,
    });

    try {
      if (config.streamEnabled) {
        let fullContent = '';
        for await (const chunk of this._api.chatCompletionStream(this._messages)) {
          const content = chunk.choices?.[0]?.delta?.content || '';
          if (content) {
            fullContent += content;
            this._panel.webview.postMessage({
              type: 'assistantChunk',
              id: assistantMsg.id,
              chunk: content,
            });
          }
        }
        assistantMsg.content = fullContent;
      } else {
        const response = await this._api.chatCompletion(this._messages);
        assistantMsg.content = response.choices?.[0]?.message?.content || '';
        assistantMsg.model = response.model;
        this._panel.webview.postMessage({
          type: 'assistantComplete',
          id: assistantMsg.id,
          content: assistantMsg.content,
          model: response.model,
        });
      }
    } catch (err: any) {
      this._panel.webview.postMessage({
        type: 'error',
        message: `❌ Erro: ${err.message}`,
      });
      assistantMsg.content = `Erro: ${err.message}`;
    } finally {
      this._isGenerating = false;
      this._messages.push(assistantMsg);
      if (this._currentConversation) {
        this._currentConversation.messages = [...this._messages];
        this._treeProvider.updateConversation(this._currentConversation);
      }
      this._panel.webview.postMessage({ type: 'generationComplete' });
    }
  }

  private async _handleExecuteCode(code: string, language: string): Promise<void> {
    this._panel.webview.postMessage({
      type: 'sandboxStart',
      language,
    });

    try {
      const result = await this._api.executeSandbox(code, language);
      this._panel.webview.postMessage({
        type: 'sandboxResult',
        result,
      });
    } catch (err: any) {
      this._panel.webview.postMessage({
        type: 'sandboxError',
        error: err.message,
      });
    }
  }

  private async _handleSearch(query: string): Promise<void> {
    if (!query) return;
    this._panel.webview.postMessage({ type: 'searchStart', query });

    try {
      const results = await this._api.searchDuckDuckGo(query);
      this._panel.webview.postMessage({
        type: 'searchResult',
        results,
      });
    } catch (err: any) {
      this._panel.webview.postMessage({
        type: 'searchError',
        error: err.message,
      });
    }
  }

  private async _insertCode(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Nenhum editor ativo');
      return;
    }
    await editor.edit((editBuilder) => {
      editBuilder.insert(editor.selection.active, code);
    });
    vscode.window.showInformationMessage('✅ Código inserido!');
  }

  private _startNewConversation(): void {
    this._currentConversation = this._treeProvider.addConversation(
      `Conversa ${new Date().toLocaleString()}`,
      this._api.getConfig().defaultModel
    );
    this._messages = [];
    this._panel.webview.postMessage({ type: 'newConversation' });
    this._panel.title = `🦙 ${this._currentConversation.name}`;
  }

  private _clearHistory(): void {
    this._messages = [];
    if (this._currentConversation) {
      this._currentConversation.messages = [];
      this._treeProvider.updateConversation(this._currentConversation);
    }
    this._panel.webview.postMessage({ type: 'clearHistory' });
  }

  public loadConversation(conversation: Conversation): void {
    this._currentConversation = conversation;
    this._messages = [...(conversation.messages || [])];
    this._panel.webview.postMessage({
      type: 'loadConversation',
      conversation,
    });
    this._panel.title = `🦙 ${conversation.name}`;
  }

  public getCurrentConversation(): Conversation | null {
    return this._currentConversation;
  }

  private _update(): void {
    const webview = this._panel.webview;
    webview.html = this._getHtmlForWebview(webview);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.js')
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link href="${styleUri}" rel="stylesheet">
  <title>Carcara Chat</title>
</head>
<body>
  <div id="app">
    <div id="header">
      <div id="header-left">
        <span id="status-indicator" class="status-offline" title="Proxy offline"></span>
        <span id="model-badge">Carregando...</span>
      </div>
      <div id="header-actions">
        <button id="btn-new" title="Nova conversa (Ctrl+N)">➕</button>
        <button id="btn-clear" title="Limpar histórico">🧹</button>
        <button id="btn-settings" title="Configurações">⚙️</button>
        <button id="btn-models" title="Modelos">🧠</button>
      </div>
    </div>

    <div id="messages"></div>

    <div id="typing-indicator" class="hidden">
      <div class="dot-flashing"></div>
    </div>

    <div id="input-area">
      <div id="input-row">
        <textarea
          id="message-input"
          placeholder="Digite sua mensagem... (Ctrl+Enter para enviar)"
          rows="1"
        ></textarea>
        <button id="btn-send" title="Enviar (Ctrl+Enter)">➤</button>
        <button id="btn-abort" class="hidden" title="Abortar">⏹</button>
      </div>
      <div id="input-hints">
        <span class="hint">/clear</span>
        <span class="hint">/model</span>
        <span class="hint">/sandbox</span>
        <span class="hint">/search</span>
      </div>
    </div>
  </div>

  <div id="models-modal" class="modal hidden">
    <div class="modal-content">
      <div class="modal-header">
        <h3>🧠 Modelos Disponíveis</h3>
        <button class="modal-close">&times;</button>
      </div>
      <div id="models-list"></div>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  public dispose(): void {
    ChatPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) x.dispose();
    }
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
