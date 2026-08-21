import * as fs from 'fs/promises';
import * as path from 'path';
import pino from 'pino';
import { MemoryEntry } from './types.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export class MemoryService {
  private dbPath: string;
  private cache: MemoryEntry[] = [];
  private maxCacheSize = 1000;

  constructor() {
    this.dbPath = path.join(process.cwd(), '.carcara', 'memory.jsonl');
    this.load().catch(() => {});
  }

  async add(entry: Omit<MemoryEntry, 'id' | 'timestamp'>): Promise<MemoryEntry> {
    const full: MemoryEntry = {
      ...entry,
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    };
    this.cache.push(full);
    if (this.cache.length > this.maxCacheSize) this.cache = this.cache.slice(-this.maxCacheSize);
    await fs.appendFile(this.dbPath, JSON.stringify(full) + '\n', 'utf-8');
    logger.info({ type: entry.type, tags: entry.tags }, 'Memoria adicionada');
    return full;
  }

  async search(query: string, tags?: string[], limit = 10): Promise<MemoryEntry[]> {
    return this.cache
      .filter(e => !tags || tags.every(t => e.tags.includes(t)))
      .map(e => ({ entry: e, score: this.similarity(query, e.content) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(r => r.entry);
  }

  async getByType(type: MemoryEntry['type'], limit = 50): Promise<MemoryEntry[]> {
    return this.cache.filter(e => e.type === type).sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  private similarity(a: string, b: string): number {
    const setA = new Set(a.toLowerCase().split(/\s+/));
    const setB = new Set(b.toLowerCase().split(/\s+/));
    const inter = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return inter.size / union.size;
  }

  private async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.dbPath, 'utf-8');
      this.cache = data.split('\n').filter(Boolean).map(l => JSON.parse(l));
      logger.info({ count: this.cache.length }, 'Memoria carregada');
    } catch { this.cache = []; }
  }
}
