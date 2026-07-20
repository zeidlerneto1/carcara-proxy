import { CarcaraClient } from './carcara-client';

async function main() {
  const client = new CarcaraClient({
    domain: 'LNCC',
  });

  try {
    // Inicializar (login via API + fetch de modelos)
    await client.init();

    // Listar modelos disponíveis
    console.log('\n📋 Modelos disponíveis:');
    const models = await client.getAvailableModels();
    models.forEach(model => {
      console.log(`   - ${model.id}`);
    });

    // Criar conversa
    const convId = await client.createNewConversation(
      'Teste de Chat',
      models[0]?.id || 'meta-llama/llama-3.1-70b-instruct'
    );
    console.log(`\n📝 Conversa criada: ${convId}`);

    // Listar ferramentas MCP
    const tools = await client.listSdumontTools();

    // Enviar mensagem
    const response = await client.chatCompletion(
      'Olá! Como você está?',
      models[0]?.id,
      tools?.result?.tools
    );

    console.log('\n📩 Resposta:');
    console.log(response.choices[0].message.content);

  } catch (error) {
    console.error('❌ Erro:', error);
  } finally {
    await client.close();
  }
}

main().catch(console.error);