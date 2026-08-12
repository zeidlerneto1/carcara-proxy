import * as readline from 'readline';
import axios from 'axios';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const PROXY_URL = process.env.PROXY_URL || 'http://localhost:3030';
const MODEL = process.env.MODEL || 'DeepSeek-v4-Flash-0731';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const messages: ChatMessage[] = [];

function printBanner() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║      🤖 Carcara Chat CLI v2.0          ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Proxy: ${PROXY_URL.padEnd(34)} ║`);
  console.log(`║  Model: ${MODEL.padEnd(34)} ║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  Comandos:                               ║');
  console.log('║    /quit  - Sair                         ║');
  console.log('║    /clear - Limpar histórico             ║');
  console.log('║    /model <nome> - Trocar modelo         ║');
  console.log('║    /sandbox <lang> <código> - Executar   ║');
  console.log('║    /stream on|off - Toggle streaming     ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
}

let useStream = true;

async function chat(userInput: string): Promise<void> {
  messages.push({ role: 'user', content: userInput });

  try {
    if (useStream) {
      const response = await axios.post(
        `${PROXY_URL}/v1/chat/completions`,
        {
          model: MODEL,
          messages,
          stream: true,
        },
        { responseType: 'stream' }
      );

      process.stdout.write('🤖 ');
      let fullContent = '';

      await new Promise<void>((resolve, reject) => {
        response.data.on('data', (chunk: Buffer) => {
          const lines = chunk.toString().split('\n');
          for (const line of lines) {
            if (!line.trim() || !line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') {
              resolve();
              return;
            }
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content || '';
              if (content) {
                process.stdout.write(content);
                fullContent += content;
              }
            } catch {}
          }
        });
        response.data.on('end', resolve);
        response.data.on('error', reject);
      });

      process.stdout.write('\n\n');
      messages.push({ role: 'assistant', content: fullContent });
    } else {
      const { data } = await axios.post(`${PROXY_URL}/v1/chat/completions`, {
        model: MODEL,
        messages,
        stream: false,
      });

      const content = data.choices?.[0]?.message?.content || '';
      console.log('🤖 ' + content + '\n');
      messages.push({ role: 'assistant', content });
    }
  } catch (err: any) {
    console.error('❌ Erro:', err.response?.data?.error?.message || err.message);
  }
}

async function executeSandbox(language: string, code: string): Promise<void> {
  try {
    const { data } = await axios.post(`${PROXY_URL}/api/sandbox/exec`, {
      code,
      language,
    });
    console.log('📤 stdout:', data.stdout || '(vazio)');
    if (data.stderr) console.log('📤 stderr:', data.stderr);
    console.log('⏱️  Duração:', data.durationMs + 'ms | Exit:', data.exitCode);
  } catch (err: any) {
    console.error('❌ Sandbox erro:', err.response?.data?.error || err.message);
  }
}

async function main() {
  printBanner();

  // Verifica se proxy está online
  try {
    await axios.get(`${PROXY_URL}/api/health`, { timeout: 3000 });
    console.log('✅ Proxy online!\n');
  } catch {
    console.log('⚠️  Proxy offline. Inicie com: npm run dev\n');
  }

  const ask = () => {
    rl.question('👤 Você: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed) return ask();

      if (trimmed === '/quit') {
        console.log('👋 Até logo!');
        rl.close();
        return;
      }

      if (trimmed === '/clear') {
        messages.length = 0;
        console.log('🧹 Histórico limpo.\n');
        return ask();
      }

      if (trimmed.startsWith('/model ')) {
        const newModel = trimmed.slice(7).trim();
        if (newModel) {
          (global as any).MODEL = newModel;
          console.log(`🔧 Modelo alterado para: ${newModel}\n`);
        }
        return ask();
      }

      if (trimmed.startsWith('/stream ')) {
        useStream = trimmed.slice(8).trim() === 'on';
        console.log(`🔧 Streaming: ${useStream ? 'ON' : 'OFF'}\n`);
        return ask();
      }

      if (trimmed.startsWith('/sandbox ')) {
        const rest = trimmed.slice(9).trim();
        const spaceIdx = rest.indexOf(' ');
        if (spaceIdx === -1) {
          console.log('Uso: /sandbox <python|javascript|bash> <código>\n');
          return ask();
        }
        const lang = rest.slice(0, spaceIdx);
        const code = rest.slice(spaceIdx + 1);
        await executeSandbox(lang, code);
        console.log('');
        return ask();
      }

      await chat(trimmed);
      ask();
    });
  };

  ask();
}

main();
