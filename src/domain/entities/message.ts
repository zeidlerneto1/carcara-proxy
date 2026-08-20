export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | any[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  output: string;
}

export interface AgentState {
  sessionId: string;
  currentStep: number;
  maxSteps: number;
  converged: boolean;
  convergenceScore: number;
  history: AgentStep[];
}

export interface AgentStep {
  step: number;
  thought: string;
  action: string;
  actionInput: string;
  observation: string;
  timestamp: number;
}
