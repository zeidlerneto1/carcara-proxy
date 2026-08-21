import dotenv from 'dotenv';
import http from 'http';
import net from 'net';
import { spawn } from 'child_process';
import { CarcaraRouter } from './api-router.js';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3030', 10);
const MONITOR_PORT = parseInt(process.env.MONITOR_PORT || '7575', 10);

const monitorSockets: net.Socket[] = [];

export function broadcastMonitor(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  for (const sock of monitorSockets) {
    try { sock.write(line); } catch {}
  }
}

function cleanupContainers(): void {
  console.log('\n🧹 Limpando containers carcara-sandbox...');
  broadcastMonitor('[SYSTEM] Iniciando cleanup de containers carcara-sandbox...');
  try {
    const proc = spawn('sh', ['-c', 'docker rm -f $(docker ps -aq --filter "name=carcara-sandbox" 2>/dev/null) 2>/dev/null || true'], {
      stdio: 'inherit',
      detached: false,
    });
    proc.on('close', (code) => {
      console.log(`   Cleanup finalizado (exit: ${code}). Encerrando...`);
      process.exit(0);
    });
    // Timeout de seguranca: se nao terminar em 10s, mata anyway
    setTimeout(() => {
      console.log('   Timeout cleanup. Forcando encerramento.');
      process.exit(0);
    }, 10000);
  } catch (e) {
    console.error('   Erro no cleanup:', e);
    process.exit(1);
  }
}

async function main() {
  const router = new CarcaraRouter(PORT);
  const app = router.getApp();
  const server = http.createServer(app);

  // Monitor socket TCP na porta 7575 (nc localhost 7575)
  const monitorServer = net.createServer((socket) => {
    monitorSockets.push(socket);
    socket.write('=== Carcara Monitor Socket ===\nConectado. Aguardando logs de LLM/agentes...\n\n');
    socket.on('close', () => {
      const idx = monitorSockets.indexOf(socket);
      if (idx !== -1) monitorSockets.splice(idx, 1);
    });
  });

  monitorServer.listen(MONITOR_PORT, () => {
    console.log(`📡 Monitor socket ativo na porta ${MONITOR_PORT} (conecte com: nc localhost ${MONITOR_PORT})`);
  });

  // Cleanup de containers ao encerrar (Ctrl+C, SIGTERM, etc)
  process.on('SIGINT', cleanupContainers);
  process.on('SIGTERM', cleanupContainers);

  await router.start(server);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});