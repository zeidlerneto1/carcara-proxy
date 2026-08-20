import dotenv from 'dotenv';
import { CarcaraRouter } from './presentation/api-router.js';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3030', 10);

async function main() {
  const router = new CarcaraRouter(PORT);
  await router.start();
}

main().catch(console.error);
