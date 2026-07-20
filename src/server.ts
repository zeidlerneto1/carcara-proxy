// src/server.ts
import { CarcaraRouter } from './api-router';

async function main() {
  const router = new CarcaraRouter(3030);

  process.on('SIGINT', async () => {
    console.log('\n🛑 Encerrando...');
    await router.stop();
    process.exit(0);
  });

  await router.start();
}

main().catch(console.error);