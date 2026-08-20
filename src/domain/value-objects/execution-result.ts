export interface ExecutionResult {
  success: boolean;
  output: string;
  exitCode: number;
  durationMs: number;
}

export interface ToolCallVO {
  id: string;
  name: string;
  arguments: Record<string, any>;
}
