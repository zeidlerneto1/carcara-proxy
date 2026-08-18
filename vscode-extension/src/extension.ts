import * as vscode from 'vscode';
import { CarcaraChatProvider } from './chatProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('Carcara extension is now active!');

    const chatProvider = new CarcaraChatProvider(context.extensionUri);

    // Register the webview provider
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'carcara.chatView',
            chatProvider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        )
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('carcara.openPanel', () => {
            vscode.commands.executeCommand('carcara.chatView.focus');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('carcara.newChat', () => {
            chatProvider.newChat();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('carcara.configureModel', () => {
            configureModel();
        })
    );
}

async function configureModel() {
    const config = vscode.workspace.getConfiguration('carcara');
    
    const model = await vscode.window.showInputBox({
        prompt: 'Enter model name (e.g., Qwen3.6-35B-A3B)',
        value: config.get('model', 'Qwen3.6-35B-A3B'),
        placeHolder: 'Model name'
    });

    if (model) {
        await config.update('model', model, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Model configured: ${model}`);
    }

    const proxyUrl = await vscode.window.showInputBox({
        prompt: 'Enter Carcara Proxy URL',
        value: config.get('proxyUrl', 'http://localhost:3030/v1'),
        placeHolder: 'http://localhost:3030/v1'
    });

    if (proxyUrl) {
        await config.update('proxyUrl', proxyUrl, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Proxy URL configured: ${proxyUrl}`);
    }
}

export function deactivate() {}
