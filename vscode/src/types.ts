export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  id?: string;
  timestamp?: number;
  model?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface Conversation {
  id: string;
  name: string;
  lastModified: number;
  messages: ChatMessage[];
  model?: string;
  thinkingEnabled?: boolean;
}

export interface ModelInfo {
  id: string;
  name?: string;
  description?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  mode: 'docker' | 'local';
}

export interface SearchResult {
  provider: string;
  results: Array<{
    title: string;
    url: string;
    snippet: string;
  }>;
}

export interface ProxyConfig {
  url: string;
  defaultModel: string;
  streamEnabled: boolean;
  systemMessage: string;
  maxHistoryMessages: number;
  theme: 'dark' | 'light' | 'auto';
  sandboxTimeout: number;
  enableThinking: boolean;
}

export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
    };
    finish_reason: string | null;
  }>;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface HealthStatus {
  status: string;
  initialized: boolean;
}
