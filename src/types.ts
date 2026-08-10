export interface CarcaraConfig {
  domain?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
}

// ============================================================================
// INDEXEDDB - Estrutura real do LlamaUI (baseado no dump)
// ============================================================================

export interface LlamaMessage {
  id: string | number;
  convId: string;
  role: 'system' | 'user' | 'assistant';
  type: 'root' | 'text';
  content: string;
  parent: string | number | null;
  children: (string | number)[];
  timestamp: number;
  // Campos do assistant
  toolCalls?: string;           // string no dump real (não array!)
  model?: string;               // ex: "DeepSeek-v4-Flash-0731"
  completionId?: string;        // ex: "chatcmpl-..."
  timings?: MessageTimings;
  // Campos do user
  extra?: any[];
}

export interface MessageTimings {
  cache_n: number;
  prompt_n: number;
  prompt_ms: number;
  prompt_per_token_ms: number;
  prompt_per_second: number;
  predicted_n: number;
  predicted_ms: number;
  predicted_per_token_ms: number;
  predicted_per_second: number;
}

export interface ConversationNode {
  id: string;
  name: string;
  lastModified: number;
  currNode: string | number;
  thinkingEnabled?: boolean;
  // NOTA: mcpServerOverrides NAO está no IndexedDB, está no localStorage
}

// ============================================================================
// API RESPONSES
// ============================================================================

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

// ============================================================================
// LOGIN
// ============================================================================

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

// ============================================================================
// MODELOS
// ============================================================================

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

// ============================================================================
// LOGIN RECORDER
// ============================================================================

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

// ============================================================================
// CHAT / MCP
// ============================================================================

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

// ============================================================================
// LLAMAUI CONFIG (localStorage)
// ============================================================================

export interface LlamaUIConfig {
  theme?: string;
  apiKey?: string;
  systemMessage?: string;
  pasteLongTextToFileLen?: number;
  sendOnEnter?: boolean;
  copyTextAttachmentsAsPlainText?: boolean;
  enableContinueGeneration?: boolean;
  pdfAsImage?: boolean;
  askForTitleConfirmation?: boolean;
  titleGenerationUseFirstLine?: boolean;
  titleGenerationUseLLM?: boolean;
  titleGenerationPrompt?: string;
  maxImageMPixels?: number;
  showMessageStats?: boolean;
  showThoughtInProgress?: boolean;
  showToolCallInProgress?: boolean;
  keepStatsVisible?: boolean;
  autoMicOnEmpty?: boolean;
  renderUserContentAsMarkdown?: boolean;
  fullHeightCodeBlocks?: boolean;
  disableAutoScroll?: boolean;
  alwaysShowSidebarOnDesktop?: boolean;
  showRawModelNames?: boolean;
  showModelQuantization?: boolean;
  showModelTags?: boolean;
  alwaysShowAgenticTurns?: boolean;
  samplers?: string;
  backend_sampling?: boolean;
  agenticMaxTurns?: number;
  agenticMaxToolPreviewLines?: number;
  preEncodeConversation?: boolean;
  disableReasoningParsing?: boolean;
  excludeReasoningFromContext?: boolean;
  enableThinking?: boolean;
  showRawOutputSwitch?: boolean;
  customJson?: string;
  customCss?: string;
  mcpRequestTimeoutSeconds?: number;
  showSystemMessage?: boolean;
  mcpServers?: string; // JSON string
}

export interface MCPServerConfig {
  id: string;
  enabled: boolean;
  name: string;
  url: string;
  requestTimeoutSeconds: number;
  useProxy: boolean;
}

export interface LlamaUIMigrationState {
  version: number;
  completed: string[];
  failed: string[];
  lastRun: string;
}
