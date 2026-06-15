import * as d3 from 'd3';
import { getAnalyticsWidgets, deleteAnalyticsWidget, sendHermesMessage } from '../utils/api.js';

const EXAMPLE_PROMPTS = [
  'add a live CPU load widget',
  'track monthly recurring revenue',
  'monitor API latency in ms',
  'add a widget for active users',
];

export class AnalyticsPanel {
  constructor(container) {
    this.container = container;
    this.el = null;
    this.widgets = [];
    this.traffic = [];
    this._prevValues = {};
  }

  async init() {
    this.render();
    await this.refresh();
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'analytics-panel analytics-panel--modular';
    this.el.innerHTML = `
      <div class="analytics-command-strip">
        <div>
          <div class="analytics-command-title">Realtime Analytics Matrix</div>
          <div class="analytics-command-subtitle">Modular &amp; live. Ask Hermes to add, update or remove any metric — it appears here instantly.</div>
        </div>
        <div class="analytics-live-badge">
          <span class="status-dot"></span>
          <span id="analytics-widget-count">0 widgets</span>
        </div>
      </div>

      <form class="analytics-ask" id="analytics-ask">
        <span class="analytics-ask-icon">✦</span>
        <input type="text" id="analytics-ask-input" placeholder="Add a metric in plain English — e.g. “track newsletter signups”" />
        <button type="submit" class="btn btn-primary btn-sm">Add</button>
      </form>

      <div class="analytics-hero card" id="analytics-hero">
        <div class="card-header">
          <div class="card-title">Brain Activity — Gemini round-trip latency</div>
          <div class="analytics-hero-legend">
            <span class="legend-item"><i style="background:#00f0ff"></i>Latency (ms)</span>
            <span class="legend-item" id="analytics-hero-stats"></span>
          </div>
        </div>
        <div class="analytics-hero-chart" id="analytics-hero-chart"></div>
      </div>

      <div class="analytics-widget-grid" id="analytics-widget-grid"></div>
    `;
    this.container.appendChild(this.el);

    const form = this.el.querySelector('#analytics-ask');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = this.el.querySelector('#analytics-ask-input');
      const text = input.value.trim();
      if (text) { this._ask(text); input.value = ''; }
    });
  }

  async _ask(text) {
    const directive = /\b(add|track|monitor|create|show|build|remove|delete)\b/i.test(text) ? text : `add an analytics widget for ${text}`;
    try { await sendHermesMessage(directive); } catch { /* ws will refresh */ }
    // Optimistic refresh shortly after; ws analytics_update will also fire.
    setTimeout(() => this.refresh(), 400);
  }

  async refresh() {
    try { this.widgets = await getAnalyticsWidgets(); } catch { this.widgets = []; }
    this._renderWidgets();
    this._renderHero();
  }

  onAnalyticsUpdate(payload = {}) {
    const next = Array.isArray(payload) ? payload : (Array.isArray(payload.widgets) ? payload.widgets : null);
    if (next) {
      // capture prior values to flash changes
      this._prevValues = Object.fromEntries(this.widgets.map(w => [w.id, w.value]));
      this.widgets = next;
      this._renderWidgets();
      this._renderHero();
    }
  }

  // Hero chart: REAL telemetry — every Gemini call's round-trip time.
  _renderHero() {
    const host = this.el?.querySelector('#analytics-hero-chart');
    if (!host) return;
    host.innerHTML = '';

    const latency = this.widgets.find(w => w.id === 'brain-latency');
    const calls = this.widgets.find(w => w.id === 'brain-calls');
    const stats = this.el.querySelector('#analytics-hero-stats');
    if (stats) {
      const n = Math.round(Number(calls?.value || 0));
      const cur = Math.round(Number(latency?.value || 0));
      stats.textContent = n ? `${n} calls · last ${cur} ms` : '';
    }

    const data = (latency?.history || []).map(Number).filter(v => Number.isFinite(v));
    if (data.length < 2) {
      host.innerHTML = '<div class="analytics-empty" style="min-height:120px">No brain calls yet — chat with Hermes and the live latency series appears here.</div>';
      return;
    }

    const width = host.clientWidth || 720;
    const height = 200;
    const m = { top: 10, right: 12, bottom: 14, left: 48 };
    const iw = width - m.left - m.right;
    const ih = height - m.top - m.bottom;

    const svg = d3.select(host).append('svg')
      .attr('viewBox', `0 0 ${width} ${height}`).attr('width', '100%').attr('height', height);

    const x = d3.scaleLinear().domain([0, data.length - 1]).range([m.left, m.left + iw]);
    const maxV = d3.max(data) || 1;
    const y = d3.scaleLinear().domain([0, maxV * 1.15]).range([m.top + ih, m.top]);

    // grid
    const yAxis = d3.axisLeft(y).ticks(4).tickSize(-iw).tickFormat(d => d >= 1000 ? `${(d / 1000).toFixed(1)}s` : `${d}ms`);
    const g = svg.append('g').attr('transform', `translate(${m.left},0)`).call(yAxis);
    g.selectAll('.tick line').attr('stroke', 'rgba(255,255,255,0.05)');
    g.selectAll('.tick text').attr('fill', '#4a5168').attr('font-size', 10);
    g.select('.domain').remove();

    const color = '#00f0ff';
    const grad = svg.append('defs').append('linearGradient').attr('id', 'grad-latency').attr('x1', '0').attr('x2', '0').attr('y1', '0').attr('y2', '1');
    grad.append('stop').attr('offset', '0%').attr('stop-color', color).attr('stop-opacity', 0.3);
    grad.append('stop').attr('offset', '100%').attr('stop-color', color).attr('stop-opacity', 0.02);
    const area = d3.area().x((d, i) => x(i)).y0(m.top + ih).y1(d => y(d)).curve(d3.curveMonotoneX);
    const line = d3.line().x((d, i) => x(i)).y(d => y(d)).curve(d3.curveMonotoneX);
    svg.append('path').datum(data).attr('d', area).attr('fill', 'url(#grad-latency)');
    svg.append('path').datum(data).attr('d', line).attr('fill', 'none').attr('stroke', color).attr('stroke-width', 2);
    svg.append('circle').attr('cx', x(data.length - 1)).attr('cy', y(data[data.length - 1])).attr('r', 3).attr('fill', color);
  }

  _renderWidgets() {
    if (!this.el) return;
    const grid = this.el.querySelector('#analytics-widget-grid');
    const count = this.el.querySelector('#analytics-widget-count');
    if (count) count.textContent = `${this.widgets.length} widget${this.widgets.length === 1 ? '' : 's'}`;
    if (!grid) return;
    grid.innerHTML = '';

    if (!this.widgets.length) {
      const chips = EXAMPLE_PROMPTS.map(p => `<button class="analytics-example" data-prompt="${p}">${p}</button>`).join('');
      grid.innerHTML = `
        <div class="analytics-empty analytics-empty--rich">
          <div class="analytics-empty-title">No widgets yet</div>
          <div class="analytics-empty-sub">Ask Hermes to create your first live metric:</div>
          <div class="analytics-example-row">${chips}</div>
        </div>`;
      grid.querySelectorAll('.analytics-example').forEach(b =>
        b.addEventListener('click', () => this._ask(b.dataset.prompt)));
      return;
    }

    this.widgets.forEach((widget) => {
      const trend = Number(widget.trend || 0);
      const trendClass = trend >= 0 ? 'is-up' : 'is-down';
      const changed = this._prevValues[widget.id] !== undefined && this._prevValues[widget.id] !== widget.value;
      const card = document.createElement('div');
      card.className = `analytics-widget-card${changed ? ' is-flash' : ''}`;
      card.style.setProperty('--widget-color', widget.color || '#00f0ff');
      card.innerHTML = `
        <button class="analytics-widget-remove" title="Remove widget" data-id="${widget.id}">×</button>
        <div class="analytics-widget-top">
          <div class="analytics-widget-kind">${widget.kind || 'metric'}</div>
          <div class="analytics-widget-trend ${trendClass}">${trend >= 0 ? '▲' : '▼'} ${Math.abs(trend).toFixed(1)}%</div>
        </div>
        <div class="analytics-widget-label">${this._escape(widget.label)}</div>
        <div class="analytics-widget-value">${this._formatValue(widget)}</div>
        <div class="analytics-widget-sparkline"></div>
        <div class="analytics-widget-footer">
          <span>${this._escape(widget.source || 'manual')}</span>
          <span>${this._formatUpdated(widget.updated_at || widget.created_at)}</span>
        </div>
      `;
      grid.appendChild(card);
      this._renderSparkline(card.querySelector('.analytics-widget-sparkline'), widget.history || [], widget.color || '#00f0ff');
      card.querySelector('.analytics-widget-remove').addEventListener('click', () => this._remove(widget.id));
    });
  }

  async _remove(id) {
    try { await deleteAnalyticsWidget(id); } catch { /* ws refresh */ }
    this.widgets = this.widgets.filter(w => w.id !== id);
    this._renderWidgets();
  }

  _renderSparkline(container, values, color) {
    if (!container) return;
    const data = Array.isArray(values) && values.length ? values.map(Number) : [0, 1, 0];
    const width = 200, height = 44, margin = { top: 6, right: 8, bottom: 8, left: 8 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    const min = d3.min(data) ?? 0, max = d3.max(data) ?? 1;
    const domain = min === max ? [min - 1, max + 1] : [min, max];
    const x = d3.scaleLinear().domain([0, data.length - 1]).range([margin.left, innerW + margin.left]);
    const y = d3.scaleLinear().domain(domain).range([innerH + margin.top, margin.top]);
    const svg = d3.select(container).append('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'none');
    const gid = `spark-${Math.random().toString(16).slice(2)}`;
    const grad = svg.append('defs').append('linearGradient').attr('id', gid).attr('x1', '0%').attr('x2', '0%').attr('y1', '0%').attr('y2', '100%');
    grad.append('stop').attr('offset', '0%').attr('stop-color', color).attr('stop-opacity', 0.28);
    grad.append('stop').attr('offset', '100%').attr('stop-color', color).attr('stop-opacity', 0.02);
    const line = d3.line().x((d, i) => x(i)).y(d => y(d)).curve(d3.curveMonotoneX);
    const area = d3.area().x((d, i) => x(i)).y0(innerH + margin.top).y1(d => y(d)).curve(d3.curveMonotoneX);
    svg.append('path').datum(data).attr('d', area).attr('fill', `url(#${gid})`);
    svg.append('path').datum(data).attr('d', line).attr('fill', 'none').attr('stroke', color).attr('stroke-width', 2).attr('stroke-linecap', 'round');
    svg.append('circle').attr('cx', x(data.length - 1)).attr('cy', y(data[data.length - 1])).attr('r', 2.5).attr('fill', color);
  }

  _formatValue(widget) {
    const value = Number(widget.value || 0);
    const formatted = value >= 1000 ? value.toLocaleString(undefined, { maximumFractionDigits: 1 }) : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (widget.unit === '$') return `$${formatted}`;
    if (widget.unit === '%') return `${formatted}%`;
    return `${formatted}${widget.unit ? ` ${widget.unit}` : ''}`;
  }
  _formatUpdated(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return 'live';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  _escape(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  destroy() {
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = null;
  }
}

export default AnalyticsPanel;
