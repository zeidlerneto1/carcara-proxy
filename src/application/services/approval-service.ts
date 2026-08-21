import { EventEmitter } from 'events';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export interface ApprovalRequest {
  id: string;
  action: string;
  input: string;
  riskLevel: 'low' | 'medium' | 'high';
  requestedAt: number;
  resolved: boolean;
  approved?: boolean;
  resolvedAt?: number;
}

export class ApprovalService extends EventEmitter {
  private requests = new Map<string, ApprovalRequest>();
  private autoApproveLowRisk: boolean;
  private maxPendingAgeMs: number;

  constructor(autoApproveLowRisk: boolean = false, maxPendingAgeMs: number = 5 * 60 * 1000) {
    super();
    this.autoApproveLowRisk = autoApproveLowRisk;
    this.maxPendingAgeMs = maxPendingAgeMs;
    this._startCleanup();
  }

  async requestApproval(action: string, input: string, riskLevel: 'low' | 'medium' | 'high' = 'medium'): Promise<boolean> {
    if (this.autoApproveLowRisk && riskLevel === 'low') {
      logger.info({ action, input }, 'Auto-aprovado (low risk)');
      return true;
    }

    const id = `apr_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const request: ApprovalRequest = {
      id, action, input, riskLevel,
      requestedAt: Date.now(),
      resolved: false,
    };
    this.requests.set(id, request);
    this.emit('approval:requested', request);
    logger.info({ id, action, riskLevel }, 'Aguardando aprovacao humana');

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.requests.delete(id);
        resolve(false);
      }, this.maxPendingAgeMs);

      this.once(`approval:${id}`, (approved: boolean) => {
        clearTimeout(timeout);
        resolve(approved);
      });
    });
  }

  respond(id: string, approved: boolean): boolean {
    const req = this.requests.get(id);
    if (!req || req.resolved) return false;
    req.resolved = true;
    req.approved = approved;
    req.resolvedAt = Date.now();
    this.emit(`approval:${id}`, approved);
    this.emit('approval:resolved', req);
    logger.info({ id, approved }, 'Aprovacao respondida');
    return true;
  }

  listPending(): ApprovalRequest[] {
    return Array.from(this.requests.values()).filter(r => !r.resolved);
  }

  get(id: string): ApprovalRequest | undefined {
    return this.requests.get(id);
  }

  private _startCleanup(): void {
    setInterval(() => {
      const cutoff = Date.now() - this.maxPendingAgeMs;
      for (const [id, req] of this.requests) {
        if (!req.resolved && req.requestedAt < cutoff) {
          this.requests.delete(id);
          this.emit(`approval:${id}`, false);
          logger.warn({ id }, 'Aprovacao expirada');
        }
      }
    }, 60 * 1000);
  }
}
