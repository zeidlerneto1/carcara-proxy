import * as vscode from 'vscode';
import { Conversation } from './types';

export class ConversationTreeItem extends vscode.TreeItem {
  constructor(
    public readonly conversation: Conversation,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(conversation.name, collapsibleState);
    this.tooltip = `${conversation.name} (${new Date(conversation.lastModified).toLocaleString()})`;
    this.description = new Date(conversation.lastModified).toLocaleDateString();
    this.contextValue = 'conversation';
    this.iconPath = new vscode.ThemeIcon('comment');
    this.command = {
      command: 'carcara.openConversation',
      title: 'Abrir Conversa',
      arguments: [conversation],
    };
  }
}

export class ConversationsTreeProvider implements vscode.TreeDataProvider<ConversationTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<ConversationTreeItem | undefined | null | void> =
    new vscode.EventEmitter<ConversationTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<ConversationTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private conversations: Conversation[] = [];
  private storage: vscode.Memento;

  constructor(context: vscode.ExtensionContext) {
    this.storage = context.globalState;
    this.loadConversations();
  }

  refresh(): void {
    this.loadConversations();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ConversationTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ConversationTreeItem[] {
    return this.conversations.map(
      conv => new ConversationTreeItem(conv, vscode.TreeItemCollapsibleState.None)
    );
  }

  getConversations(): Conversation[] {
    return [...this.conversations];
  }

  getConversation(id: string): Conversation | undefined {
    return this.conversations.find(c => c.id === id);
  }

  addConversation(name: string, model?: string): Conversation {
    const conv: Conversation = {
      id: `conv-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      name: name || 'Nova Conversa',
      lastModified: Date.now(),
      messages: [],
      model,
    };
    this.conversations.unshift(conv);
    this.saveConversations();
    this._onDidChangeTreeData.fire();
    return conv;
  }

  updateConversation(conv: Conversation): void {
    const idx = this.conversations.findIndex(c => c.id === conv.id);
    if (idx >= 0) {
      conv.lastModified = Date.now();
      this.conversations[idx] = conv;
      this.saveConversations();
      this._onDidChangeTreeData.fire();
    }
  }

  deleteConversation(id: string): void {
    this.conversations = this.conversations.filter(c => c.id !== id);
    this.saveConversations();
    this._onDidChangeTreeData.fire();
  }

  clearAll(): void {
    this.conversations = [];
    this.saveConversations();
    this._onDidChangeTreeData.fire();
  }

  private loadConversations(): void {
    const data = this.storage.get<Conversation[]>('carcara.conversations', []);
    this.conversations = data;
  }

  private saveConversations(): void {
    this.storage.update('carcara.conversations', this.conversations);
  }
}

export class ModelsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> =
    new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private models: Array<{ id: string; name?: string }> = [];

  refresh(models: Array<{ id: string; name?: string }>): void {
    this.models = models;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    return this.models.map(m => {
      const item = new vscode.TreeItem(m.name || m.id, vscode.TreeItemCollapsibleState.None);
      item.description = m.id;
      item.iconPath = new vscode.ThemeIcon('symbol-misc');
      item.command = {
        command: 'carcara.setModel',
        title: 'Usar Modelo',
        arguments: [m.id],
      };
      return item;
    });
  }
}
