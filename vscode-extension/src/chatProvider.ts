import * as vscode from 'vscode';

export class CarcaraChatProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'carcara.chatView';
    private _view?: vscode.WebviewView;
    private _messages: Array<{ role: string; content: string }> = [];
    private _isStreaming = false;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from webview
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'sendMessage':
                    await this._handleSendMessage(message.content);
                    break;
                case 'newChat':
                    this.newChat();
                    break;
            }
        });
    }

    public newChat() {
        this._messages = [];
        if (this._view) {
            this._view.webview.postMessage({ type: 'clearChat' });
        }
    }

    private async _handleSendMessage(content: string) {
        if (this._isStreaming) return;

        const config = vscode.workspace.getConfiguration('carcara');
        const model = config.get('model', 'Qwen3.6-35B-A3B');
        const proxyUrl = config.get('proxyUrl', 'http://localhost:3030/v1');

        // Add user message to chat
        this._messages.push({ role: 'user', content });
        this._view?.webview.postMessage({ type: 'addMessage', role: 'user', content });

        this._isStreaming = true;
        this._view?.webview.postMessage({ type: 'startStreaming' });

        try {
            const response = await fetch(`${proxyUrl}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model,
                    messages: this._messages,
                    stream: true,
                    enable_tag_parsing: true,
                    max_iterations: 5
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const reader = response.body?.getReader();
            const decoder = new TextDecoder();
            let assistantContent = '';

            while (true) {
                const { done, value } = await reader!.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

                for (const line of lines) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(data);
                        const delta = parsed.choices?.[0]?.delta?.content || '';
                        assistantContent += delta;
                        this._view?.webview.postMessage({ 
                            type: 'streamChunk', 
                            content: delta 
                        });
                    } catch (e) {
                        // Ignore parse errors
                    }
                }
            }

            // Add assistant message to history
            this._messages.push({ role: 'assistant', content: assistantContent });
            this._view?.webview.postMessage({ type: 'endStreaming' });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this._view?.webview.postMessage({ 
                type: 'error', 
                content: `Error: ${errorMessage}` 
            });
            this._isStreaming = false;
        }

        this._isStreaming = false;
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Carcara Chat</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: var(--vscode-font-family);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .header {
            padding: 12px;
            background-color: var(--vscode-titleBar-activeBackground);
            color: var(--vscode-titleBar-activeForeground);
            font-weight: bold;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .header button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 4px 12px;
            cursor: pointer;
            border-radius: 2px;
        }
        .chat-container {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
        }
        .message {
            margin-bottom: 16px;
            padding: 12px;
            border-radius: 8px;
            max-width: 90%;
        }
        .message.user {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            margin-left: auto;
        }
        .message.assistant {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
        }
        .input-container {
            padding: 12px;
            background-color: var(--vscode-input-background);
            display: flex;
            gap: 8px;
        }
        .input-container textarea {
            flex: 1;
            resize: none;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            padding: 8px;
            border-radius: 4px;
            font-family: inherit;
        }
        .input-container button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            cursor: pointer;
            border-radius: 4px;
        }
        .input-container button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        pre {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 8px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 8px 0;
        }
        code {
            font-family: var(--vscode-editor-font-family);
        }
    </style>
</head>
<body>
    <div class="header">
        <span>🤖 Carcara AI</span>
        <button onclick="newChat()">New Chat</button>
    </div>
    <div class="chat-container" id="chatContainer"></div>
    <div class="input-container">
        <textarea 
            id="messageInput" 
            placeholder="Type your message... (Ctrl+Enter to send)"
            rows="3"
            onkeydown="if(event.ctrlKey && event.key === 'Enter') sendMessage()"
        ></textarea>
        <button id="sendBtn" onclick="sendMessage()">Send</button>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        let isStreaming = false;

        function sendMessage() {
            const input = document.getElementById('messageInput');
            const content = input.value.trim();
            if (!content || isStreaming) return;

            vscode.postMessage({ type: 'sendMessage', content });
            input.value = '';
        }

        function newChat() {
            vscode.postMessage({ type: 'newChat' });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            const chatContainer = document.getElementById('chatContainer');

            switch (message.type) {
                case 'clearChat':
                    chatContainer.innerHTML = '';
                    break;
                case 'addMessage':
                    addMessageElement(message.role, message.content);
                    break;
                case 'startStreaming':
                    isStreaming = true;
                    updateSendButton();
                    const assistantDiv = document.createElement('div');
                    assistantDiv.className = 'message assistant';
                    assistantDiv.id = 'streamingMessage';
                    chatContainer.appendChild(assistantDiv);
                    break;
                case 'streamChunk':
                    const streamingMsg = document.getElementById('streamingMessage');
                    if (streamingMsg) {
                        streamingMsg.innerHTML += formatContent(message.content);
                        chatContainer.scrollTop = chatContainer.scrollHeight;
                    }
                    break;
                case 'endStreaming':
                    isStreaming = false;
                    updateSendButton();
                    document.getElementById('streamingMessage')?.removeAttribute('id');
                    break;
                case 'error':
                    addMessageElement('assistant', message.content);
                    isStreaming = false;
                    updateSendButton();
                    break;
            }
        });

        function addMessageElement(role, content) {
            const chatContainer = document.getElementById('chatContainer');
            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${role}\`;
            messageDiv.innerHTML = formatContent(content);
            chatContainer.appendChild(messageDiv);
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }

        function formatContent(text) {
            if (!text) return '';
            // Simple markdown-like formatting
            return text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/\`\`\`([\s\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>')
                .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
                .replace(/\n/g, '<br>');
        }

        function updateSendButton() {
            const btn = document.getElementById('sendBtn');
            btn.disabled = isStreaming;
        }
    </script>
</body>
</html>`;
    }
}
