import * as vscode from 'vscode';
import { ChatPanel } from './chatPanel';
import { SandboxPanel } from './sandboxPanel';
import { ConversationsTreeProvider, ModelsTreeProvider } from './treeProvider';
import { ConfigManager } from './configManager';
import { CarcaraApiClient } from './apiClient';
import { Conversation } from './types';

export function activate(context: vscode.ExtensionContext): void {
  console.log('🦙 Carcara Chat extension ativada');

  // Set context para mostrar views
  vscode.commands.executeCommand('setContext', 'carcara.enabled', true);

  // Providers
  const conversationsProvider = new ConversationsTreeProvider(context);
  const modelsProvider = new ModelsTreeProvider();

  // Registro de views
  vscode.window.registerTreeDataProvider('carcaraConversations', conversationsProvider);
  vscode.window.registerTreeDataProvider('carcaraModels', modelsProvider);

  // Comandos
  const commands = [
    // Abrir chat
    vscode.commands.registerCommand('carcara.openChat', () => {
      ChatPanel.createOrShow(context.extensionUri, conversationsProvider);
    }),

    // Abrir sandbox
    vscode.commands.registerCommand('carcara.openSandbox', () => {
      SandboxPanel.createOrShow(context.extensionUri);
    }),

    // Nova conversa
    vscode.commands.registerCommand('carcara.newConversation', () => {
      const conv = conversationsProvider.addConversation(
        `Conversa ${new Date().toLocaleString()}`
      );
      ChatPanel.createOrShow(context.extensionUri, conversationsProvider, conv);
      vscode.window.showInformationMessage('✅ Nova conversa criada!');
    }),

    // Limpar histórico
    vscode.commands.registerCommand('carcara.clearHistory', async () => {
      const answer = await vscode.window.showWarningMessage(
        'Tem certeza que deseja limpar todo o histórico?',
        'Sim',
        'Não'
      );
      if (answer === 'Sim') {
        conversationsProvider.clearAll();
        if (ChatPanel.currentPanel) {
          ChatPanel.currentPanel.dispose();
        }
        vscode.window.showInformationMessage('🧹 Histórico limpo!');
      }
    }),

    // Atualizar conversas
    vscode.commands.registerCommand('carcara.refreshConversations', () => {
      conversationsProvider.refresh();
      vscode.window.showInformationMessage('🔄 Conversas atualizadas!');
    }),

    // Abrir conversa
    vscode.commands.registerCommand('carcara.openConversation', (item: any) => {
      const conv = item?.conversation || item;
      if (conv) {
        ChatPanel.createOrShow(context.extensionUri, conversationsProvider, conv);
      }
    }),

    // Excluir conversa
    vscode.commands.registerCommand('carcara.deleteConversation', async (item: any) => {
      const conv = item?.conversation || item;
      if (!conv) return;
      const answer = await vscode.window.showWarningMessage(
        `Excluir "${conv.name}"?`,
        'Sim',
        'Não'
      );
      if (answer === 'Sim') {
        conversationsProvider.deleteConversation(conv.id);
        vscode.window.showInformationMessage('🗑️ Conversa excluída!');
      }
    }),

    // Buscar na web
    vscode.commands.registerCommand('carcara.searchWeb', async () => {
      const query = await vscode.window.showInputBox({
        prompt: 'O que deseja buscar?',
        placeHolder: 'Digite sua busca...',
      });
      if (!query) return;

      const api = new CarcaraApiClient();
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Buscando...' },
        async () => {
          try {
            const results = await api.searchDuckDuckGo(query);
            const panel = vscode.window.createWebviewPanel(
              'carcaraSearch',
              `🔍 ${query}`,
              vscode.ViewColumn.One,
              { enableScripts: true }
            );
            panel.webview.html = getSearchHtml(results);
          } catch (err: any) {
            vscode.window.showErrorMessage(`❌ Erro na busca: ${err.message}`);
          }
        }
      );
    }),

    // Executar código no sandbox
    vscode.commands.registerCommand('carcara.executeCode', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('Nenhum editor ativo');
        return;
      }

      const selection = editor.selection;
      const code = editor.document.getText(selection.isEmpty
        ? new vscode.Range(0, 0, editor.document.lineCount, 0)
        : selection
      );

      if (!code.trim()) {
        vscode.window.showWarningMessage('Nenhum código selecionado');
        return;
      }

      // Detectar linguagem
      const langMap: Record<string, string> = {
        python: 'python',
        javascript: 'javascript',
        typescript: 'javascript',
        shellscript: 'bash',
        bash: 'bash',
      };
      const language = langMap[editor.document.languageId] || 'python';

      const api = new CarcaraApiClient();
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Executando no sandbox...' },
        async () => {
          try {
            const result = await api.executeSandbox(code, language);
            const channel = vscode.window.createOutputChannel('Carcara Sandbox');
            channel.clear();
            channel.appendLine(`=== Carcara Sandbox (${language}) ===`);
            channel.appendLine(`⏱️ Duração: ${result.durationMs}ms | Exit: ${result.exitCode} | Modo: ${result.mode}`);
            if (result.stdout) channel.appendLine(`\n📤 stdout:\n${result.stdout}`);
            if (result.stderr) channel.appendLine(`\n📤 stderr:\n${result.stderr}`);
            channel.show();
          } catch (err: any) {
            vscode.window.showErrorMessage(`❌ Sandbox: ${err.message}`);
          }
        }
      );
    }),

    // Configurar proxy
    vscode.commands.registerCommand('carcara.configureProxy', () => {
      ConfigManager.configureProxy();
    }),

    // Inserir código no editor
    vscode.commands.registerCommand('carcara.insertCode', async (code: string) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('Nenhum editor ativo');
        return;
      }
      await editor.edit((editBuilder) => {
        editBuilder.insert(editor.selection.active, code);
      });
    }),

    // Set model
    vscode.commands.registerCommand('carcara.setModel', async (modelId?: string) => {
      if (!modelId) {
        modelId = await ConfigManager.setModel();
      }
      if (modelId) {
        vscode.window.showInformationMessage(`🧠 Modelo: ${modelId}`);
      }
    }),

    // Carregar modelos
    vscode.commands.registerCommand('carcara.loadModels', async () => {
      const api = new CarcaraApiClient();
      try {
        const models = await api.getModels();
        modelsProvider.refresh(models.map(m => ({ id: m.id, name: m.name || m.id })));
      } catch (err: any) {
        vscode.window.showErrorMessage(`❌ ${err.message}`);
      }
    }),
  ];

  context.subscriptions.push(...commands);

  // Carregar modelos automaticamente
  setTimeout(() => {
    vscode.commands.executeCommand('carcara.loadModels');
  }, 2000);
}

export function deactivate(): void {
  console.log('🦙 Carcara Chat extension desativada');
}

function getSearchHtml(results: any): string {
  const items = results.results?.map((r: any) => `
    <div style="margin-bottom:16px;padding:12px;border:1px solid var(--vscode-panel-border);border-radius:6px;">
      <a href="${r.url}" style="color:#4fc1ff;font-size:14px;font-weight:600;text-decoration:none;">${r.title}</a>
      <div style="color:#3fb950;font-size:11px;margin:4px 0;">${r.url}</div>
      <div style="color:var(--vscode-foreground);font-size:12px;line-height:1.5;">${r.snippet}</div>
    </div>
  `).join('') || '<p>Nenhum resultado encontrado.</p>';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Busca</title></head>
<body style="padding:20px;font-family:system-ui,sans-serif;color:var(--vscode-foreground);background:var(--vscode-editor-background);">
  <h2 style="color:#4fc1ff;">🔍 Resultados da Busca</h2>
  <div>${items}</div>
</body>
</html>`;
}
