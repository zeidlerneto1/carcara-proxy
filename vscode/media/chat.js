(function() {
  const vscode = acquireVsCodeApi();

  // Elementos DOM
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('message-input');
  const sendBtn = document.getElementById('btn-send');
  const abortBtn = document.getElementById('btn-abort');
  const typingIndicator = document.getElementById('typing-indicator');
  const statusIndicator = document.getElementById('status-indicator');
  const modelBadge = document.getElementById('model-badge');
  const modelsModal = document.getElementById('models-modal');
  const modelsList = document.getElementById('models-list');

  // Estado
  let messages = [];
  let isGenerating = false;
  let currentModel = '';
  let currentAssistantId = null;

  // Inicializar
  vscode.postMessage({ type: 'getConfig' });
  vscode.postMessage({ type: 'getModels' });

  // Event listeners
  sendBtn.addEventListener('click', sendMessage);
  abortBtn.addEventListener('click', abortGeneration);

  inputEl.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      sendMessage();
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
  });

  document.getElementById('btn-new').addEventListener('click', () => {
    vscode.postMessage({ type: 'newConversation' });
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    vscode.postMessage({ type: 'clearHistory' });
  });

  document.getElementById('btn-settings').addEventListener('click', () => {
    vscode.postMessage({ type: 'openSettings' });
  });

  document.getElementById('btn-models').addEventListener('click', () => {
    modelsModal.classList.remove('hidden');
  });

  document.querySelector('.modal-close').addEventListener('click', () => {
    modelsModal.classList.add('hidden');
  });

  modelsModal.addEventListener('click', (e) => {
    if (e.target === modelsModal) {
      modelsModal.classList.add('hidden');
    }
  });

  // Hints
  document.querySelectorAll('.hint').forEach(hint => {
    hint.addEventListener('click', () => {
      inputEl.value = hint.textContent + ' ';
      inputEl.focus();
    });
  });

  // Receber mensagens do extension host
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'config':
        currentModel = msg.config.defaultModel;
        updateModelBadge(currentModel);
        break;

      case 'health':
        updateStatus(msg.status, msg.initialized);
        break;

      case 'models':
        renderModels(msg.models);
        break;

      case 'userMessage':
        addMessage(msg.message);
        break;

      case 'assistantStart':
        isGenerating = true;
        currentAssistantId = msg.message.id;
        showAbortButton();
        addMessage(msg.message);
        break;

      case 'assistantChunk':
        appendToMessage(msg.id, msg.chunk);
        break;

      case 'assistantComplete':
        isGenerating = false;
        currentAssistantId = null;
        showSendButton();
        updateMessageContent(msg.id, msg.content);
        if (msg.model) updateModelBadge(msg.model);
        break;

      case 'systemMessage':
        addSystemMessage(msg.text);
        break;

      case 'error':
        isGenerating = false;
        showSendButton();
        addErrorMessage(msg.message);
        break;

      case 'generationComplete':
        isGenerating = false;
        showSendButton();
        break;

      case 'newConversation':
        messages = [];
        messagesEl.innerHTML = '';
        inputEl.value = '';
        inputEl.style.height = 'auto';
        break;

      case 'clearHistory':
        messages = [];
        messagesEl.innerHTML = '';
        break;

      case 'loadConversation':
        messages = msg.conversation.messages || [];
        renderMessages();
        break;

      case 'sandboxStart':
        addSandboxMessage(msg.language);
        break;

      case 'sandboxResult':
        updateSandboxResult(msg.result);
        break;

      case 'sandboxError':
        addErrorMessage('Sandbox: ' + msg.error);
        break;

      case 'searchStart':
        addSearchMessage(msg.query);
        break;

      case 'searchResult':
        updateSearchResult(msg.results);
        break;

      case 'searchError':
        addErrorMessage('Busca: ' + msg.error);
        break;

      case 'modelSet':
        currentModel = msg.model;
        updateModelBadge(currentModel);
        break;
    }
  });

  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || isGenerating) return;
    inputEl.value = '';
    inputEl.style.height = 'auto';
    vscode.postMessage({ type: 'sendMessage', text });
  }

  function abortGeneration() {
    vscode.postMessage({ type: 'abort' });
    isGenerating = false;
    showSendButton();
  }

  function showAbortButton() {
    sendBtn.classList.add('hidden');
    abortBtn.classList.remove('hidden');
    typingIndicator.classList.remove('hidden');
  }

  function showSendButton() {
    sendBtn.classList.remove('hidden');
    abortBtn.classList.add('hidden');
    typingIndicator.classList.add('hidden');
  }

  function updateStatus(status, initialized) {
    statusIndicator.className = '';
    if (status === 'ok' && initialized) {
      statusIndicator.classList.add('status-online');
      statusIndicator.title = 'Proxy online';
    } else if (status === 'ok') {
      statusIndicator.classList.add('status-connecting');
      statusIndicator.title = 'Inicializando...';
    } else {
      statusIndicator.classList.add('status-offline');
      statusIndicator.title = 'Proxy offline';
    }
  }

  function updateModelBadge(model) {
    modelBadge.textContent = model || 'Carregando...';
  }

  function addMessage(msg) {
    messages.push(msg);
    const el = createMessageElement(msg);
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function createMessageElement(msg) {
    const div = document.createElement('div');
    div.className = `message message-${msg.role}`;
    div.id = `msg-${msg.id}`;

    const header = document.createElement('div');
    header.className = 'message-header';
    header.innerHTML = getRoleIcon(msg.role) + ' ' + getRoleLabel(msg.role);
    div.appendChild(header);

    const content = document.createElement('div');
    content.className = 'message-content';
    content.innerHTML = renderMarkdown(msg.content);
    div.appendChild(content);

    // Adicionar actions para blocos de código
    addCodeActions(div);

    return div;
  }

  function appendToMessage(id, chunk) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    const content = el.querySelector('.message-content');
    const currentText = content.getAttribute('data-raw') || '';
    const newText = currentText + chunk;
    content.setAttribute('data-raw', newText);
    content.innerHTML = renderMarkdown(newText);
    addCodeActions(el);
    scrollToBottom();
  }

  function updateMessageContent(id, content) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    const contentDiv = el.querySelector('.message-content');
    contentDiv.setAttribute('data-raw', content);
    contentDiv.innerHTML = renderMarkdown(content);
    addCodeActions(el);
    scrollToBottom();
  }

  function addSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'message message-system';
    div.textContent = text;
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function addErrorMessage(text) {
    const div = document.createElement('div');
    div.className = 'message message-error';
    div.textContent = text;
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function addSandboxMessage(language) {
    const div = document.createElement('div');
    div.className = 'message message-sandbox';
    div.innerHTML = `
      <div class="message-header">🐳 Sandbox (${language})</div>
      <div class="sandbox-output">
        <div class="sandbox-meta"><span class="spinner" style="display:inline-block;width:10px;height:10px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:spin 0.8s linear infinite;"></span> Executando...</div>
      </div>
    `;
    div.id = `sandbox-${Date.now()}`;
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function updateSandboxResult(result) {
    const els = messagesEl.querySelectorAll('.message-sandbox');
    const last = els[els.length - 1];
    if (!last) return;
    const output = last.querySelector('.sandbox-output');
    let html = '';
    if (result.stdout) html += `<div class="sandbox-stdout">${escapeHtml(result.stdout)}</div>`;
    if (result.stderr) html += `<div class="sandbox-stderr">${escapeHtml(result.stderr)}</div>`;
    html += `<div class="sandbox-meta">⏱️ ${result.durationMs}ms | Exit: ${result.exitCode} | Modo: ${result.mode}</div>`;
    output.innerHTML = html;
    scrollToBottom();
  }

  function addSearchMessage(query) {
    const div = document.createElement('div');
    div.className = 'message message-search';
    div.innerHTML = `
      <div class="message-header">🔍 Buscando: "${escapeHtml(query)}"</div>
      <div class="search-results"><div class="sandbox-meta">Buscando...</div></div>
    `;
    div.id = `search-${Date.now()}`;
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function updateSearchResult(results) {
    const els = messagesEl.querySelectorAll('.message-search');
    const last = els[els.length - 1];
    if (!last) return;
    const output = last.querySelector('.search-results');
    if (!results.results || !results.results.length) {
      output.innerHTML = '<div class="sandbox-meta">Nenhum resultado encontrado.</div>';
      return;
    }
    const items = results.results.map(r => `
      <div class="search-result-item">
        <a href="${r.url}" class="search-result-title" target="_blank">${escapeHtml(r.title)}</a>
        <div class="search-result-url">${escapeHtml(r.url)}</div>
        <div class="search-result-snippet">${escapeHtml(r.snippet)}</div>
      </div>
    `).join('');
    output.innerHTML = items;
    scrollToBottom();
  }

  function renderMessages() {
    messagesEl.innerHTML = '';
    messages.forEach(msg => {
      messagesEl.appendChild(createMessageElement(msg));
    });
    scrollToBottom();
  }

  function renderMarkdown(text) {
    if (!text) return '';

    // Escapar HTML
    let html = escapeHtml(text);

    // Code blocks
    html = html.replace(/```(\w+)?\n?([\s\S]*?)```/g, (match, lang, code) => {
      return `<pre class="code-block"><code class="language-${lang || 'text'}">${escapeHtml(code.trim())}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Headers
    html = html.replace(/^#{1,6}\s+(.+)$/gm, (match, content) => {
      const level = match.match(/^#+/)[0].length;
      return `<h${level}>${content}</h${level}>`;
    });

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

    // Lists
    html = html.replace(/^\s*[-*+]\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

    // Blockquotes
    html = html.replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>');

    // Line breaks
    html = html.replace(/\n/g, '<br>');

    return html;
  }

  function addCodeActions(container) {
    container.querySelectorAll('.code-block').forEach(block => {
      if (block.querySelector('.code-actions')) return;

      const code = block.querySelector('code');
      if (!code) return;

      const actions = document.createElement('div');
      actions.className = 'code-actions';

      const copyBtn = document.createElement('button');
      copyBtn.textContent = '📋 Copiar';
      copyBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'copyCode', code: code.textContent });
      });

      const insertBtn = document.createElement('button');
      insertBtn.textContent = '📝 Inserir';
      insertBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'insertCode', code: code.textContent });
      });

      actions.appendChild(copyBtn);
      actions.appendChild(insertBtn);
      block.appendChild(actions);
    });
  }

  function renderModels(models) {
    modelsList.innerHTML = '';
    if (!models || !models.length) {
      modelsList.innerHTML = '<div class="model-item"><div class="model-item-name">Nenhum modelo disponível</div></div>';
      return;
    }
    models.forEach(m => {
      const item = document.createElement('div');
      item.className = 'model-item' + (m.id === currentModel ? ' selected' : '');
      item.innerHTML = `
        <div class="model-item-name">${escapeHtml(m.name || m.id)}</div>
        <div class="model-item-id">${escapeHtml(m.id)}</div>
      `;
      item.addEventListener('click', () => {
        vscode.postMessage({ type: 'setModel', model: m.id });
        modelsModal.classList.add('hidden');
      });
      modelsList.appendChild(item);
    });
  }

  function getRoleIcon(role) {
    const icons = {
      user: '👤',
      assistant: '🤖',
      system: '⚙️',
      tool: '🔧',
    };
    return icons[role] || '💬';
  }

  function getRoleLabel(role) {
    const labels = {
      user: 'Você',
      assistant: 'Carcara',
      system: 'Sistema',
      tool: 'Ferramenta',
    };
    return labels[role] || role;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Spinner keyframes
  const style = document.createElement('style');
  style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(style);
})();
