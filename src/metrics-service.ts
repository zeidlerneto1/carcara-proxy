import * as fs from 'fs/promises';
import * as path from 'path';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export interface MetricPoint {
  timestamp: number;
  name: string;
  value: number;
  labels: Record<string, string>;
}

export class MetricsService {
  private dbPath: string;
  private buffer: MetricPoint[] = [];
  private flushIntervalMs = 30000;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    this.dbPath = path.join(process.cwd(), '.carcara', 'metrics.jsonl');
    this.startFlushTimer();
  }

  record(name: string, value: number, labels: Record<string, string> = {}): void {
    this.buffer.push({ timestamp: Date.now(), name, value, labels });
  }

  async query(name: string, since?: number, labels?: Record<string, string>): Promise<MetricPoint[]> {
    const all = await this.loadAll();
    return all.filter(m => {
      if (m.name !== name) return false;
      if (since && m.timestamp < since) return false;
      if (labels) { for (const [k, v] of Object.entries(labels)) { if (m.labels[k] !== v) return false; } }
      return true;
    });
  }

  async aggregate(name: string, since: number, operation: 'avg' | 'sum' | 'max' | 'min' | 'count'): Promise<number> {
    const points = await this.query(name, since);
    if (!points.length) return 0;
    const values = points.map(p => p.value);
    switch (operation) {
      case 'avg': return values.reduce((a, b) => a + b, 0) / values.length;
      case 'sum': return values.reduce((a, b) => a + b, 0);
      case 'max': return Math.max(...values);
      case 'min': return Math.min(...values);
      case 'count': return values.length;
    }
  }

  private startFlushTimer(): void {
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
  }

  private async flush(): Promise<void> {
    if (!this.buffer.length) return;
    const lines = this.buffer.map(m => JSON.stringify(m)).join('\n') + '\n';
    await fs.appendFile(this.dbPath, lines, 'utf-8');
    logger.debug({ count: this.buffer.length }, 'Metricas flushadas');
    this.buffer = [];
  }

  private async loadAll(): Promise<MetricPoint[]> {
    const file = await fs.readFile(this.dbPath, 'utf-8').catch(() => '');
    return file.split('\n').filter(Boolean).map(l => JSON.parse(l));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.flush().catch(() => {});
  }
}
