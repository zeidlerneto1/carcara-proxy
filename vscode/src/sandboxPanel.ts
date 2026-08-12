import * as vscode from 'vscode';
import { CarcaraApiClient } from './apiClient';

export class SandboxPanel {
  public static currentPanel: SandboxPanel | undefined;
  public static readonly viewType = 'carcaraSandbox';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _api: CarcaraApiClient;

  public static createOrShow(extensionUri: vscode.Uri): SandboxPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (SandboxPanel.currentPanel) {
      SandboxPanel.currentPanel._panel.reveal(column);
      return SandboxPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      SandboxPanel.viewType,
      '🐳 Carcara Sandbox',
      column || vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      }
    );

    SandboxPanel.currentPanel = new SandboxPanel(panel, extensionUri);
    return SandboxPanel.currentPanel;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._api = new CarcaraApiClient();

    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.type) {
          case 'execute':
            await this._execute(message.code, message.language);
            break;
          case 'getStatus':
            await this._getStatus();
            break;
        }
      },
      null,
      this._disposables
    );
  }

  private async _execute(code: string, language: string): Promise<void> {
    this._panel.webview.postMessage({ type: 'executing' });
    try {
      const result = await this._api.executeSandbox(code, language);
      this._panel.webview.postMessage({ type: 'result', result });
    } catch (err: any) {
      this._panel.webview.postMessage({ type: 'error', message: err.message });
    }
  }

  private async _getStatus(): Promise<void> {
    try {
      const res = await fetch(`${this._api.getConfig().url}/api/sandbox/status`);
      const status = await res.json();
      this._panel.webview.postMessage({ type: 'status', status });
    } catch (err: any) {
      this._panel.webview.postMessage({ type: 'statusError', message: err.message });
    }
  }

  private _update(): void {
    const webview = this._panel.webview;
    webview.html = this._getHtmlForWebview(webview);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.css')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link href="${styleUri}" rel="stylesheet">
  <title>Carcara Sandbox</title>
  <style>
    body { padding: 0; margin: 0; height: 100vh; display: flex; flex-direction: column; }
    #sandbox-header { padding: 12px 16px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); display: flex; gap: 10px; align-items: center; }
    #lang-select { padding: 6px 10px; border-radius: 4px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
    #btn-run { padding: 6px 14px; background: #238636; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 600; }
    #btn-run:hover { background: #2ea043; }
    #editor { flex: 1; display: flex; }
    #code-editor { flex: 1; padding: 12px; font-family: 'Fira Code', 'Consolas', monospace; font-size: 13px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); border: none; resize: none; outline: none; line-height: 1.6; }
    #output-panel { width: 50%; border-left: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; }
    #output-header { padding: 8px 12px; background: var(--vscode-panel-background); border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px; font-weight: 600; color: var(--vscode-foreground); display: flex; justify-content: space-between; align-items: center; }
    #output { flex: 1; padding: 12px; font-family: 'Fira Code', monospace; font-size: 12px; overflow: auto; white-space: pre-wrap; }
    #status-bar { padding: 6px 12px; background: var(--vscode-statusBar-background); color: var(--vscode-statusBar-foreground); font-size: 11px; display: flex; gap: 12px; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 4px; }
    .status-online { background: #3fb950; }
    .status-offline { background: #f85149; }
    .output-stdout { color: var(--vscode-terminal-ansiGreen); }
    .output-stderr { color: var(--vscode-terminal-ansiRed); }
    .output-info { color: var(--vscode-terminal-ansiCyan); }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.3); border-top-color: white; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div id="sandbox-header">
    <select id="lang-select">
      <option value="python">Python</option>
      <option value="javascript">JavaScript</option>
      <option value="bash">Bash</option>
    </select>
    <button id="btn-run">▶ Executar</button>
    <span id="exec-status"></span>
  </div>
  <div id="editor">
    <textarea id="code-editor" placeholder="# Digite seu código aqui...
print('Hello, Carcara!')" spellcheck="false"></textarea>
    <div id="output-panel">
      <div id="output-header">
        <span>📤 Saída</span>
        <button id="btn-clear-output" style="background:none;border:none;color:var(--vscode-foreground);cursor:pointer;font-size:12px;">Limpar</button>
      </div>
      <div id="output"></div>
    </div>
  </div>
  <div id="status-bar">
    <span><span class="status-dot status-offline" id="docker-dot"></span>Docker</span>
    <span><span class="status-dot status-offline" id="local-dot"></span>Local</span>
    <span id="mode-label">Modo: --</span>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const codeEditor = document.getElementById('code-editor');
    const output = document.getElementById('output');
    const btnRun = document.getElementById('btn-run');
    const langSelect = document.getElementById('lang-select');
    const execStatus = document.getElementById('exec-status');

    // Solicitar status ao carregar
    vscode.postMessage({ type: 'getStatus' });

    btnRun.addEventListener('click', () => {
      const code = codeEditor.value;
      const language = langSelect.value;
      if (!code.trim()) return;
      output.innerHTML = '<div class="output-info"><span class="spinner"></span> Executando...</div>';
      execStatus.innerHTML = '<span class="spinner"></span>';
      vscode.postMessage({ type: 'execute', code, language });
    });

    document.getElementById('btn-clear-output').addEventListener('click', () => {
      output.innerHTML = '';
    });

    codeEditor.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = codeEditor.selectionStart;
        const end = codeEditor.selectionEnd;
        codeEditor.value = codeEditor.value.substring(0, start) + '    ' + codeEditor.value.substring(end);
        codeEditor.selectionStart = codeEditor.selectionEnd = start + 4;
      }
      if (e.ctrlKey && e.key === 'Enter') {
        btnRun.click();
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'executing':
          execStatus.innerHTML = '<span class="spinner"></span>';
          break;
        case 'result':
          execStatus.innerHTML = '';
          const r = msg.result;
          let html = '';
          if (r.stdout) html += '<div class="output-stdout">' + escapeHtml(r.stdout) + '</div>';
          if (r.stderr) html += '<div class="output-stderr">' + escapeHtml(r.stderr) + '</div>';
          html += '<div class="output-info">⏱️ ' + r.durationMs + 'ms | Exit: ' + r.exitCode + ' | Modo: ' + r.mode + '</div>';
          output.innerHTML = html;
          break;
        case 'error':
          execStatus.innerHTML = '';
          output.innerHTML = '<div class="output-stderr">❌ ' + escapeHtml(msg.message) + '</div>';
          break;
        case 'status':
          const s = msg.status;
          document.getElementById('docker-dot').className = 'status-dot ' + (s.dockerAvailable ? 'status-online' : 'status-offline');
          document.getElementById('local-dot').className = 'status-dot ' + (s.localAvailable ? 'status-online' : 'status-offline');
          document.getElementById('mode-label').textContent = 'Modo: ' + s.mode;
          break;
      }
    });

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    SandboxPanel.currentPanel = undefined;
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
