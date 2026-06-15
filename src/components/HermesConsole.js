import { getHermesActivity, getHermesStatus, sendHermesMessage, testBrain } from '../utils/api.js';
import wsClient from '../utils/websocket.js';

export class HermesConsole {
  constructor(container) {
    this.container = container;
    this.el = null;
    this.messagesEl = null;
    this.inputEl = null;
    this.messages = [];
    this.seenMessageIds = new Set();
    this.pending = false;
    this.statusEl = null;
    this.brainReady = false;
    this.brainReason = 'init';
  }

  async init() {
    this.render();
    await this._refreshStatus();

    // Replay only real conversation turns — never the old canned flavor lines.
    try {
      const activity = await getHermesActivity();
      const messages = Array.isArray(activity) ? activity : activity?.messages;
      if (Array.isArray(messages)) {
        messages
          .slice()
          .reverse()
          .filter(entry => ['user_chat', 'assistant_chat'].includes(entry.event_type || entry.eventType))
          .slice(-12)
          .forEach(entry => this._appendMessage(this._normalizeMessage(entry), false));
      }
    } catch { /* offline is fine */ }

    // Only show our own greeting if the live WS greeting didn't already land.
    setTimeout(() => {
      if (this.messages.length) return;
      this._appendMessage({
        type: 'hermes',
        text: this.brainReady
          ? 'Hermes online. Gemini brain connected — ask me anything, or tell me to build analytics, recolor the UI, remember things, or start a self-improvement loop.'
          : 'Hermes online in local control mode. I can already change the dashboard. Connect the Gemini brain (below) for full reasoning, dreaming and self-improvement.',
        timestamp: this._timestamp(),
      }, false);
    }, 500);
    this._renderConnectBanner();
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'hermes-console';
    this.el.innerHTML = `
      <div class="console-agent-strip">
        <div class="console-agent-pill" id="console-agent-brain">Brain: checking…</div>
        <div class="console-agent-pill" id="console-agent-memory">Memory: --</div>
        <div class="console-agent-pill" id="console-agent-mode">Mode: --</div>
        <button class="console-agent-pill console-test-btn" id="console-test-brain" title="Run a live test against the Gemini brain">⟳ Test brain</button>
      </div>
      <div class="console-connect" id="console-connect" hidden></div>
      <div class="console-messages" id="console-messages"></div>
      <div class="console-input">
        <span class="console-input-prompt">&gt;</span>
        <input type="text" class="console-input-field" placeholder="Ask Hermes — e.g. “research solid-state batteries”, “dream up new ideas”, “add a revenue widget”" />
        <button class="console-send-btn" title="Send">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
    `;
    this.container.appendChild(this.el);

    this.messagesEl = this.el.querySelector('#console-messages');
    this.inputEl = this.el.querySelector('.console-input-field');
    this.connectEl = this.el.querySelector('#console-connect');
    this.statusEl = {
      brain: this.el.querySelector('#console-agent-brain'),
      memory: this.el.querySelector('#console-agent-memory'),
      mode: this.el.querySelector('#console-agent-mode'),
    };
    const sendBtn = this.el.querySelector('.console-send-btn');
    const testBtn = this.el.querySelector('#console-test-brain');

    this.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._handleSend(); });
    sendBtn.addEventListener('click', () => this._handleSend());
    testBtn.addEventListener('click', () => this._handleTest());
  }

  _renderConnectBanner() {
    if (!this.connectEl) return;
    if (this.brainReady) { this.connectEl.hidden = true; return; }
    const installNeeded = this.brainReason === 'cli_missing';
    this.connectEl.hidden = false;
    this.connectEl.innerHTML = installNeeded
      ? `<div class="console-connect-title">⚡ Connect Hermes' Gemini brain</div>
         <div class="console-connect-body">The Gemini CLI isn't installed. In a terminal run:
         <code>npm install -g @google/gemini-cli</code> then <code>npm run connect-brain</code> and sign in with your Google account.</div>`
      : `<div class="console-connect-title">⚡ One step left: log in to Gemini (free)</div>
         <div class="console-connect-body">Run <code>npm run connect-brain</code> in the project folder and sign in with your Google account. Then click <b>Test brain</b>. Until then I run in local control mode.</div>`;
  }

  async _handleTest() {
    const btn = this.el?.querySelector('#console-test-brain');
    if (btn) { btn.disabled = true; btn.textContent = '⟳ Testing…'; }
    try {
      const result = await testBrain();
      if (result?.ok) {
        this._appendMessage({ type: 'system', text: `✓ Gemini brain connected (${result.provider} · ${result.model}).`, timestamp: this._timestamp() }, false);
      } else {
        const why = result?.reason === 'needs_login' ? 'not logged in yet — run “npm run connect-brain”.'
          : result?.reason === 'cli_missing' ? 'CLI not installed.'
          : result?.reason === 'timeout' ? 'the model timed out, try again.'
          : `reason: ${result?.reason || 'unknown'}.`;
        this._appendMessage({ type: 'system', text: `Brain not ready — ${why}`, timestamp: this._timestamp() }, false);
      }
    } catch {
      this._appendMessage({ type: 'error', text: 'Could not reach the backend to test the brain.', timestamp: this._timestamp() }, false);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '⟳ Test brain'; }
      this._refreshStatus();
    }
  }

  async _handleSend() {
    if (this.pending) return;
    const text = this.inputEl.value.trim();
    if (!text) return;

    this.inputEl.value = '';
    this.pending = true;

    const clientMessageId = `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.addMessage({ id: clientMessageId, type: 'user', text, timestamp: this._timestamp() });
    this._showThinking(true);

    try {
      const response = await sendHermesMessage(text, clientMessageId);
      // If the WS is live, the broadcast already delivered the reply.
      if (!wsClient.isConnected() && response) this.addMessage(response);
      this._refreshStatus();
    } catch {
      this.addMessage({ type: 'error', text: 'I could not reach the agent core. Is the backend running? (npm run dev)', timestamp: this._timestamp() });
    } finally {
      this.pending = false;
      this._showThinking(false);
      this.inputEl.focus();
    }
  }

  // ── Public hooks (called by main.js / Dashboard) ──────────────
  addMessage(message) {
    const normalized = this._normalizeMessage(message);
    this._appendMessage(normalized, normalized.type === 'hermes');
    if (normalized.type === 'hermes') this._showThinking(false);
  }
  onMessage(message) { this.addMessage(message); }
  onThinking(payload = {}) { this._showThinking(Boolean(payload.thinking)); }
  onTrace(trace) {
    if (!trace?.event) return;
    // Keep the console clean: only surface meaningful traces, compactly.
    if (!/model_call|dashboard_mutation|memory_write|self_improvement|dream/.test(trace.event)) return;
    this._appendMessage({
      id: `trace-${trace.timestamp}-${trace.event}`,
      type: 'system',
      text: `· ${trace.event.replace(/_/g, ' ')}`,
      timestamp: trace.timestamp || this._timestamp(),
    }, false, { compact: true });
  }
  onStatus(status) { this._updateStatus(status); }

  // ── Rendering ─────────────────────────────────────────────────
  _appendMessage(message, _typewriter = false, options = {}) {
    message = this._normalizeMessage(message);
    if (message.id && this.seenMessageIds.has(message.id)) return;
    if (message.id) this.seenMessageIds.add(message.id);
    this.messages.push(message);

    const msgEl = document.createElement('div');
    msgEl.className = `console-message ${message.type} console-message--${message.type} console-message--enter`;
    if (options.compact) msgEl.classList.add('console-message--compact');

    const avatarChar = message.type === 'hermes' ? '◈' : message.type === 'user' ? '▸' : message.type === 'error' ? '✕' : '●';
    const avatarClass = message.type === 'hermes' ? 'avatar-hermes' : message.type === 'user' ? 'avatar-user' : 'avatar-system';

    msgEl.innerHTML = `
      <div class="console-avatar ${avatarClass}">${avatarChar}</div>
      <div class="console-message-body">
        <div class="console-message-sender">${message.type === 'hermes' ? 'Hermes' : message.type}</div>
        <div class="console-message-text">${this._format(message.text)}</div>
        <div class="console-actions"></div>
      </div>
      <span class="console-message-time">${this._formatTimestamp(message.timestamp)}</span>
    `;

    this._removeThinkingEl();
    this.messagesEl.appendChild(msgEl);
    this._renderActions(msgEl.querySelector('.console-actions'), message.actions);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  _renderActions(host, actions) {
    if (!host || !Array.isArray(actions) || !actions.length) return;
    for (const a of actions) {
      if (!a || a.type === 'note') continue;
      const chip = document.createElement('span');
      chip.className = `console-action-chip chip-${(a.type || 'action').replace(/_/g, '-')}`;
      chip.textContent = a.label || a.type;
      host.appendChild(chip);
    }
  }

  _showThinking(on) {
    if (!this.messagesEl) return;
    if (on) {
      if (this.messagesEl.querySelector('#console-thinking')) return;
      const el = document.createElement('div');
      el.className = 'console-message hermes console-thinking';
      el.id = 'console-thinking';
      el.innerHTML = `
        <div class="console-avatar avatar-hermes">◈</div>
        <div class="console-message-body">
          <div class="console-message-sender">Hermes</div>
          <div class="console-thinking-dots"><span></span><span></span><span></span></div>
        </div>`;
      this.messagesEl.appendChild(el);
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    } else {
      this._removeThinkingEl();
    }
  }
  _removeThinkingEl() {
    const t = this.messagesEl?.querySelector('#console-thinking');
    if (t) t.remove();
  }

  _format(text) {
    const esc = this._escape(String(text ?? ''));
    return esc
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }
  _escape(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  _timestamp() {
    const n = new Date();
    return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}:${String(n.getSeconds()).padStart(2, '0')}`;
  }
  _formatTimestamp(ts) {
    if (!ts) return this._timestamp();
    if (/^\d{2}:\d{2}/.test(ts)) return ts;
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return this._timestamp();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  _normalizeMessage(message = {}) {
    const text = message.text || message.message || message.greeting || '…';
    let type = message.type || 'hermes';
    const et = message.event_type || message.eventType;
    if (et === 'user_chat') type = 'user';
    if (et === 'assistant_chat') type = 'hermes';
    if (et === 'system_init') type = 'system';
    if (!['hermes', 'system', 'user', 'error'].includes(type)) type = 'hermes';
    const actions = message.actions || message.data?.actions || [];
    return {
      ...message,
      id: message.id || message.data?.messageId || message.messageId || message.data?.clientMessageId,
      type, text, actions,
      timestamp: message.timestamp || message.created_at || this._timestamp(),
    };
  }

  async _refreshStatus() {
    try {
      const status = await getHermesStatus();
      this._updateStatus(status);
    } catch {
      this._updateStatus({ agent: { brain: { ready: false, reason: 'offline' } } });
    }
  }

  _updateStatus(status = {}) {
    const agent = status.agent || {};
    const brain = agent.brain || {};
    this.brainReady = Boolean(brain.ready);
    this.brainReason = brain.reason || 'unknown';
    if (this.statusEl?.brain) {
      this.statusEl.brain.textContent = brain.ready ? `Brain: ${brain.model}` : `Brain: local (${brain.reason || 'offline'})`;
      this.statusEl.brain.classList.toggle('is-warning', !brain.ready);
    }
    if (this.statusEl?.memory) this.statusEl.memory.textContent = `Memory: ${agent.memoryCount ?? 0}`;
    if (this.statusEl?.mode) this.statusEl.mode.textContent = `Mode: ${agent.autonomyMode || 'supervised'}`;
    this._renderConnectBanner();
  }

  destroy() {
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = null;
  }
}

export default HermesConsole;
