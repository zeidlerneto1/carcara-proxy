"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const chatProvider_1 = require("./chatProvider");
function activate(context) {
    console.log('Carcara extension is now active!');
    const chatProvider = new chatProvider_1.CarcaraChatProvider(context.extensionUri);
    // Register the webview provider
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('carcara.chatView', chatProvider, {
        webviewOptions: {
            retainContextWhenHidden: true
        }
    }));
    // Register commands
    context.subscriptions.push(vscode.commands.registerCommand('carcara.openPanel', () => {
        vscode.commands.executeCommand('carcara.chatView.focus');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('carcara.newChat', () => {
        chatProvider.newChat();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('carcara.configureModel', () => {
        configureModel();
    }));
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
function deactivate() { }
//# sourceMappingURL=extension.js.map