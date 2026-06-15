/* ═══════════════════════════════════════════════════════════════════
   HERMES OS — Main Entry Point
   Bootstraps the application shell and all modules
   ═══════════════════════════════════════════════════════════════════ */

// ── Styles (imported for Vite bundling) ─────────────────────────
import './styles/index.css';
import './styles/graph.css';

// ── Utilities ───────────────────────────────────────────────────
import wsClient from './utils/websocket.js';
import * as api from './utils/api.js';
import { initParticleBackground } from './utils/animations.js';

// ── Components (lazy-loaded when available) ─────────────────────
// These will be created by other agents — we import them dynamically
// to avoid blocking the shell if they don't exist yet.
const componentModules = {
  Dashboard:      () => import('./components/Dashboard.js').catch(() => null),
  Sidebar:        () => import('./components/Sidebar.js').catch(() => null),
  TopBar:         () => import('./components/TopBar.js').catch(() => null),
  GraphView:      () => import('./components/GraphView.js').catch(() => null),
  HermesConsole:  () => import('./components/HermesConsole.js').catch(() => null),
  FileManager:    () => import('./components/FileManager.js').catch(() => null),
  AnalyticsPanel: () => import('./components/AnalyticsPanel.js').catch(() => null),
  CognitionPanel: () => import('./components/CognitionPanel.js').catch(() => null),
  CouncilPanel:   () => import('./components/CouncilPanel.js').catch(() => null),
};

const VIEW_TITLES = {
  dashboard: 'Dashboard',
  graph: 'Knowledge Graph',
  files: 'File Manager',
  analytics: 'Analytics',
  cognition: 'Research & Dreams',
  council: 'Research Council',
  console: 'Hermes Console',
};

const VIEW_COMPONENTS = {
  dashboard: 'Dashboard',
  graph: 'GraphView',
  files: 'FileManager',
  analytics: 'AnalyticsPanel',
  cognition: 'CognitionPanel',
  council: 'CouncilPanel',
  console: 'HermesConsole',
};


class HermesOS {
  constructor() {
    /** @type {Object<string, any>} Loaded component instances */
    this.components = {};

    /** @type {Object<string, Function>} Loaded component classes */
    this.componentClasses = {};

    /** @type {any|null} Current top-level view instance */
    this.activeViewInstance = null;

    /** @type {string|null} Current top-level component name */
    this.activeComponentName = null;

    /** @type {string} Current active view */
    this.currentView = 'dashboard';

    /** @type {{ destroy: Function }|null} Particle system handle */
    this.particles = null;

    /** @type {boolean} Whether the app has initialized */
    this.initialized = false;

    /** @type {Object} App-wide state */
    this.state = {
      hermesOnline: false,
      graphData: null,
      files: [],
      notifications: [],
    };
  }

  /**
   * Initialize the entire application.
   */
  async init() {
    console.log('[HermesOS] Initializing...');

    try {
      // 1. Start particle background immediately
      this.particles = initParticleBackground('particles-canvas');

      // 2. Render the app shell into the DOM
      this.renderShell();

      // 3. Load and initialize all components
      await this.loadComponents();

      // 4. Setup WebSocket event routing before connecting so the greeting is captured
      this.setupWebSocketHandlers();

      // 5. Connect WebSocket (non-blocking — app works without it)
      this.connectWebSocket();

      // 6. Fetch initial data
      this.fetchInitialData();

      // 7. Start the clock
      this.startClock();

      // 8. Live AI-model chooser in the topbar
      this.initModelChooser();

      this.initialized = true;
      console.log('[HermesOS] ✓ Initialization complete');
    } catch (err) {
      console.error('[HermesOS] Initialization error:', err);
    }

    // 8. Hide loading screen quickly — the OS should feel instant
    setTimeout(() => this.hideLoadingScreen(), 650);
  }

  /**
   * Render the main application shell (sidebar + main content area).
   */
  renderShell() {
    const root = document.getElementById('hermes-os-root');
    if (!root) {
      console.error('[HermesOS] #hermes-os-root not found');
      return;
    }

    root.innerHTML = `
      <div class="app-shell">
        <!-- Sidebar -->
        <aside class="sidebar" id="sidebar">
          <div class="sidebar-brand">
            <div class="sidebar-logo">⚖</div>
            <div class="sidebar-brand-text"><span>RESEARCH</span> COUNCIL</div>
          </div>

          <div class="sidebar-section-label">Navigation</div>
          <nav class="sidebar-nav" id="sidebar-nav">
            <div class="nav-item active" data-view="dashboard">
              <span class="nav-item-icon">◉</span>
              <span class="nav-item-label">Dashboard</span>
            </div>
            <div class="nav-item" data-view="graph">
              <span class="nav-item-icon">◎</span>
              <span class="nav-item-label">Knowledge Graph</span>
            </div>
            <div class="nav-item" data-view="files">
              <span class="nav-item-icon">◫</span>
              <span class="nav-item-label">File Manager</span>
            </div>
            <div class="nav-item" data-view="analytics">
              <span class="nav-item-icon">◈</span>
              <span class="nav-item-label">Analytics</span>
            </div>
            <div class="nav-item" data-view="cognition">
              <span class="nav-item-icon">✦</span>
              <span class="nav-item-label">Research &amp; Dreams</span>
            </div>
            <div class="nav-item" data-view="council">
              <span class="nav-item-icon">⚖</span>
              <span class="nav-item-label">Research Council</span>
            </div>
            <div class="nav-item" data-view="console">
              <span class="nav-item-icon">▹</span>
              <span class="nav-item-label">Hermes Console</span>
            </div>
          </nav>

          <div class="sidebar-status">
            <div class="sidebar-status-indicator">
              <span class="status-dot" id="sidebar-status-dot"></span>
              <span>Hermes Online</span>
            </div>
          </div>
        </aside>

        <!-- Main Content -->
        <div class="main-content">
          <!-- Top Bar -->
          <header class="topbar" id="topbar">
            <div class="topbar-left">
              <h2 class="topbar-page-title" id="page-title">Dashboard</h2>
            </div>

            <div class="search-box">
              <span class="search-box-icon">⌕</span>
              <input type="text" placeholder="Search Hermes OS..." id="global-search" />
            </div>

            <div class="topbar-actions">
              <div class="model-chooser" id="model-chooser" data-tooltip="AI brain — switches live, mid-council">
                <span class="model-chooser-dot" id="model-chooser-dot"></span>
                <select id="model-chooser-select" class="model-chooser-select" aria-label="AI model">
                  <option value="" disabled selected>Loading models…</option>
                </select>
              </div>
              <div class="hermes-chip">
                <span class="status-dot"></span>
                Hermes Online
              </div>
              <span class="topbar-clock mono" id="topbar-clock">--:--:--</span>
              <button class="topbar-btn" data-tooltip="Notifications" id="notifications-btn">
                🔔
                <span class="notification-dot hidden" id="notification-dot"></span>
              </button>
            </div>
          </header>

          <!-- Main Area (views render here) -->
          <main class="main-area" id="main-area">
            <div id="view-container"></div>
          </main>
        </div>
      </div>
    `;

    // Bind navigation
    this.bindNavigation();
  }

  /**
   * Bind sidebar navigation clicks.
   */
  bindNavigation() {
    const nav = document.getElementById('sidebar-nav');
    if (!nav) return;

    nav.addEventListener('click', (e) => {
      const item = e.target.closest('.nav-item');
      if (!item) return;

      const view = item.dataset.view;
      if (view && view !== this.currentView) {
        this.navigateTo(view);
      }
    });
  }

  /**
   * Navigate to a different view.
   * @param {string} view
   */
  navigateTo(view) {
    // Update active nav item
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach((item) => {
      item.classList.toggle('active', item.dataset.view === view);
    });

    // Update page title
    const pageTitle = document.getElementById('page-title');
    if (pageTitle) {
      pageTitle.textContent = VIEW_TITLES[view] || view;
    }

    this.currentView = view;

    // Render the appropriate component
    void this.renderView(view);
  }

  /**
   * Render a view into the main container.
   * @param {string} view
   */
  async renderView(view) {
    const container = document.getElementById('view-container');
    if (!container) return;

    if (this.activeViewInstance && typeof this.activeViewInstance.destroy === 'function') {
      this.activeViewInstance.destroy();
    }
    if (this.activeComponentName) {
      delete this.components[this.activeComponentName];
    }
    this.activeViewInstance = null;
    this.activeComponentName = null;

    // Retrigger the snappy entrance animation on every navigation.
    container.classList.remove('view-anim');
    void container.offsetWidth;
    container.classList.add('view-anim');

    const componentName = VIEW_COMPONENTS[view];
    const ComponentClass = this.componentClasses[componentName];

    if (ComponentClass) {
      try {
        container.innerHTML = '';
        const instance = new ComponentClass(container, this);
        this.components[componentName] = instance;
        this.activeViewInstance = instance;
        this.activeComponentName = componentName;

        if (typeof instance.init === 'function') {
          await instance.init();
        } else if (typeof instance.render === 'function') {
          await instance.render(container);
        }
      } catch (err) {
        console.error(`[HermesOS] Failed to render ${componentName}:`, err);
        this.renderFallback(container, view, err.message);
      }
    } else {
      this.renderFallback(container, view, 'Component loading...');
    }
  }

  renderFallback(container, view, detail = 'Component loading...') {
    container.innerHTML = `
      <div class="card animate-in" style="text-align: center; padding: 48px;">
        <div style="font-size: 48px; margin-bottom: 16px; opacity: 0.3;">◉</div>
        <h3 style="color: var(--text-secondary); margin-bottom: 8px;">
          ${VIEW_TITLES[view] || view}
        </h3>
        <p style="color: var(--text-muted); font-size: 13px;">
          ${detail}
        </p>
      </div>
    `;
  }

  /**
   * Dynamically load all component modules.
   */
  async loadComponents() {
    const entries = Object.entries(componentModules);

    const results = await Promise.all(
      entries.map(async ([name, loader]) => {
        try {
          const module = await loader();
          const ComponentClass = module?.default || module?.[name];
          if (typeof ComponentClass === 'function') {
            return [name, ComponentClass];
          }
        } catch (err) {
          console.warn(`[HermesOS] Component "${name}" not available yet:`, err.message);
        }
        return [name, null];
      })
    );

    for (const [name, ComponentClass] of results) {
      if (ComponentClass) {
        this.componentClasses[name] = ComponentClass;
        console.log(`[HermesOS] ✓ Loaded component: ${name}`);
      }
    }

    // Render the initial view
    await this.renderView(this.currentView);
  }

  /**
   * Connect to the WebSocket server.
   */
  async connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws`;

    try {
      await wsClient.connect(wsUrl);
      console.log('[HermesOS] ✓ WebSocket connected');
    } catch (err) {
      console.warn('[HermesOS] WebSocket connection failed — running offline:', err.message);
    }
  }

  /**
   * Setup WebSocket event handlers to dispatch to components.
   */
  setupWebSocketHandlers() {
    // Hermes AI messages → Console
    wsClient.on('hermes_message', (data) => {
      console.log('[HermesOS] Hermes message:', data);
      if (this.components.HermesConsole?.onMessage) {
        this.components.HermesConsole.onMessage(data);
      }
      if (this.components.Dashboard?.onHermesMessage) {
        this.components.Dashboard.onHermesMessage(data);
      }
    });

    wsClient.on('hermes_greeting', (data) => {
      const message = {
        type: 'hermes',
        text: data.greeting || 'Hermes OS online. All subsystems reporting.',
        timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
      };
      if (this.components.HermesConsole?.onMessage) {
        this.components.HermesConsole.onMessage(message);
      }
      if (this.components.Dashboard?.onHermesMessage) {
        this.components.Dashboard.onHermesMessage(message);
      }
      if (data.status) this.updateStatusIndicators(data.status);
    });

    wsClient.on('hermes_event', (data) => {
      console.log('[HermesOS] Hermes event:', data);
    });

    wsClient.on('hermes_trace', (data) => {
      if (this.components.GraphView?.onHermesTrace) {
        this.components.GraphView.onHermesTrace(data);
      }
      if (this.components.Dashboard?.onHermesTrace) {
        this.components.Dashboard.onHermesTrace(data);
      }
      if (this.components.HermesConsole?.onTrace) {
        this.components.HermesConsole.onTrace(data);
      }
    });

    wsClient.on('dashboard_action', (data) => {
      if (this.components.Dashboard?.onDashboardAction) {
        this.components.Dashboard.onDashboardAction(data);
      }
    });

    // Hermes thinking indicator → console (top-level + embedded)
    wsClient.on('hermes_thinking', (data) => {
      this.components.HermesConsole?.onThinking?.(data);
      this.components.Dashboard?.hermesConsole?.onThinking?.(data);
    });

    // Live theme changes (Hermes recolors the UI on command)
    wsClient.on('ui_theme', (data) => {
      this._applyTheme(data.accent, data.mode);
      this._themeApplied = true;
    });

    wsClient.on('analytics_update', (data) => {
      if (this.components.AnalyticsPanel?.onAnalyticsUpdate) {
        this.components.AnalyticsPanel.onAnalyticsUpdate(data);
      }
      if (this.components.Dashboard?.onAnalyticsUpdate) {
        this.components.Dashboard.onAnalyticsUpdate(data);
      }
    });

    // Cognition streams: research pipelines + dream cycles, live
    wsClient.on('research_update', (data) => {
      this.components.CognitionPanel?.onResearchUpdate?.(data);
      this.components.Dashboard?.onResearchUpdate?.(data);
    });

    wsClient.on('dream_update', (data) => {
      this.components.CognitionPanel?.onDreamUpdate?.(data);
      this.components.Dashboard?.onDreamUpdate?.(data);
    });

    // Research Council stream: tournament + agent activity, live
    wsClient.on('council_update', (data) => {
      this.components.CouncilPanel?.onCouncilUpdate?.(data);
    });

    // Agent minds: thinking/idle transitions + live thoughts per station
    wsClient.on('council_agent_state', (data) => {
      this.components.CouncilPanel?.onAgentState?.(data);
    });

    // Agent retunes: operator changed an agent's attributes
    wsClient.on('council_agent_traits', (data) => {
      this.components.CouncilPanel?.onAgentTraits?.(data);
    });

    // Operator vetoes, brain-call telemetry, power-dial moves
    wsClient.on('council_veto', (data) => {
      this.components.CouncilPanel?.onVeto?.(data);
    });
    wsClient.on('council_call', (data) => {
      this.components.CouncilPanel?.onCouncilCall?.(data);
    });
    wsClient.on('council_power', (data) => {
      this.components.CouncilPanel?.onPower?.(data);
    });

    // Debate Chamber: rival perspectives streaming in live
    wsClient.on('council_debate', (data) => {
      this.components.CouncilPanel?.onCouncilDebate?.(data);
    });

    // Operator purge: the board was cleared and the council pivoted
    wsClient.on('council_purge', (data) => {
      this.components.CouncilPanel?.onPurge?.(data);
    });

    // Graph updates → GraphView + Dashboard
    wsClient.on('graph_update', (data) => {
      console.log('[HermesOS] Graph update:', data);
      this.state.graphData = data;
      if (this.components.GraphView?.onGraphUpdate) {
        this.components.GraphView.onGraphUpdate(data);
      }
      if (this.components.Dashboard?.onGraphUpdate) {
        this.components.Dashboard.onGraphUpdate(data);
      }
    });

    // File events → FileManager + Dashboard
    wsClient.on('file_added', (data) => {
      console.log('[HermesOS] File added:', data);
      if (this.components.FileManager?.onFileAdded) {
        this.components.FileManager.onFileAdded(data);
      }
      if (this.components.Dashboard?.onFileAdded) {
        this.components.Dashboard.onFileAdded(data);
      }
    });

    // System status → update status indicators
    wsClient.on('system_status', (data) => {
      this.updateStatusIndicators(data);
      if (this.components.HermesConsole?.onStatus) {
        this.components.HermesConsole.onStatus(data);
      }
      this.components.CognitionPanel?.onStatus?.(data);
    });

    // Connection state indicators
    wsClient.on('close', () => {
      const chip = document.querySelector('.hermes-chip');
      if (chip) {
        chip.textContent = 'Offline';
        chip.style.borderColor = 'rgba(255, 51, 102, 0.3)';
        chip.style.background = 'rgba(255, 51, 102, 0.08)';
        chip.style.color = 'var(--accent-red)';
      }
    });

    wsClient.on('open', () => {
      const chip = document.querySelector('.hermes-chip');
      if (chip) {
        chip.innerHTML = '<span class="status-dot"></span> Hermes Online';
        chip.style.borderColor = '';
        chip.style.background = '';
        chip.style.color = '';
      }
    });
  }

  /**
   * Fetch initial data from the API.
   */
  async fetchInitialData() {
    try {
      const [graphData, files] = await Promise.allSettled([
        api.getGraphData(),
        api.getFiles(),
      ]);

      if (graphData.status === 'fulfilled') {
        this.state.graphData = graphData.value;
      }
      if (files.status === 'fulfilled') {
        this.state.files = files.value;
      }
    } catch (err) {
      console.warn('[HermesOS] Initial data fetch failed:', err.message);
    }
  }

  updateStatusIndicators(status = {}) {
    this.state.hermesOnline = status.online ?? status.status !== 'offline';
    const dot = document.getElementById('sidebar-status-dot');
    if (dot) {
      dot.classList.toggle('offline', !this.state.hermesOnline);
    }
    const chip = document.querySelector('.hermes-chip');
    if (chip && status.agent) {
      const brainReady = Boolean(status.agent.brain?.ready);
      chip.innerHTML = `<span class="status-dot ${brainReady ? '' : 'offline'}"></span> ${brainReady ? 'Gemini Brain' : 'Hermes Local'}`;
      chip.classList.toggle('hermes-chip--warning', !brainReady);
    }
    // Apply the operator's saved accent/theme once we learn it from status.
    if (status.agent && (status.agent.accent || status.agent.themeMode) && !this._themeApplied) {
      this._applyTheme(status.agent.accent, status.agent.themeMode);
      this._themeApplied = true;
    }
    if (this.components.Dashboard?.updateStats) {
      this.components.Dashboard.updateStats(status);
    }
  }

  /** Live-recolor the whole UI by overriding the cyan accent CSS variables. */
  _applyTheme(accent, mode) {
    const root = document.documentElement;
    if (accent && /^#?[0-9a-fA-F]{6}$/.test(accent)) {
      const hex = accent.startsWith('#') ? accent : `#${accent}`;
      const rgba = (a) => {
        const n = parseInt(hex.slice(1), 16);
        return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
      };
      root.style.setProperty('--accent-cyan', hex);
      root.style.setProperty('--accent-cyan-dim', rgba(0.15));
      root.style.setProperty('--glow-cyan', `0 0 20px ${rgba(0.3)}`);
      root.style.setProperty('--border-glass', rgba(0.12));
      root.style.setProperty('--border-active', rgba(0.35));
    }
    if (mode === 'light' || mode === 'dark') {
      root.setAttribute('data-theme', mode);
    }
  }

  /**
   * Topbar AI-model chooser. Switching PATCHes the brain config on the
   * server; the Brain re-reads config on every LLM call, so research,
   * dreams and a running council pick up the new model instantly.
   */
  async initModelChooser() {
    const select = document.getElementById('model-chooser-select');
    const dot = document.getElementById('model-chooser-dot');
    if (!select) return;

    const paint = (optionId) => {
      if (!dot) return;
      dot.classList.toggle('model-chooser-dot--openrouter', String(optionId).startsWith('openrouter'));
    };

    try {
      const data = await api.getHermesModels();
      this._modelOptions = data.options || [];
      select.innerHTML = this._modelOptions
        .map(o => `<option value="${o.id}">${o.label} — ${o.sub}</option>`)
        .join('');
      select.value = data.active || 'gemini-flash';
      paint(select.value);
    } catch (err) {
      console.error('[HermesOS] Model chooser load failed:', err);
      select.innerHTML = '<option value="" disabled selected>Models unavailable</option>';
      return;
    }

    select.addEventListener('change', async () => {
      const opt = (this._modelOptions || []).find(o => o.id === select.value);
      if (!opt) return;
      select.disabled = true;
      try {
        await api.updateHermesConfig(opt.config);
        paint(opt.id);
        window.dispatchEvent(new CustomEvent('hermes:model-changed', { detail: opt }));
        console.log(`[HermesOS] Brain switched to ${opt.label} — applies on the next LLM call.`);
      } catch (err) {
        console.error('[HermesOS] Model switch failed:', err);
        // Re-sync the dropdown with what the server actually has.
        try {
          const data = await api.getHermesModels();
          select.value = data.active;
          paint(data.active);
        } catch { /* leave as-is */ }
      } finally {
        select.disabled = false;
      }
    });
  }

  /**
   * Start the topbar clock.
   */
  startClock() {
    const clockEl = document.getElementById('topbar-clock');
    if (!clockEl) return;

    const updateClock = () => {
      const now = new Date();
      clockEl.textContent = now.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    };

    updateClock();
    setInterval(updateClock, 1000);
  }

  /**
   * Hide the loading screen with a fade transition.
   */
  hideLoadingScreen() {
    const screen = document.getElementById('loading-screen');
    if (screen) {
      screen.classList.add('loaded');
    }
  }
}


// ── Bootstrap ───────────────────────────────────────────────────
let hermesInstance = null;

document.addEventListener('DOMContentLoaded', () => {
  hermesInstance = new HermesOS();
  hermesInstance.init();
});

export default hermesInstance;
export { HermesOS };
