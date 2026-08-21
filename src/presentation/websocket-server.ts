import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export interface TerminalSession {
  id: string;
  ws: WebSocket;
  containerId?: string;
  createdAt: number;
}

/**
 * WebSocket server para streaming de logs sandbox (Xterm.js).
 * Transmite stdout/stderr de containers em tempo real.
 */
export class SandboxWebSocketServer {
  private wss: WebSocketServer;
  private sessions = new Map<string, TerminalSession>();

  constructor(server: Server, path: string = '/ws/sandbox') {
    this.wss = new WebSocketServer({ server, path });
    this.wss.on('connection', (ws, req) => {
      const sessionId = `term_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const session: TerminalSession = { id: sessionId, ws, createdAt: Date.now() };
      this.sessions.set(sessionId, session);

      logger.info({ sessionId, ip: req.socket.remoteAddress }, 'Terminal WebSocket conectado');

      ws.send(JSON.stringify({ type: 'connected', sessionId }));

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(sessionId, msg);
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        }
      });

      ws.on('close', () => {
        this.sessions.delete(sessionId);
        logger.info({ sessionId }, 'Terminal WebSocket desconectado');
      });

      ws.on('error', (err) => {
        logger.error({ sessionId, error: err.message }, 'WebSocket error');
      });
    });

    logger.info({ path }, 'SandboxWebSocketServer iniciado');
  }

  private handleMessage(sessionId: string, msg: any): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    switch (msg.type) {
      case 'resize':
        // Redimensionamento do terminal Xterm.js
        logger.info({ sessionId, cols: msg.cols, rows: msg.rows }, 'Terminal resize');
        break;
      case 'input':
        // Input do usuario (para containers interativos futuros)
        logger.info({ sessionId, input: msg.data }, 'Terminal input');
        break;
      case 'ping':
        session.ws.send(JSON.stringify({ type: 'pong' }));
        break;
      default:
        session.ws.send(JSON.stringify({ type: 'error', message: `Unknown type: ${msg.type}` }));
    }
  }

  /**
   * Envia log de execucao sandbox para todos os terminais conectados.
   */
  broadcastLog(log: { type: 'stdout' | 'stderr' | 'start' | 'end'; data: string; containerId?: string }): void {
    const payload = JSON.stringify({ type: 'log', ...log, timestamp: Date.now() });
    for (const session of this.sessions.values()) {
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(payload);
      }
    }
  }

  /**
   * Envia log para uma sessao especifica.
   */
  sendLog(sessionId: string, log: { type: 'stdout' | 'stderr' | 'start' | 'end'; data: string }): void {
    const session = this.sessions.get(sessionId);
    if (session && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: 'log', ...log, timestamp: Date.now() }));
    }
  }

  getActiveSessions(): number {
    return this.sessions.size;
  }

  close(): void {
    this.wss.close();
    logger.info('SandboxWebSocketServer fechado');
  }
}
