import { SandboxLanguage, SandboxResult } from '../../infrastructure/services/sandbox-service.js';

export interface ISandboxService {
  detectDocker(): Promise<boolean>;
  execute(code: string, language: SandboxLanguage, sessionId?: string): Promise<SandboxResult>;
  cleanupAll(): Promise<void>;
  cleanupSession(sessionId: string): Promise<void>;
  dockerAvailable: boolean | null;
}
