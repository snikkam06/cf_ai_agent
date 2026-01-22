(function () {
    'use strict';

    const SESSION_KEY = 'cf-chat-session-id';

    const elements = {
        status: document.getElementById('status'),
        statusText: document.querySelector('.status-text'),
        messages: document.getElementById('messages'),
        form: document.getElementById('chat-form'),
        input: document.getElementById('message-input'),
        sendBtn: document.getElementById('send-btn'),
        resetBtn: document.getElementById('reset-btn')
    };

    let ws = null;
    let reconnectAttempts = 0;
    let currentAssistantMessage = null;
    let isStreaming = false;

    function getSessionId() {
        let sessionId = localStorage.getItem(SESSION_KEY);
        if (!sessionId) {
            sessionId = crypto.randomUUID();
            localStorage.setItem(SESSION_KEY, sessionId);
        }
        return sessionId;
    }

    function getWebSocketUrl() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        const sessionId = getSessionId();
        return `${protocol}//${host}/ws?session=${sessionId}`;
    }

    function setStatus(connected) {
        elements.status.className = `status ${connected ? 'connected' : 'disconnected'}`;
        elements.statusText.textContent = connected ? 'Connected' : 'Disconnected';
    }

    function removeWelcomeMessage() {
        const welcome = document.querySelector('.welcome-message');
        if (welcome) {
            welcome.remove();
        }
    }

    function addMessage(role, content, isStreaming = false) {
        removeWelcomeMessage();

        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${role}`;

        const labelDiv = document.createElement('div');
        labelDiv.className = 'message-label';
        labelDiv.textContent = role === 'user' ? 'You' : 'AI Assistant';

        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        contentDiv.textContent = content;

        if (isStreaming) {
            const typingIndicator = document.createElement('div');
            typingIndicator.className = 'typing-indicator';
            typingIndicator.innerHTML = '<span></span><span></span><span></span>';
            contentDiv.appendChild(typingIndicator);
        }

        messageDiv.appendChild(labelDiv);
        messageDiv.appendChild(contentDiv);
        elements.messages.appendChild(messageDiv);

        scrollToBottom();
        return messageDiv;
    }

    function updateMessage(messageDiv, content) {
        const contentDiv = messageDiv.querySelector('.message-content');
        const typingIndicator = contentDiv.querySelector('.typing-indicator');
        if (typingIndicator) {
            typingIndicator.remove();
        }
        contentDiv.textContent = content;
        scrollToBottom();
    }

    function scrollToBottom() {
        const chatContainer = document.querySelector('.chat-container');
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function connect() {
        if (ws && ws.readyState === WebSocket.OPEN) return;

        const wsUrl = getWebSocketUrl();
        console.log('Connecting to:', wsUrl);

        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log('WebSocket connected');
            setStatus(true);
            reconnectAttempts = 0;
        };

        ws.onclose = () => {
            console.log('WebSocket disconnected');
            setStatus(false);
            scheduleReconnect();
        };

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };

        ws.onmessage = (event) => {
            handleMessage(event.data);
        };
    }

    function scheduleReconnect() {
        if (reconnectAttempts >= 10) {
            console.log('Max reconnect attempts reached');
            return;
        }

        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        reconnectAttempts++;

        console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
        setTimeout(connect, delay);
    }

    function handleMessage(data) {
        try {
            const message = JSON.parse(data);

            switch (message.type) {
                case 'connected':
                    console.log('Agent connection confirmed');
                    break;

                case 'history':
                    if (message.messages && message.messages.length > 0) {
                        removeWelcomeMessage();
                        message.messages.forEach(msg => {
                            addMessage(msg.role, msg.content);
                        });
                    }
                    break;

                case 'chunk':
                    if (!isStreaming) {
                        isStreaming = true;
                        currentAssistantMessage = addMessage('assistant', '', true);
                    }
                    if (currentAssistantMessage && message.content) {
                        const contentDiv = currentAssistantMessage.querySelector('.message-content');
                        const typingIndicator = contentDiv.querySelector('.typing-indicator');
                        if (typingIndicator) {
                            typingIndicator.remove();
                        }
                        contentDiv.textContent += message.content;
                        scrollToBottom();
                    }
                    break;

                case 'done':
                    isStreaming = false;
                    currentAssistantMessage = null;
                    elements.sendBtn.disabled = false;
                    elements.input.disabled = false;
                    elements.input.focus();
                    break;

                case 'error':
                    console.error('Agent error:', message.error);
                    isStreaming = false;
                    currentAssistantMessage = null;
                    elements.sendBtn.disabled = false;
                    elements.input.disabled = false;
                    addMessage('assistant', `Error: ${message.error || 'Something went wrong'}`);
                    break;

                default:
                    console.log('Unknown message type:', message.type);
            }
        } catch (error) {
            console.error('Failed to parse message:', error);
        }
    }

    function sendMessage(text) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.error('WebSocket not connected');
            return;
        }

        if (!text.trim()) return;

        addMessage('user', text);

        ws.send(JSON.stringify({
            type: 'user_message',
            text: text
        }));

        elements.sendBtn.disabled = true;
        elements.input.disabled = true;
    }

    function resetSession() {
        if (confirm('Start a new session? This will clear your chat history.')) {
            localStorage.removeItem(SESSION_KEY);
            if (ws) {
                ws.close();
            }
            elements.messages.innerHTML = `
        <div class="welcome-message">
          <div class="welcome-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
              <path d="M18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z"/>
            </svg>
          </div>
          <h2>Welcome to CF AI Chat</h2>
          <p>Powered by Llama 3.3 on Cloudflare Workers AI</p>
          <div class="features">
            <div class="feature">
              <span class="feature-icon">💬</span>
              <span>Real-time streaming responses</span>
            </div>
            <div class="feature">
              <span class="feature-icon">🧠</span>
              <span>Persistent memory across sessions</span>
            </div>
            <div class="feature">
              <span class="feature-icon">⚡</span>
              <span>Edge-powered for low latency</span>
            </div>
          </div>
        </div>
      `;
            connect();
        }
    }

    function autoResize() {
        elements.input.style.height = 'auto';
        elements.input.style.height = Math.min(elements.input.scrollHeight, 150) + 'px';
    }

    function init() {
        elements.form.addEventListener('submit', (e) => {
            e.preventDefault();
            const text = elements.input.value.trim();
            if (text) {
                sendMessage(text);
                elements.input.value = '';
                autoResize();
            }
        });

        elements.input.addEventListener('input', () => {
            elements.sendBtn.disabled = !elements.input.value.trim();
            autoResize();
        });

        elements.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                elements.form.dispatchEvent(new Event('submit'));
            }
        });

        elements.resetBtn.addEventListener('click', resetSession);

        connect();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
