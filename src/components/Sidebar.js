import { getHermesStatus } from '../utils/api.js';
import { pulseElement } from '../utils/animations.js';

const ICONS = {
  dashboard: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
    <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
  </svg>`,
  graph: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/>
    <line x1="8.5" y1="7.5" x2="15.5" y2="16.5"/><line x1="15.5" y1="7.5" x2="8.5" y2="16.5"/>
  </svg>`,
  files: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  </svg>`,
  analytics: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/>
    <line x1="6" y1="20" x2="6" y2="14"/>
  </svg>`,
  hermes: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="9"/>
    <circle cx="12" cy="12" r="3"/>
    <line x1="12" y1="3" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="21"/>
    <line x1="3" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="21" y2="12"/>
  </svg>`
};

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: ICONS.dashboard },
  { id: 'graph', label: 'Knowledge Graph', icon: ICONS.graph },
  { id: 'files', label: 'Files', icon: ICONS.files },
  { id: 'analytics', label: 'Analytics', icon: ICONS.analytics },
  { id: 'hermes', label: 'Hermes', icon: ICONS.hermes }
];

export class Sidebar {
  constructor(container) {
    this.container = container;
    this.el = null;
    this.activeSection = 'dashboard';
    this.uptimeInterval = null;
    this.uptimeSeconds = 0;
    this.nodeCount = 0;
    this.edgeCount = 0;
  }

  render() {
    this.el = document.createElement('aside');
    this.el.className = 'sidebar';
    this.el.innerHTML = this._template();
    this.container.appendChild(this.el);

    // Bind nav clicks
    this.el.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        const section = item.dataset.section;
        this.setActive(section);
        this.container.dispatchEvent(new CustomEvent('navigate', {
          detail: { section },
          bubbles: true
        }));
      });
    });

    // Set initial active
    this.setActive(this.activeSection);

    // Start uptime counter
    this._startUptime();

    // Fetch initial stats
    this._fetchStats();
  }

  _template() {
    return `
      <div class="sidebar-brand">
        <div class="sidebar-logo">
          <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
            <circle cx="20" cy="20" r="8" fill="#00f0ff" opacity="0.3"/>
            <circle cx="20" cy="20" r="8" stroke="#00f0ff" stroke-width="1.5" fill="none"/>
            <circle cx="20" cy="20" r="13" stroke="#00f0ff" stroke-width="1" fill="none" opacity="0.5" stroke-dasharray="4 3"/>
            <circle cx="20" cy="20" r="18" stroke="#7b2fff" stroke-width="0.8" fill="none" opacity="0.3" stroke-dasharray="2 4"/>
            <circle cx="20" cy="20" r="3" fill="#00f0ff"/>
          </svg>
        </div>
        <span class="sidebar-title">HERMES OS</span>
      </div>

      <nav class="sidebar-nav">
        ${NAV_ITEMS.map(item => `
          <div class="nav-item" data-section="${item.id}" title="${item.label}">
            <span class="nav-icon">${item.icon}</span>
            <span class="nav-label">${item.label}</span>
          </div>
        `).join('')}
      </nav>

      <div class="sidebar-status">
        <div class="status-indicator">
          <span class="status-dot status-dot--online"></span>
          <span class="status-text">System Nominal</span>
        </div>
        <div class="sidebar-stats">
          <div class="stat-row">
            <span class="stat-label">Nodes</span>
            <span class="stat-value" id="sidebar-nodes">0</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Edges</span>
            <span class="stat-value" id="sidebar-edges">0</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Uptime</span>
            <span class="stat-value stat-mono" id="sidebar-uptime">00:00:00</span>
          </div>
        </div>
      </div>
    `;
  }

  setActive(section) {
    this.activeSection = section;
    this.el.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.section === section);
    });
  }

  updateStats(stats) {
    if (stats.nodes !== undefined) {
      this.nodeCount = stats.nodes;
      const nodesEl = this.el.querySelector('#sidebar-nodes');
      if (nodesEl) nodesEl.textContent = this.nodeCount;
    }
    if (stats.edges !== undefined) {
      this.edgeCount = stats.edges;
      const edgesEl = this.el.querySelector('#sidebar-edges');
      if (edgesEl) edgesEl.textContent = this.edgeCount;
    }
  }

  async _fetchStats() {
    try {
      const status = await getHermesStatus();
      this.updateStats({
        nodes: status.nodes || 0,
        edges: status.edges || 0
      });
    } catch (e) {
      // Silent fail — stats will show 0
    }
  }

  _startUptime() {
    this.uptimeInterval = setInterval(() => {
      this.uptimeSeconds++;
      const h = String(Math.floor(this.uptimeSeconds / 3600)).padStart(2, '0');
      const m = String(Math.floor((this.uptimeSeconds % 3600) / 60)).padStart(2, '0');
      const s = String(this.uptimeSeconds % 60).padStart(2, '0');
      const el = this.el.querySelector('#sidebar-uptime');
      if (el) el.textContent = `${h}:${m}:${s}`;
    }, 1000);
  }

  destroy() {
    if (this.uptimeInterval) clearInterval(this.uptimeInterval);
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = null;
  }
}
