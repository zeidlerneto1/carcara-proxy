import 'dotenv/config';
import { CarcaraRouter } from './api-router.js';
import { DockerService } from './docker-service.js';

async function initializeDockerSandbox(): Promise<void> {
  const dockerService = new DockerService();
  
  console.log('🔍 Verificando Docker no sistema...');
  const mode = await dockerService.promptForDockerSetup();
  
  if (mode === 'container') {
    console.log('✅ Sandbox Docker ativo! Código será executado em container isolado.');
    process.env.SANDBOX_MODE = 'docker';
  } else {
    console.log('📡 Modo PROXY-ONLY ativo. Sem sandbox de execução de código.');
    process.env.SANDBOX_MODE = 'proxy-only';
  }
  console.log('');
}

const PORT = parseInt(process.env.PORT || '3030', 10);

// Inicializa Docker sandbox antes de iniciar servidor
initializeDockerSandbox()
  .then(() => {
    const router = new CarcaraRouter(PORT);
    return router.start();
  })
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
