import dotenv from 'dotenv';
import http from 'http';
import { CarcaraRouter } from './api-router.js';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3030', 10);

async function main() {
  const router = new CarcaraRouter(PORT);
  const app = router.getApp();
  const server = http.createServer(app);
  await router.start(server);
}

main().catch(console.error);
