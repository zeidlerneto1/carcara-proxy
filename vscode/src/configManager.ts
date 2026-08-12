import * as vscode from 'vscode';
import { ProxyConfig } from './types';

const CONFIG_SECTION = 'carcara';

export class ConfigManager {
  static getConfig(): ProxyConfig {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return {
      url: cfg.get('proxyUrl', 'http://localhost:3030'),
      defaultModel: cfg.get('defaultModel', 'DeepSeek-v4-Flash-0731'),
      streamEnabled: cfg.get('streamEnabled', true),
      systemMessage: cfg.get('systemMessage', 'Você é um assistente de programação útil. Responda em português do Brasil.'),
      maxHistoryMessages: cfg.get('maxHistoryMessages', 20),
      theme: cfg.get('theme', 'auto') as 'dark' | 'light' | 'auto',
      sandboxTimeout: cfg.get('sandboxTimeout', 30000),
      enableThinking: cfg.get('enableThinking', false),
    };
  }

  static async updateConfig(updates: Partial<ProxyConfig>): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    for (const [key, value] of Object.entries(updates)) {
      await cfg.update(key, value, true);
    }
  }

  static async configureProxy(): Promise<void> {
    const current = this.getConfig();

    const url = await vscode.window.showInputBox({
      prompt: 'URL do proxy Carcara',
      value: current.url,
      validateInput: (v) => v ? undefined : 'URL é obrigatória',
    });
    if (url === undefined) return;

    const model = await vscode.window.showInputBox({
      prompt: 'Modelo padrão',
      value: current.defaultModel,
    });
    if (model === undefined) return;

    const stream = await vscode.window.showQuickPick(
      [{ label: 'Sim', value: true }, { label: 'Não', value: false }],
      { placeHolder: 'Habilitar streaming?' }
    );
    if (stream === undefined) return;

    await this.updateConfig({
      url,
      defaultModel: model,
      streamEnabled: stream.value,
    });

    vscode.window.showInformationMessage('✅ Configurações do Carcara atualizadas!');
  }

  static async setModel(): Promise<string | undefined> {
    const current = this.getConfig();
    const model = await vscode.window.showInputBox({
      prompt: 'Modelo',
      value: current.defaultModel,
    });
    if (model) {
      await this.updateConfig({ defaultModel: model });
    }
    return model;
  }

  static async setSystemMessage(): Promise<void> {
    const current = this.getConfig();
    const msg = await vscode.window.showInputBox({
      prompt: 'Mensagem de sistema',
      value: current.systemMessage,
      ignoreFocusOut: true,
    });
    if (msg !== undefined) {
      await this.updateConfig({ systemMessage: msg });
    }
  }
}
