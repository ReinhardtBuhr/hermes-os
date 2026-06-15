/* ═══════════════════════════════════════════════════════════════════
   HERMES OS — Knowledge Graph (Canvas engine)

   The old renderer was SVG: every node carried a feGaussianBlur glow
   filter and every simulation tick repainted thousands of filtered DOM
   elements — that is why the graph lagged at scale, no matter the tuning.

   This engine draws the whole graph on a single <canvas>:
     · glow = pre-rendered radial-gradient sprites (one drawImage each)
     · links = one batched path per color bucket
     · labels = importance-ranked, zoom-culled
     · hit-testing = d3.quadtree (hover / click / drag at any size)
     · render loop = dirty-flag RAF — when nothing moves, nothing draws
     · viewport culling + adaptive quality tiers for huge graphs
   Public API is unchanged: Dashboard and the Knowledge Graph view both
   get the new engine for free.
   ═══════════════════════════════════════════════════════════════════ */

import * as d3 from 'd3';
import { getGraphData } from '../utils/api.js';

const NODE_COLORS = {
  system: '#00f0ff',
  module: '#7b2fff',
  file: '#3b82f6',
  analytics: '#00ff88',
  concept: '#ff9f1c',
  default: '#8b92a5'
};

const NODE_COLOR_NAMES = {
  system: 'System',
  module: 'Module',
  file: 'File',
  analytics: 'Analytics',
  concept: 'Concept'
};

const TAU = Math.PI * 2;
const GLOW_EXTENT = 2.7;          // glow sprite radius ÷ node radius
const HIT_RADIUS = 14;            // screen px around cursor for hit tests

export class GraphView {
  constructor(container) {
    this.container = container;
    this.el = null;
    this.canvas = null;
    this.ctx = null;
    this.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    this.width = 0;
    this.height = 0;

    this.nodes = [];
    this.links = [];
    this.nodeById = new Map();
    this.adjacency = new Map();    // id → Set of neighbor ids
    this.linkGroups = [];          // [{color, width, links[]}] for batched strokes
    this.labelRanked = [];         // nodes sorted by importance (for label budget)

    this.simulation = null;
    this.quadtree = null;
    this.transform = d3.zoomIdentity;
    this.zoom = null;

    this.sprites = new Map();      // type → glow sprite canvas
    this.fills = new Map();        // type → fill color cache

    this.hovered = null;
    this.pulses = [];              // [{node, start, dur}]
    this.particles = [];           // [{link, t, dur, wait}]
    this.quality = { glow: true, particles: 0, labels: 80, core: true };

    this._dirty = true;
    this._simActive = false;
    this._raf = null;
    this._running = false;
    this._qtCountdown = 0;
    this._lastTs = 0;
    this._fpsFrames = 0;
    this._fpsStamp = 0;
    this._fpsText = '';

    this.tooltip = null;
    this._resizeHandler = null;
    this._ro = null;
  }

  async init() {
    try {
      const data = await getGraphData();
      this.render(data);
    } catch (e) {
      this.render({ nodes: [], edges: [] });
    }
  }

  // ── Setup ──────────────────────────────────────────────────────

  render(data) {
    this.el = document.createElement('div');
    this.el.className = 'graph-view';
    this.el.style.position = 'relative';
    this.el.style.width = '100%';
    this.el.style.minHeight = '500px';
    this.container.appendChild(this.el);

    this.width = this.el.clientWidth || 900;
    this.height = Math.max(this.el.clientHeight, 500);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'graph-canvas';
    this.el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this._sizeCanvas();

    for (const [type, color] of Object.entries(NODE_COLORS)) {
      this.sprites.set(type, makeGlowSprite(color));
      this.fills.set(type, color);
    }

    this._setData(data);
    this._buildSimulation();
    this._bindPointer();

    this._createControls();
    this._createLegend();
    this._createStatsOverlay();
    this._createTraceOverlay();
    this._createTooltip();

    this._resizeHandler = () => this.resize();
    window.addEventListener('resize', this._resizeHandler);
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this.el);
    }

    this._running = true;
    this._raf = requestAnimationFrame((ts) => this._frame(ts));
  }

  _sizeCanvas() {
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
  }

  /** Parse + index the dataset; precompute everything the draw loop needs. */
  _setData(data) {
    const prev = this.nodeById;
    this.nodes = (data?.nodes || []).map(n => {
      const old = prev?.get(n.id);
      return {
        ...n,
        x: old?.x ?? this.width / 2 + (Math.random() - 0.5) * 120,
        y: old?.y ?? this.height / 2 + (Math.random() - 0.5) * 120,
        vx: old?.vx ?? 0,
        vy: old?.vy ?? 0,
      };
    });
    this.nodeById = new Map(this.nodes.map(n => [n.id, n]));
    this.links = (data?.edges || data?.links || [])
      .map(l => ({ ...l, source: l.source_id || l.source, target: l.target_id || l.target }))
      .filter(l => {
        const s = typeof l.source === 'object' ? l.source.id : l.source;
        const t = typeof l.target === 'object' ? l.target.id : l.target;
        return this.nodeById.has(s) && this.nodeById.has(t);
      });

    // Degrees, radii, adjacency.
    const degree = new Map();
    this.adjacency = new Map();
    const bump = (id, other) => {
      degree.set(id, (degree.get(id) || 0) + 1);
      if (!this.adjacency.has(id)) this.adjacency.set(id, new Set());
      this.adjacency.get(id).add(other);
    };
    for (const l of this.links) {
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      bump(s, t);
      bump(t, s);
    }
    const maxDegree = Math.max(1, ...degree.values());
    const radiusScale = d3.scaleSqrt().domain([1, maxDegree]).range([5, 22]).clamp(true);
    for (const n of this.nodes) {
      n.degree = degree.get(n.id) || 1;
      n.radius = radiusScale(n.degree);
    }

    // Label budget: most-connected first.
    this.labelRanked = [...this.nodes].sort((a, b) => b.degree - a.degree);

    // Link color buckets → one stroke call per bucket instead of per link.
    const buckets = new Map();
    for (const l of this.links) {
      const sId = typeof l.source === 'object' ? l.source.id : l.source;
      const type = this.nodeById.get(sId)?.type || 'default';
      const color = NODE_COLORS[type] || NODE_COLORS.default;
      const width = (l.weight || 1) >= 1.5 ? 1.6 : 0.9;
      const key = `${color}|${width}`;
      if (!buckets.has(key)) buckets.set(key, { color, width, links: [] });
      buckets.get(key).links.push(l);
    }
    this.linkGroups = [...buckets.values()];

    this._computeQuality();
    this._seedParticles();
    this._updateStatsOverlay();
    this._dirty = true;
  }

  /** Adaptive tiers: the graph stays smooth no matter how big it grows. */
  _computeQuality() {
    const n = this.nodes.length;
    if (n > 1400) {
      this.quality = { glow: false, particles: 0, labels: 24, core: false };
    } else if (n > 700) {
      this.quality = { glow: true, particles: 0, labels: 46, core: false };
    } else {
      this.quality = { glow: true, particles: Math.min(42, Math.round(this.links.length * 0.3)), labels: 80, core: true };
    }
  }

  _buildSimulation() {
    if (this.simulation) this.simulation.stop();
    this.simulation = d3.forceSimulation(this.nodes)
      .force('link', d3.forceLink(this.links).id(d => d.id)
        .distance(l => 60 + (1 - (l.weight || 0.5)) * 60))
      .force('charge', d3.forceManyBody().strength(-150).distanceMax(320))
      .force('center', d3.forceCenter(this.width / 2, this.height / 2))
      .force('collision', d3.forceCollide().radius(d => d.radius + 5))
      .force('x', d3.forceX(this.width / 2).strength(0.03))
      .force('y', d3.forceY(this.height / 2).strength(0.03))
      .alphaDecay(0.028)
      .stop();                       // we drive ticks inside the RAF loop

    // Big graphs: settle most of the layout synchronously so the user
    // never watches a thousand nodes swirl.
    if (this.nodes.length > 900) this.simulation.tick(70);

    this._simActive = true;
    this._rebuildQuadtree();
  }

  _rebuildQuadtree() {
    this.quadtree = d3.quadtree(this.nodes, d => d.x, d => d.y);
  }

  // ── Pointer: zoom / pan / drag / hover / click ─────────────────

  _bindPointer() {
    const sel = d3.select(this.canvas);

    const findAt = (sx, sy) => {
      const [wx, wy] = this.transform.invert([sx, sy]);
      return this._findNode(wx, wy, HIT_RADIUS / this.transform.k);
    };

    // Drag (registered first; if no node under cursor it never starts
    // and the gesture falls through to zoom's pan).
    const drag = d3.drag()
      .subject((event) => findAt(event.x, event.y))
      .on('start', (event) => {
        if (!event.active) this._heat(0.3);
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
      })
      .on('drag', (event) => {
        const [wx, wy] = this.transform.invert([event.x, event.y]);
        event.subject.fx = wx;
        event.subject.fy = wy;
        this._dirty = true;
      })
      .on('end', (event) => {
        event.subject.fx = null;
        event.subject.fy = null;
        this._rebuildQuadtree();
      });

    this.zoom = d3.zoom()
      .scaleExtent([0.08, 6])
      .filter((event) => {
        if (event.type === 'wheel' || event.type === 'dblclick') return true;
        // Pan only from empty space — node hits belong to drag.
        const [sx, sy] = d3.pointer(event, this.canvas);
        return !findAt(sx, sy);
      })
      .on('zoom', (event) => {
        this.transform = event.transform;
        this._dirty = true;
      });

    sel.call(drag).call(this.zoom);

    sel.on('mousemove.hover', (event) => {
      const [sx, sy] = d3.pointer(event, this.canvas);
      const hit = findAt(sx, sy) || null;
      if (hit !== this.hovered) {
        this.hovered = hit;
        this.canvas.style.cursor = hit ? 'pointer' : 'grab';
        this._dirty = true;
      }
    });

    sel.on('mouseleave.hover', () => {
      if (this.hovered) {
        this.hovered = null;
        this.canvas.style.cursor = 'grab';
        this._dirty = true;
      }
    });

    sel.on('click.tooltip', (event) => {
      if (event.defaultPrevented) return; // drag, not click
      const [sx, sy] = d3.pointer(event, this.canvas);
      const hit = findAt(sx, sy);
      if (hit) this._showTooltip(event, hit);
      else this._hideTooltip();
    });
  }

  _findNode(wx, wy, radius) {
    if (!this.quadtree) return null;
    const found = this.quadtree.find(wx, wy, radius + 18);
    if (!found) return null;
    const dx = found.x - wx, dy = found.y - wy;
    return Math.hypot(dx, dy) <= Math.max(found.radius + 4, radius) ? found : null;
  }

  /** Reheat the simulation (it cools itself back down automatically). */
  _heat(alpha = 0.5) {
    if (!this.simulation) return;
    this.simulation.alpha(Math.max(this.simulation.alpha(), alpha));
    this._simActive = true;
  }

  // ── The frame loop: draws only when something changed ──────────

  _frame(ts) {
    if (!this._running) return;
    const dt = this._lastTs ? Math.min(64, ts - this._lastTs) : 16;
    this._lastTs = ts;

    let need = this._dirty;

    if (this._simActive && this.simulation) {
      this.simulation.tick();
      if (this.simulation.alpha() < this.simulation.alphaMin()) {
        this._simActive = false;
        this._rebuildQuadtree();
      } else if (--this._qtCountdown <= 0) {
        this._rebuildQuadtree();      // keep hover accurate while moving
        this._qtCountdown = 7;
      }
      need = true;
    }

    if (this.particles.length) {
      this._advanceParticles(dt);
      need = true;
    }

    if (this.pulses.length) {
      this.pulses = this.pulses.filter(p => ts - p.start < p.dur);
      need = true;
    }

    if (need) {
      this._draw(ts);
      this._dirty = false;
      this._fpsFrames += 1;
    }

    // A once-a-second honesty meter: real fps while animating, "idle ⚡"
    // (zero draw cost) when the graph is at rest.
    if (ts - this._fpsStamp > 1000) {
      const txt = this._fpsFrames > 0 ? `${this._fpsFrames} fps` : 'idle ⚡';
      if (txt !== this._fpsText) {
        this._fpsText = txt;
        this._updateStatsOverlay();
      }
      this._fpsFrames = 0;
      this._fpsStamp = ts;
    }

    this._raf = requestAnimationFrame((t) => this._frame(t));
  }

  _inView(x, y, pad) {
    const t = this.transform;
    const sx = x * t.k + t.x;
    const sy = y * t.k + t.y;
    const p = pad * t.k;
    return sx >= -p && sx <= this.width + p && sy >= -p && sy <= this.height + p;
  }

  _draw(ts = performance.now()) {
    const ctx = this.ctx;
    const t = this.transform;
    const k = t.k;
    const q = this.quality;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.setTransform(this.dpr * k, 0, 0, this.dpr * k, this.dpr * t.x, this.dpr * t.y);

    const hovered = this.hovered;
    const neighbors = hovered ? (this.adjacency.get(hovered.id) || new Set()) : null;

    // ---- LINKS (batched) ----
    ctx.lineCap = 'round';
    for (const group of this.linkGroups) {
      ctx.beginPath();
      for (const l of group.links) {
        const s = l.source, e = l.target;
        if (s.x == null || e.x == null) continue;
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(e.x, e.y);
      }
      ctx.strokeStyle = group.color;
      ctx.globalAlpha = hovered ? 0.05 : 0.16;
      ctx.lineWidth = group.width / Math.sqrt(k);
      ctx.stroke();
    }

    // Hover: re-stroke the connected links bright.
    if (hovered) {
      ctx.beginPath();
      for (const l of this.links) {
        const s = l.source, e = l.target;
        if (s.id !== hovered.id && e.id !== hovered.id) continue;
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(e.x, e.y);
      }
      ctx.strokeStyle = this.fills.get(hovered.type) || NODE_COLORS.default;
      ctx.globalAlpha = 0.65;
      ctx.lineWidth = 1.4 / Math.sqrt(k);
      ctx.stroke();
    }

    // ---- PARTICLES ----
    if (this.particles.length) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#00f0ff';
      for (const p of this.particles) {
        if (p.wait > 0) continue;
        const s = p.link.source, e = p.link.target;
        if (s.x == null || e.x == null) continue;
        const x = s.x + (e.x - s.x) * p.t;
        const y = s.y + (e.y - s.y) * p.t;
        if (!this._inView(x, y, 8)) continue;
        ctx.globalAlpha = 0.55 * (1 - p.t);
        ctx.beginPath();
        ctx.arc(x, y, 1.6 / Math.sqrt(k), 0, TAU);
        ctx.fill();
      }
    }

    // ---- NODES ----
    const drawGlow = q.glow && k > 0.22;
    for (const n of this.nodes) {
      if (!this._inView(n.x, n.y, n.radius * GLOW_EXTENT)) continue;
      const dim = hovered && n !== hovered && !neighbors.has(n.id);
      const color = this.fills.get(n.type) || NODE_COLORS.default;

      if (drawGlow && !dim) {
        const sprite = this.sprites.get(n.type) || this.sprites.get('default');
        const r = n.radius * GLOW_EXTENT * (n === hovered ? 1.25 : 1);
        ctx.globalAlpha = n === hovered ? 0.95 : 0.55;
        ctx.drawImage(sprite, n.x - r, n.y - r, r * 2, r * 2);
      }

      ctx.globalAlpha = dim ? 0.12 : 0.9;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius * (n === hovered ? 1.18 : 1), 0, TAU);
      ctx.fill();

      if (q.core && !dim && k > 0.5) {
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius * 0.34, 0, TAU);
        ctx.fill();
        ctx.fillStyle = color;
      }
    }

    // ---- PULSES (highlightNode rings) ----
    for (const p of this.pulses) {
      const prog = (ts - p.start) / p.dur;
      if (prog < 0 || prog > 1 || p.node.x == null) continue;
      ctx.globalAlpha = (1 - prog) * 0.8;
      ctx.strokeStyle = this.fills.get(p.node.type) || NODE_COLORS.default;
      ctx.lineWidth = 2 / k;
      ctx.beginPath();
      ctx.arc(p.node.x, p.node.y, p.node.radius + prog * 26, 0, TAU);
      ctx.stroke();
    }

    // ---- LABELS (importance budget + zoom culling) ----
    ctx.globalAlpha = 1;
    if (k > 0.3) {
      const budget = k > 1.4 ? q.labels * 2 : q.labels;
      ctx.font = '10px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(139, 146, 165, 0.85)';
      let drawn = 0;
      for (const n of this.labelRanked) {
        if (drawn >= budget) break;
        if (n === hovered) continue;
        if (hovered && !neighbors.has(n.id)) continue;
        if (!this._inView(n.x, n.y, 60)) continue;
        ctx.fillText(n.label || n.name || n.id, n.x, n.y + n.radius + 12);
        drawn += 1;
      }
    }
    if (hovered && hovered.x != null) {
      ctx.font = `600 ${Math.max(10, 11 / Math.sqrt(k))}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#e8ecf4';
      ctx.fillText(hovered.label || hovered.name || hovered.id, hovered.x, hovered.y + hovered.radius + 14 / Math.sqrt(k));
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }

  // ── Particles ──────────────────────────────────────────────────

  _seedParticles() {
    this.particles = [];
    const count = this.quality.particles;
    if (!count || !this.links.length) return;
    for (let i = 0; i < count; i++) {
      this.particles.push({
        link: this.links[Math.floor(Math.random() * this.links.length)],
        t: Math.random(),
        dur: 2200 + Math.random() * 2400,
        wait: Math.random() * 3000,
      });
    }
  }

  _advanceParticles(dt) {
    for (const p of this.particles) {
      if (p.wait > 0) { p.wait -= dt; continue; }
      p.t += dt / p.dur;
      if (p.t >= 1) {
        p.t = 0;
        p.wait = 600 + Math.random() * 3400;
        p.link = this.links[Math.floor(Math.random() * this.links.length)];
      }
    }
  }

  // ── Overlays (HTML, unchanged visual language) ─────────────────

  _createControls() {
    const controls = document.createElement('div');
    controls.className = 'graph-controls';
    controls.innerHTML = `
      <button class="graph-control-btn" data-action="zoom-in" title="Zoom In">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </button>
      <button class="graph-control-btn" data-action="zoom-out" title="Zoom Out">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </button>
      <button class="graph-control-btn" data-action="reset" title="Reset View">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
          <path d="M3 3v5h5"/>
        </svg>
      </button>
    `;
    this.el.appendChild(controls);

    const sel = d3.select(this.canvas);
    controls.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'zoom-in') {
        sel.transition().duration(300).call(this.zoom.scaleBy, 1.4);
      } else if (action === 'zoom-out') {
        sel.transition().duration(300).call(this.zoom.scaleBy, 0.7);
      } else if (action === 'reset') {
        sel.transition().duration(500).call(this.zoom.transform, d3.zoomIdentity);
      }
    });
  }

  _createLegend() {
    const legend = document.createElement('div');
    legend.className = 'graph-legend';
    legend.innerHTML = Object.entries(NODE_COLOR_NAMES).map(([type, name]) =>
      `<div class="legend-item">
        <span class="legend-dot" style="background:${NODE_COLORS[type]}; box-shadow: 0 0 6px ${NODE_COLORS[type]}"></span>
        <span class="legend-label">${name}</span>
      </div>`
    ).join('');
    this.el.appendChild(legend);
  }

  _createStatsOverlay() {
    const stats = document.createElement('div');
    stats.className = 'graph-stats-overlay';
    stats.id = 'graph-stats';
    this.el.appendChild(stats);
    this._updateStatsOverlay();
  }

  _createTraceOverlay() {
    const trace = document.createElement('div');
    trace.className = 'graph-trace-overlay';
    trace.id = 'graph-trace';
    trace.innerHTML = `
      <span class="graph-trace-dot"></span>
      <span class="graph-trace-text">Hermes trace idle</span>
    `;
    this.el.appendChild(trace);
  }

  _createTooltip() {
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'graph-tooltip';
    this.tooltip.style.display = 'none';
    this.el.appendChild(this.tooltip);
  }

  _showTooltip(event, d) {
    const connections = this.adjacency.get(d.id)?.size || 0;
    const color = NODE_COLORS[d.type] || NODE_COLORS.default;

    this.tooltip.innerHTML = `
      <div class="tooltip-header" style="border-left: 3px solid ${color}; padding-left: 10px;">
        <div class="tooltip-name">${escapeHtml(d.label || d.name || d.id)}</div>
        <div class="tooltip-type" style="color: ${color}">${escapeHtml((d.type || 'unknown').toUpperCase())}</div>
      </div>
      <div class="tooltip-body">
        <div class="tooltip-stat"><span class="tooltip-stat-label">Connections</span><span class="tooltip-stat-value">${connections}</span></div>
        <div class="tooltip-stat"><span class="tooltip-stat-label">Degree</span><span class="tooltip-stat-value">${d.degree || 0}</span></div>
        ${d.metadata ? `<div class="tooltip-stat"><span class="tooltip-stat-label">Info</span><span class="tooltip-stat-value">${escapeHtml(typeof d.metadata === 'string' ? d.metadata : JSON.stringify(d.metadata))}</span></div>` : ''}
      </div>
    `;

    const rect = this.el.getBoundingClientRect();
    let x = event.clientX - rect.left + 15;
    let y = event.clientY - rect.top - 10;
    if (x + 220 > this.width) x = x - 240;
    if (y + 150 > this.height) y = y - 160;

    this.tooltip.style.left = `${x}px`;
    this.tooltip.style.top = `${y}px`;
    this.tooltip.style.display = 'block';
    this.tooltip.style.opacity = '0';
    requestAnimationFrame(() => {
      this.tooltip.style.transition = 'opacity 0.2s ease';
      this.tooltip.style.opacity = '1';
    });
  }

  _hideTooltip() {
    if (this.tooltip) {
      this.tooltip.style.opacity = '0';
      setTimeout(() => {
        if (this.tooltip) this.tooltip.style.display = 'none';
      }, 200);
    }
  }

  _updateStatsOverlay() {
    const statsEl = this.el?.querySelector('#graph-stats');
    if (!statsEl) return;
    const communities = new Set(this.nodes.map(n => n.type)).size;
    statsEl.textContent =
      `Nodes: ${this.nodes.length} | Edges: ${this.links.length} | Communities: ${communities}`
      + (this._fpsText ? ` | ${this._fpsText}` : '');
  }

  // ── Public API (same surface as the old engine) ────────────────

  addNode(nodeData) {
    const newNode = {
      ...nodeData,
      x: this.width / 2 + (Math.random() - 0.5) * 100,
      y: this.height / 2 + (Math.random() - 0.5) * 100,
      degree: 1,
      radius: 8,
    };
    this.nodes.push(newNode);
    this._refreshData();
    this.highlightNode(newNode.id);
  }

  removeNode(nodeId) {
    this.nodes = this.nodes.filter(n => n.id !== nodeId);
    this.links = this.links.filter(l => {
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      return s !== nodeId && t !== nodeId;
    });
    this._refreshData();
  }

  /** Re-index in-memory nodes/links and reheat. */
  _refreshData() {
    this._setData({
      nodes: this.nodes,
      edges: this.links.map(l => ({
        ...l,
        source: typeof l.source === 'object' ? l.source.id : l.source,
        target: typeof l.target === 'object' ? l.target.id : l.target,
      })),
    });
    this.simulation.nodes(this.nodes);
    this.simulation.force('link').links(this.links);
    this._heat(0.5);
  }

  highlightNode(nodeId) {
    const node = this.nodeById.get(nodeId);
    if (!node) return;
    this.pulses.push({ node, start: performance.now(), dur: 1100 });
    this._dirty = true;
  }

  updateData(newData) {
    this._setData(newData);
    this.simulation.nodes(this.nodes);
    this.simulation.force('link').links(this.links);
    this._heat(0.5);
  }

  onGraphUpdate(data) {
    if (!this.simulation) {
      this.render(data);
      return;
    }
    this.updateData(data);
  }

  onHermesTrace(trace = {}) {
    const traceEl = this.el?.querySelector('#graph-trace');
    const textEl = traceEl?.querySelector('.graph-trace-text');
    if (textEl) {
      textEl.textContent = (trace.event || 'hermes_event').replace(/_/g, ' ');
    }
    if (traceEl) {
      traceEl.classList.remove('is-active');
      requestAnimationFrame(() => traceEl.classList.add('is-active'));
    }

    const targetLabel = trace.event?.includes('memory')
      ? 'Hermes Memory Core'
      : trace.event?.includes('model')
        ? 'Gemini 3.5 Flash Brain'
        : trace.event?.includes('dashboard') || trace.event?.includes('analytics')
          ? 'Realtime Dashboard Mutator'
          : 'Hermes Agent Core';
    const target = this.nodes.find(node => node.label === targetLabel);
    if (target) this.highlightNode(target.id);
  }

  resize() {
    if (!this.el || !this.canvas) return;
    const w = this.el.clientWidth || 900;
    const h = Math.max(this.el.clientHeight, 500);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this._sizeCanvas();
    if (this.simulation) {
      this.simulation.force('center', d3.forceCenter(this.width / 2, this.height / 2));
      this.simulation.force('x', d3.forceX(this.width / 2).strength(0.03));
      this.simulation.force('y', d3.forceY(this.height / 2).strength(0.03));
      this._heat(0.3);
    }
    this._dirty = true;
  }

  destroy() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this.simulation) this.simulation.stop();
    if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
    if (this._ro) this._ro.disconnect();
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = null;
    this.canvas = null;
    this.ctx = null;
    this.simulation = null;
  }
}

// ── Module helpers ───────────────────────────────────────────────

/** Pre-render one soft radial glow; drawImage of this replaces the SVG blur filter. */
function makeGlowSprite(color) {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, hexToRgba(color, 0.55));
  g.addColorStop(0.35, hexToRgba(color, 0.22));
  g.addColorStop(1, hexToRgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default GraphView;
