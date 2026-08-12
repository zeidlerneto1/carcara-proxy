import 'dotenv/config';
import { CarcaraRouter } from './api-router.js';

const PORT = parseInt(process.env.PORT || '3030', 10);
const router = new CarcaraRouter(PORT);

router.start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
