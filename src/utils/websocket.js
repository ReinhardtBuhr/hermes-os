/* ═══════════════════════════════════════════════════════════════════
   HERMES OS — WebSocket Client
   Real-time communication with auto-reconnect
   ═══════════════════════════════════════════════════════════════════ */

class WebSocketClient {
  constructor() {
    /** @type {WebSocket|null} */
    this.ws = null;
    /** @type {string} */
    this.url = '';
    /** @type {Map<string, Set<Function>>} */
    this.handlers = new Map();
    /** @type {number} */
    this.reconnectAttempts = 0;
    /** @type {number} */
    this.maxReconnectAttempts = 60;
    /** @type {number} */
    this.baseDelay = 1000;
    /** @type {number|null} */
    this.reconnectTimer = null;
    /** @type {boolean} */
    this.intentionalClose = false;
    /** @type {boolean} */
    this.connected = false;
  }

  /**
   * Establish a WebSocket connection.
   * @param {string} url — WebSocket URL (e.g. 'ws://localhost:3001/ws')
   * @returns {Promise<void>}
   */
  connect(url) {
    return new Promise((resolve, reject) => {
      this.url = url;
      this.intentionalClose = false;

      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        console.error('[WS] Failed to create WebSocket:', err);
        reject(err);
        return;
      }

      this.ws.onopen = () => {
        console.log('[WS] Connected to', url);
        this.connected = true;
        this.reconnectAttempts = 0;
        this._dispatch('open', { url });
        resolve();
      };

      this.ws.onclose = (event) => {
        console.log('[WS] Connection closed:', event.code, event.reason);
        this.connected = false;
        this._dispatch('close', {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });

        if (!this.intentionalClose) {
          this._scheduleReconnect();
        }
      };

      this.ws.onerror = (error) => {
        console.error('[WS] Error:', error);
        this._dispatch('error', { error });

        // Only reject on initial connection
        if (!this.connected && this.reconnectAttempts === 0) {
          reject(error);
        }
      };

      this.ws.onmessage = (event) => {
        this._handleMessage(event.data);
      };
    });
  }

  /**
   * Register an event handler.
   * @param {string} event — Event name (open, close, error, hermes_message, graph_update, file_added, system_status, etc.)
   * @param {Function} callback — Handler function
   * @returns {Function} Unsubscribe function
   */
  on(event, callback) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event).add(callback);

    // Return unsubscribe function
    return () => {
      const handlers = this.handlers.get(event);
      if (handlers) {
        handlers.delete(callback);
      }
    };
  }

  /**
   * Remove an event handler.
   * @param {string} event
   * @param {Function} callback
   */
  off(event, callback) {
    const handlers = this.handlers.get(event);
    if (handlers) {
      handlers.delete(callback);
    }
  }

  /**
   * Send a typed JSON message.
   * @param {string} type — Message type
   * @param {Object} data — Message payload
   */
  send(type, data = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[WS] Cannot send — not connected');
      return false;
    }

    const message = JSON.stringify({
      type,
      data,
      timestamp: Date.now(),
    });

    try {
      this.ws.send(message);
      return true;
    } catch (err) {
      console.error('[WS] Send error:', err);
      return false;
    }
  }

  /**
   * Gracefully close the connection.
   */
  disconnect() {
    this.intentionalClose = true;
    this.connected = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    console.log('[WS] Disconnected');
  }

  /**
   * Check if the client is currently connected.
   * @returns {boolean}
   */
  isConnected() {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  // ── Private Methods ─────────────────────────────────────────

  /**
   * Parse and dispatch incoming messages.
   * @private
   */
  _handleMessage(raw) {
    try {
      const message = JSON.parse(raw);
      const { type } = message;
      const data = message.payload ?? message.data ?? {};

      if (type) {
        this._dispatch(type, data || {});
      }

      // Also dispatch a generic 'message' event
      this._dispatch('message', message);
    } catch (err) {
      // Non-JSON message — dispatch as raw
      console.warn('[WS] Non-JSON message received:', raw);
      this._dispatch('message', { raw });
    }
  }

  /**
   * Dispatch event to registered handlers.
   * @private
   */
  _dispatch(event, data) {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (err) {
          console.error(`[WS] Handler error for "${event}":`, err);
        }
      }
    }
  }

  /**
   * Schedule a reconnection with exponential backoff.
   * @private
   */
  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WS] Max reconnect attempts reached. Giving up.');
      this._dispatch('reconnect_failed', {
        attempts: this.reconnectAttempts,
      });
      return;
    }

    const delay = this.baseDelay * Math.pow(2, this.reconnectAttempts);
    const jitter = delay * 0.2 * Math.random();
    const totalDelay = Math.min(delay + jitter, 30000);

    this.reconnectAttempts++;
    console.log(
      `[WS] Reconnecting in ${Math.round(totalDelay)}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    );

    this._dispatch('reconnecting', {
      attempt: this.reconnectAttempts,
      delay: totalDelay,
    });

    this.reconnectTimer = setTimeout(() => {
      this.connect(this.url).catch(() => {
        // Will trigger onclose → _scheduleReconnect again
      });
    }, totalDelay);
  }
}

// ── Singleton Export ─────────────────────────────────────────────
const wsClient = new WebSocketClient();
export default wsClient;
export { WebSocketClient };
