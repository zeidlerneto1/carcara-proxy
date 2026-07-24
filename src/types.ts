export interface CarcaraConfig {
  domain?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
}

export interface LlamaMessage {
  id: string;
  convId: string;
  role: 'system' | 'user' | 'assistant';
  type: 'root' | 'text';
  content: string;
  parent?: string;
  children: string[];
  timestamp: number;
}

export interface ConversationNode {
  id: string;
  name: string;
  lastModified: number;
  currNode: string;
  mcpServerOverrides: Array<{ serverId: string; enabled: boolean }>;
  thinkingEnabled: boolean;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface MCPListResponse {
  jsonrpc: string;
  id: number;
  result?: {
    tools: {
      name: string;
      description?: string;
      inputSchema?: any;
    }[];
  };
}

export interface LoginPayload {
  action: 'login';
  user: string;
  password: string;
  domain: string;
}

export interface LoginResponse {
  success: boolean;
  token?: string;
  message?: string;
  user?: {
    id: string;
    name: string;
    email: string;
    domain: string;
  };
}

export interface ModelInfo {
  id: string;
  name?: string;
  description?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
}

export interface ModelsResponse {
  data: ModelInfo[];
}

export interface LoginStep {
  type: 'navigate' | 'click' | 'fill' | 'wait' | 'select' | 'press' | 'api_request';
  selector?: string;
  value?: string;
  url?: string;
  timeout?: number;
  description?: string;
  alternativeSelectors?: string[];
  apiConfig?: {
    method: 'GET' | 'POST';
    url: string;
    payload?: any;
    headers?: Record<string, string>;
  };
}

export interface LoginScript {
  version: string;
  url: string;
  createdAt: string;
  steps: LoginStep[];
  successUrlPattern?: string;
  successIndicators?: {
    urlContains?: string[];
    cookieNames?: string[];
    elementSelector?: string;
    responseStatus?: number;
  };
}

export interface StoredSession {
  token: string;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  }>;
  phpsessid?: string;
  timestamp: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
  handler: (params: any) => Promise<any>;
}

export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
  source: string;
}