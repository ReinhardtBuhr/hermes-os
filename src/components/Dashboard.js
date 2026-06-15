import { getHermesStatus } from '../utils/api.js';
import { countUp, fadeIn } from '../utils/animations.js';
import { GraphView } from './GraphView.js';
import { HermesConsole } from './HermesConsole.js';
import { FileManager } from './FileManager.js';
import { AnalyticsPanel } from './AnalyticsPanel.js';

const STAT_CARDS = [
  {
    id: 'total-nodes',
    label: 'Total Nodes',
    key: 'nodeCount',
    icon: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#00f0ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="4"/><circle cx="4" cy="4" r="2"/><circle cx="20" cy="4" r="2"/>
      <circle cx="4" cy="20" r="2"/><circle cx="20" cy="20" r="2"/>
      <line x1="6" y1="6" x2="9" y2="9"/><line x1="15" y1="9" x2="18" y2="6"/>
      <line x1="6" y1="18" x2="9" y2="15"/><line x1="15" y1="15" x2="18" y2="18"/>
    </svg>`,
    color: '#00f0ff',
    fallback: 0
  },
  {
    id: 'active-edges',
    label: 'Active Edges',
    key: 'edgeCount',
    icon: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#7b2fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
    </svg>`,
    color: '#7b2fff',
    fallback: 0
  },
  {
    id: 'files-indexed',
    label: 'Files Indexed',
    key: 'fileCount',
    icon: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
    </svg>`,
    color: '#3b82f6',
    fallback: 0
  },
  {
    id: 'system-health',
    label: 'System Health',
    key: 'health',
    icon: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#00ff88" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
    </svg>`,
    color: '#00ff88',
    suffix: '%',
    fallback: 98
  }
];

export class Dashboard {
  constructor(container, app = null) {
    this.container = container;
    this.app = app;
    this.el = null;
    this.graphView = null;
    this.hermesConsole = null;
    this.fileManager = null;
    this.analyticsPanel = null;
    this.statValues = {};
    this.traceEvents = [];
  }

  async render() {
    this.el = document.createElement('div');
    this.el.className = 'dashboard';
    this.el.innerHTML = `
      <div class="dashboard-stats-row">
        ${STAT_CARDS.map(card => `
          <div class="card stat-card" id="stat-${card.id}">
            <div class="stat-card-inner">
              <div class="stat-card-icon" style="color: ${card.color}">${card.icon}</div>
              <div class="stat-card-content">
                <span class="stat-card-label">${card.label}</span>
                <span class="stat-card-value" id="stat-value-${card.id}" data-target="0">0${card.suffix || ''}</span>
              </div>
            </div>
            <div class="stat-card-glow" style="background: linear-gradient(135deg, ${card.color}11, transparent)"></div>
          </div>
        `).join('')}
      </div>

      <div class="dashboard-agent-row">
        <div class="agent-module" data-agent-module="brain">
          <span class="agent-module-label">Brain</span>
          <strong id="agent-brain-value">Local fallback</strong>
          <small id="agent-brain-detail">Waiting for CLI bridge</small>
        </div>
        <div class="agent-module" data-agent-module="memory">
          <span class="agent-module-label">Memory</span>
          <strong id="agent-memory-value">0</strong>
          <small>persistent items</small>
        </div>
        <div class="agent-module" data-agent-module="loops">
          <span class="agent-module-label">Improvement Loops</span>
          <strong id="agent-loops-value">0</strong>
          <small>queued, supervised</small>
        </div>
        <div class="agent-module" data-agent-module="trace">
          <span class="agent-module-label">Live Trace</span>
          <strong id="agent-trace-value">Idle</strong>
          <small id="agent-trace-detail">No current action</small>
        </div>
      </div>

      <div class="dashboard-graph-row">
        <div class="card card-full">
          <div class="card-header">
            <div class="card-header-left">
              <span class="card-header-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00f0ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/>
                  <line x1="8.5" y1="7.5" x2="15.5" y2="16.5"/><line x1="15.5" y1="7.5" x2="8.5" y2="16.5"/>
                </svg>
              </span>
              <span class="card-title">Knowledge Graph — Graphify Neural Map</span>
            </div>
            <div class="card-header-actions">
              <span class="card-badge">LIVE</span>
            </div>
          </div>
          <div class="card-body" id="dashboard-graph-container" style="min-height: 500px; padding: 0;"></div>
        </div>
      </div>

      <div class="dashboard-middle-row">
        <div class="card card-half">
          <div class="card-header">
            <div class="card-header-left">
              <span class="card-header-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00f0ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>
                  <line x1="12" y1="3" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="21"/>
                </svg>
              </span>
              <span class="card-title">Hermes Console</span>
            </div>
            <span class="card-badge card-badge-cyan">AI</span>
          </div>
          <div class="card-body" id="dashboard-console-container"></div>
        </div>

        <div class="card card-half">
          <div class="card-header">
            <div class="card-header-left">
              <span class="card-header-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7b2fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/>
                  <line x1="6" y1="20" x2="6" y2="14"/>
                </svg>
              </span>
              <span class="card-title">Analytics Overview</span>
            </div>
            <span class="card-badge card-badge-purple">METRICS</span>
          </div>
          <div class="card-body" id="dashboard-analytics-container"></div>
        </div>
      </div>

      <div class="dashboard-bottom-row">
        <div class="card card-full">
          <div class="card-header">
            <div class="card-header-left">
              <span class="card-header-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
              </span>
              <span class="card-title">File Manager</span>
            </div>
            <span class="card-badge card-badge-blue">STORAGE</span>
          </div>
          <div class="card-body" id="dashboard-files-container"></div>
        </div>
      </div>
    `;
    this.container.appendChild(this.el);

    // Initialize child components
    const graphContainer = this.el.querySelector('#dashboard-graph-container');
    const consoleContainer = this.el.querySelector('#dashboard-console-container');
    const analyticsContainer = this.el.querySelector('#dashboard-analytics-container');
    const filesContainer = this.el.querySelector('#dashboard-files-container');

    this.graphView = new GraphView(graphContainer);
    this.hermesConsole = new HermesConsole(consoleContainer);
    this.analyticsPanel = new AnalyticsPanel(analyticsContainer);
    this.fileManager = new FileManager(filesContainer);

    // Fetch stats and init children in parallel
    const [statusResult] = await Promise.allSettled([
      getHermesStatus(),
      this.graphView.init(),
      this.hermesConsole.init(),
      this.analyticsPanel.init(),
      this.fileManager.init()
    ]);

    // Animate stat cards
    const status = statusResult.value || {};
    this.updateAgentStatus(status);
    STAT_CARDS.forEach(card => {
      const value = this._getStatValue(status, card, true);
      const valueEl = this.el.querySelector(`#stat-value-${card.id}`);
      if (valueEl) {
        try {
          countUp(valueEl, value, {
            suffix: card.suffix || '',
            duration: 1800
          });
        } catch (e) {
          valueEl.textContent = `${value}${card.suffix || ''}`;
        }
        this.statValues[card.id] = value;
      }
    });
  }

  updateStats(data) {
    if (!data || !this.el) return;
    this.updateAgentStatus(data);
    STAT_CARDS.forEach(card => {
      const value = this._getStatValue(data, card, false);
      if (value !== undefined) {
        const valueEl = this.el.querySelector(`#stat-value-${card.id}`);
        if (valueEl) {
          valueEl.textContent = `${value}${card.suffix || ''}`;
          this.statValues[card.id] = value;
        }
      }
    });
  }

  onGraphUpdate(data) {
    if (this.graphView?.updateData) {
      this.graphView.updateData(data);
    }
    this.updateStats({
      nodeCount: data?.nodes?.length,
      edgeCount: data?.edges?.length || data?.links?.length,
    });
  }

  onFileAdded(payload) {
    const file = payload?.file || payload;
    if (file && this.fileManager?.onFileAdded) {
      this.fileManager.onFileAdded(file);
    }
    const nextCount = (this.statValues['files-indexed'] || 0) + 1;
    this.updateStats({ fileCount: nextCount });
  }

  onHermesMessage(message) {
    if (this.hermesConsole?.onMessage) {
      this.hermesConsole.onMessage(message);
    }
  }

  onHermesTrace(trace) {
    this.traceEvents.unshift(trace);
    this.traceEvents = this.traceEvents.slice(0, 20);
    const label = trace?.event ? trace.event.replace(/_/g, ' ') : 'event';
    const valueEl = this.el?.querySelector('#agent-trace-value');
    const detailEl = this.el?.querySelector('#agent-trace-detail');
    if (valueEl) valueEl.textContent = label;
    if (detailEl) detailEl.textContent = new Date(trace?.timestamp || Date.now()).toLocaleTimeString([], { hour12: false });
    if (this.hermesConsole?.onTrace) {
      this.hermesConsole.onTrace(trace);
    }
    if (this.graphView?.onHermesTrace) {
      this.graphView.onHermesTrace(trace);
    }
  }

  onDashboardAction(payload = {}) {
    const actions = payload.actions || [];
    if (!actions.length) return;
    const valueEl = this.el?.querySelector('#agent-trace-value');
    const detailEl = this.el?.querySelector('#agent-trace-detail');
    if (valueEl) valueEl.textContent = actions[0].type.replace(/_/g, ' ');
    if (detailEl) detailEl.textContent = actions.map(action => action.label).join(', ');
  }

  onAnalyticsUpdate(payload) {
    if (this.analyticsPanel?.onAnalyticsUpdate) {
      this.analyticsPanel.onAnalyticsUpdate(payload);
    }
  }

  onResearchUpdate(payload = {}) {
    this._paintCognitionTrace('📚 research', payload);
  }

  onDreamUpdate(payload = {}) {
    this._paintCognitionTrace('💭 dream', payload);
  }

  _paintCognitionTrace(label, payload) {
    const valueEl = this.el?.querySelector('#agent-trace-value');
    const detailEl = this.el?.querySelector('#agent-trace-detail');
    if (valueEl) valueEl.textContent = `${label} · ${payload.phase || ''}`;
    if (detailEl) {
      detailEl.textContent = payload.status === 'done'
        ? 'completed'
        : `${Math.round(payload.progress || 0)}% — ${String(payload.line || '').split('\n')[0].slice(0, 60)}`;
    }
  }

  updateAgentStatus(status = {}) {
    if (!this.el) return;
    const agent = status.agent || {};
    const brain = agent.brain || {};
    const brainValue = this.el.querySelector('#agent-brain-value');
    const brainDetail = this.el.querySelector('#agent-brain-detail');
    const memoryValue = this.el.querySelector('#agent-memory-value');
    const loopsValue = this.el.querySelector('#agent-loops-value');

    if (brainValue) brainValue.textContent = brain.ready ? (brain.model || 'Gemini') : 'Local mode';
    if (brainDetail) {
      brainDetail.textContent = brain.ready
        ? `${brain.provider || 'gemini'} connected`
        : (brain.reason === 'needs_login' ? 'Gemini CLI — login required'
          : brain.reason === 'cli_missing' ? 'Gemini CLI not installed'
          : 'Connect Gemini brain');
    }
    if (memoryValue) memoryValue.textContent = String(agent.memoryCount ?? 0);
    if (loopsValue) loopsValue.textContent = String(agent.queuedTasks ?? 0);
  }

  _getStatValue(data, card, useFallback = false) {
    if (!data) return useFallback ? card.fallback : undefined;
    if (card.key === 'health') {
      return data.health?.score ?? data.healthScore ?? (useFallback ? card.fallback : undefined);
    }
    return data[card.key] ?? (useFallback ? card.fallback : undefined);
  }

  destroy() {
    if (this.graphView) this.graphView.destroy();
    if (this.hermesConsole) this.hermesConsole.destroy();
    if (this.analyticsPanel) this.analyticsPanel.destroy();
    if (this.fileManager) this.fileManager.destroy();
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = null;
  }
}

export default Dashboard;
