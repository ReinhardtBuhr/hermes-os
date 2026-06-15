/* ═══════════════════════════════════════════════════════════════════
   HERMES OS — Council Hypothesis Graph (Canvas engine)

   The same single-canvas engine that makes the Knowledge Graph buttery —
   pre-rendered glow sprites, batched link strokes, quadtree hit-testing,
   a dirty-flag RAF loop (idle = zero draw cost), zoom / pan / drag — but
   specialized for ONE research council's hypotheses:

     · size  = Elo            · color = cluster
     · dashed ring = evolved  · faded = retired
     · solid edge = lineage   · faint edge = a tournament match
     · lineage tracing lights a hypothesis's whole family

   It is exclusive to the active council: feed it that council's graph and
   nothing else. Public surface: setData(), highlightLineage(), clearLineage(),
   resize(), destroy(), plus onNodeClick / onBackgroundClick callbacks.
   ═══════════════════════════════════════════════════════════════════ */

import * as d3 from 'd3';

const TAU = Math.PI * 2;
const GLOW_EXTENT = 2.6;
const HIT_RADIUS = 16;
const DEFAULT_COLOR = '#00f0ff';

export class CouncilGraph {
  constructor(host, { onNodeClick = () => {}, onBackgroundClick = () => {} } = {}) {
    this.host = host;
    this.onNodeClick = onNodeClick;
    this.onBackgroundClick = onBackgroundClick;

    this.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    this.width = host.clientWidth || 520;
    this.height = 380;

    this.nodes = [];
    this.links = [];
    this.nodeById = new Map();
    this.adjacency = new Map();
    this.lineage = { up: new Map(), down: new Map() }; // child→parent, parent→[children]
    this.linkGroups = [];

    this.simulation = null;
    this.quadtree = null;
    this.transform = d3.zoomIdentity;
    this.zoom = null;

    this.sprites = new Map();   // color key → glow sprite canvas
    this.hovered = null;
    this.lineageSet = null;     // Set<slug> when tracing, else null
    this.pulses = [];

    this._dirty = true;
    this._simActive = false;
    this._raf = null;
    this._running = false;
    this._qtCountdown = 0;
    this._lastTs = 0;
    this._ro = null;
    this._resizeHandler = null;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'council-graph-canvas';
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this._sizeCanvas();
    this._createControls();
    this._bindPointer();

    this._resizeHandler = () => this.resize();
    window.addEventListener('resize', this._resizeHandler);
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(host);
    }

    this._running = true;
    this._raf = requestAnimationFrame((ts) => this._frame(ts));
  }

  // ── Data ───────────────────────────────────────────────────────

  setData({ nodes = [], edges = [] } = {}) {
    // Fast path: same nodes + same edges → only Elo / cluster / status moved.
    // Refresh the visuals on the existing node objects (so the force layout
    // keeps its positions) and repaint once — never re-heat the simulation.
    // This is what keeps the graph calm while a tournament churns Elo.
    const incomingIds = nodes.map(n => n.id);
    const edgeKey = edges.map(e => `${e.source}>${e.target}:${e.kind || 'match'}`).sort().join(',');
    const sameTopology = this.simulation
      && this.nodes.length === nodes.length
      && incomingIds.every(id => this.nodeById.has(id))
      && edgeKey === this._edgeKey;
    if (sameTopology) {
      for (const n of nodes) {
        const node = this.nodeById.get(n.id);
        if (!node) continue;
        Object.assign(node, n);
        node.elo = Number(n.elo) || 1200;
        node.radius = Math.max(6, Math.min(20, 6 + (node.elo - 1170) / 9));
        node.color = n.cluster ? `hsl(${clusterHue(n.cluster)}, 85%, 62%)` : DEFAULT_COLOR;
      }
      this._ensureSprites();
      this._dirty = true;
      return;
    }
    this._edgeKey = edgeKey;

    const prev = this.nodeById;
    this.nodes = nodes.map(n => {
      const old = prev?.get(n.id);
      return {
        ...n,
        elo: Number(n.elo) || 1200,
        radius: Math.max(6, Math.min(20, 6 + ((Number(n.elo) || 1200) - 1170) / 9)),
        color: n.cluster ? `hsl(${clusterHue(n.cluster)}, 85%, 62%)` : DEFAULT_COLOR,
        x: old?.x ?? this.width / 2 + (Math.random() - 0.5) * 140,
        y: old?.y ?? this.height / 2 + (Math.random() - 0.5) * 140,
        vx: old?.vx ?? 0,
        vy: old?.vy ?? 0,
      };
    });
    this.nodeById = new Map(this.nodes.map(n => [n.id, n]));

    const ids = new Set(this.nodes.map(n => n.id));
    this.links = edges
      .filter(e => ids.has(e.source) && ids.has(e.target))
      .map(e => ({ ...e }));

    // Adjacency + lineage maps.
    this.adjacency = new Map();
    this.lineage = { up: new Map(), down: new Map() };
    const bump = (id, other) => {
      if (!this.adjacency.has(id)) this.adjacency.set(id, new Set());
      this.adjacency.get(id).add(other);
    };
    for (const l of this.links) {
      bump(l.source, l.target);
      bump(l.target, l.source);
      if (l.kind === 'lineage') {
        this.lineage.up.set(l.target, l.source);
        if (!this.lineage.down.has(l.source)) this.lineage.down.set(l.source, []);
        this.lineage.down.get(l.source).push(l.target);
      }
    }

    // One stroke per edge kind.
    const buckets = new Map();
    for (const l of this.links) {
      const key = l.kind || 'match';
      if (!buckets.has(key)) buckets.set(key, { kind: key, links: [] });
      buckets.get(key).links.push(l);
    }
    this.linkGroups = [...buckets.values()];

    this._ensureSprites();
    this._buildSimulation();
    if (this.lineageSet) this._recomputeLineage();
    this._dirty = true;
  }

  _ensureSprites() {
    const need = new Set([DEFAULT_COLOR]);
    for (const n of this.nodes) need.add(n.color);
    for (const color of need) {
      if (!this.sprites.has(color)) this.sprites.set(color, makeGlowSprite(color));
    }
  }

  _buildSimulation() {
    if (this.simulation) this.simulation.stop();
    this.simulation = d3.forceSimulation(this.nodes)
      .force('link', d3.forceLink(this.links).id(d => d.id)
        .distance(l => (l.kind === 'lineage' ? 50 : 96))
        .strength(l => (l.kind === 'lineage' ? 0.75 : 0.05)))
      .force('charge', d3.forceManyBody().strength(-150).distanceMax(360))
      .force('center', d3.forceCenter(this.width / 2, this.height / 2))
      .force('collide', d3.forceCollide().radius(d => d.radius + 6))
      .force('x', d3.forceX(this.width / 2).strength(0.04))
      .force('y', d3.forceY(this.height / 2).strength(0.04))
      .alphaDecay(0.03)
      .stop();
    // Pre-settle so the user never watches a swirl.
    this.simulation.tick(40);
    this._simActive = true;
    this._heat(0.45);
    this._rebuildQuadtree();
  }

  _rebuildQuadtree() {
    this.quadtree = d3.quadtree(this.nodes, d => d.x, d => d.y);
  }

  _heat(alpha = 0.4) {
    if (!this.simulation) return;
    this.simulation.alpha(Math.max(this.simulation.alpha(), alpha));
    this._simActive = true;
  }

  // ── Lineage tracing ────────────────────────────────────────────

  highlightLineage(slug) {
    this.lineageSet = new Set([slug]);
    this._recomputeLineage(slug);
    this._dirty = true;
  }

  _recomputeLineage(seed) {
    const slug = seed || [...(this.lineageSet || [])][0];
    if (!slug) return;
    const family = new Set([slug]);
    let cursor = slug;
    while (this.lineage.up.has(cursor)) { cursor = this.lineage.up.get(cursor); family.add(cursor); }
    const queue = [slug];
    while (queue.length) {
      for (const c of (this.lineage.down.get(queue.shift()) || [])) {
        if (!family.has(c)) { family.add(c); queue.push(c); }
      }
    }
    this.lineageSet = family;
  }

  clearLineage() {
    this.lineageSet = null;
    this._dirty = true;
  }

  // ── Pointer ────────────────────────────────────────────────────

  _bindPointer() {
    const sel = d3.select(this.canvas);
    const findAt = (sx, sy) => {
      const [wx, wy] = this.transform.invert([sx, sy]);
      return this._findNode(wx, wy, HIT_RADIUS / this.transform.k);
    };

    const drag = d3.drag()
      .subject((event) => findAt(event.x, event.y))
      .on('start', (event) => {
        if (!event.subject) return;
        if (!event.active) this._heat(0.3);
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
      })
      .on('drag', (event) => {
        if (!event.subject) return;
        const [wx, wy] = this.transform.invert([event.x, event.y]);
        event.subject.fx = wx;
        event.subject.fy = wy;
        this._dirty = true;
      })
      .on('end', (event) => {
        if (!event.subject) return;
        event.subject.fx = null;
        event.subject.fy = null;
        this._rebuildQuadtree();
      });

    this.zoom = d3.zoom()
      .scaleExtent([0.15, 6])
      .filter((event) => {
        if (event.type === 'wheel' || event.type === 'dblclick') return true;
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
      if (this.hovered) { this.hovered = null; this.canvas.style.cursor = 'grab'; this._dirty = true; }
    });
    sel.on('click.pick', (event) => {
      if (event.defaultPrevented) return; // a drag, not a click
      const [sx, sy] = d3.pointer(event, this.canvas);
      const hit = findAt(sx, sy);
      if (hit) {
        const hostX = hit.x * this.transform.k + this.transform.x;
        const hostY = hit.y * this.transform.k + this.transform.y;
        this.pulses.push({ node: hit, start: performance.now(), dur: 900 });
        this.onNodeClick(hit, hostX, hostY);
      } else {
        this.onBackgroundClick();
      }
    });
  }

  _findNode(wx, wy, radius) {
    if (!this.quadtree) return null;
    const found = this.quadtree.find(wx, wy, radius + 20);
    if (!found) return null;
    return Math.hypot(found.x - wx, found.y - wy) <= Math.max(found.radius + 6, radius) ? found : null;
  }

  // ── Frame loop ─────────────────────────────────────────────────

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
        this._rebuildQuadtree();
        this._qtCountdown = 7;
      }
      need = true;
    }
    if (this.pulses.length) {
      this.pulses = this.pulses.filter(p => ts - p.start < p.dur);
      need = true;
    }
    if (need) { this._draw(ts); this._dirty = false; }
    this._raf = requestAnimationFrame((t) => this._frame(t));
  }

  _inView(x, y, pad) {
    const t = this.transform;
    const sx = x * t.k + t.x;
    const sy = y * t.k + t.y;
    const p = pad * t.k;
    return sx >= -p && sx <= this.width + p && sy >= -p && sy <= this.height + p;
  }

  _draw(ts) {
    const ctx = this.ctx;
    const t = this.transform;
    const k = t.k;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.setTransform(this.dpr * k, 0, 0, this.dpr * k, this.dpr * t.x, this.dpr * t.y);

    const hovered = this.hovered;
    const neighbors = hovered ? (this.adjacency.get(hovered.id) || new Set()) : null;
    const lineageSet = this.lineageSet;
    const isLit = (id) => {
      if (lineageSet) return lineageSet.has(id);
      if (hovered) return id === hovered.id || neighbors.has(id);
      return true;
    };

    // ---- LINKS ----
    ctx.lineCap = 'round';
    for (const group of this.linkGroups) {
      const lineage = group.kind === 'lineage';
      ctx.beginPath();
      for (const l of group.links) {
        const s = l.source, e = l.target;
        if (s.x == null || e.x == null) continue;
        const lit = lineageSet
          ? (lineageSet.has(s.id) && lineageSet.has(e.id))
          : (!hovered || s.id === hovered.id || e.id === hovered.id);
        if (!lit && (lineageSet || hovered)) continue; // dim links drawn in the faint pass below
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(e.x, e.y);
      }
      ctx.strokeStyle = lineage ? 'rgba(255,255,255,0.55)' : 'rgba(0,240,255,0.5)';
      ctx.globalAlpha = lineage ? 0.7 : 0.4;
      ctx.lineWidth = (lineage ? 1.7 : 1.1) / Math.sqrt(k);
      if (lineage) ctx.setLineDash([]); else ctx.setLineDash([]);
      ctx.stroke();
    }
    // Faint pass: the un-lit links, barely visible, so structure persists.
    if (hovered || lineageSet) {
      ctx.beginPath();
      for (const l of this.links) {
        const s = l.source, e = l.target;
        if (s.x == null || e.x == null) continue;
        const lit = lineageSet
          ? (lineageSet.has(s.id) && lineageSet.has(e.id))
          : (s.id === hovered.id || e.id === hovered.id);
        if (lit) continue;
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(e.x, e.y);
      }
      ctx.strokeStyle = 'rgba(140,150,180,0.5)';
      ctx.globalAlpha = 0.07;
      ctx.lineWidth = 0.8 / Math.sqrt(k);
      ctx.stroke();
    }

    // ---- NODES ----
    const drawGlow = k > 0.25;
    for (const n of this.nodes) {
      if (!this._inView(n.x, n.y, n.radius * GLOW_EXTENT)) continue;
      const retired = n.status && n.status !== 'active';
      const lit = isLit(n.id);
      const dim = (!lit) || (retired && !hovered && !lineageSet);

      if (drawGlow && lit && !retired) {
        const sprite = this.sprites.get(n.color) || this.sprites.get(DEFAULT_COLOR);
        const r = n.radius * GLOW_EXTENT * (n === hovered ? 1.3 : 1);
        ctx.globalAlpha = n === hovered ? 0.95 : 0.5;
        ctx.drawImage(sprite, n.x - r, n.y - r, r * 2, r * 2);
      }

      // Body.
      ctx.globalAlpha = dim ? 0.12 : (retired ? 0.4 : 0.92);
      ctx.fillStyle = retired ? 'rgba(150,150,170,0.9)' : n.color;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius * (n === hovered ? 1.18 : 1), 0, TAU);
      ctx.fill();

      // Evolution: dashed white ring.
      if (n.origin === 'evolution' && !dim) {
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.4 / Math.sqrt(k);
        ctx.setLineDash([3 / Math.sqrt(k), 2 / Math.sqrt(k)]);
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius + 2.5, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // Bright core highlight.
      if (!dim && !retired && k > 0.5) {
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius * 0.32, 0, TAU);
        ctx.fill();
      }
    }

    // ---- PULSES (click feedback) ----
    for (const p of this.pulses) {
      const prog = (ts - p.start) / p.dur;
      if (prog < 0 || prog > 1 || p.node.x == null) continue;
      ctx.globalAlpha = (1 - prog) * 0.8;
      ctx.strokeStyle = p.node.color || DEFAULT_COLOR;
      ctx.lineWidth = 2 / k;
      ctx.beginPath();
      ctx.arc(p.node.x, p.node.y, p.node.radius + prog * 24, 0, TAU);
      ctx.stroke();
    }

    // ---- LABELS (top hypotheses + hovered) ----
    ctx.globalAlpha = 1;
    if (k > 0.32) {
      ctx.font = '600 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(210,220,240,0.85)';
      const ranked = [...this.nodes].sort((a, b) => b.elo - a.elo).slice(0, k > 1.3 ? 16 : 8);
      for (const n of ranked) {
        if (n === hovered) continue;
        if (!isLit(n.id)) continue;
        if (!this._inView(n.x, n.y, 40)) continue;
        ctx.fillText(n.id, n.x, n.y - n.radius - 5);
      }
    }
    if (hovered && hovered.x != null) {
      ctx.font = `700 ${Math.max(10, 11 / Math.sqrt(k))}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#eaf2ff';
      ctx.fillText(`${hovered.id} · ${Math.round(hovered.elo)}`, hovered.x, hovered.y - hovered.radius - 6);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }

  // ── Controls + lifecycle ───────────────────────────────────────

  _createControls() {
    const controls = document.createElement('div');
    controls.className = 'council-graph-controls';
    controls.innerHTML = `
      <button data-action="zoom-in" title="Zoom in">+</button>
      <button data-action="zoom-out" title="Zoom out">−</button>
      <button data-action="reset" title="Reset view">⟲</button>
    `;
    this.host.appendChild(controls);
    const sel = d3.select(this.canvas);
    controls.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'zoom-in') sel.transition().duration(280).call(this.zoom.scaleBy, 1.4);
      else if (action === 'zoom-out') sel.transition().duration(280).call(this.zoom.scaleBy, 0.7);
      else if (action === 'reset') sel.transition().duration(440).call(this.zoom.transform, d3.zoomIdentity);
    });
  }

  _sizeCanvas() {
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
  }

  resize() {
    if (!this.host) return;
    const w = this.host.clientWidth || this.width;
    if (w === this.width) return;
    this.width = w;
    this._sizeCanvas();
    if (this.simulation) {
      this.simulation.force('center', d3.forceCenter(this.width / 2, this.height / 2));
      this.simulation.force('x', d3.forceX(this.width / 2).strength(0.04));
      this._heat(0.25);
    }
    this._dirty = true;
  }

  destroy() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this.simulation) this.simulation.stop();
    if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
    if (this._ro) this._ro.disconnect();
    if (this.canvas?.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.host?.querySelector('.council-graph-controls')?.remove();
    this.canvas = null;
    this.ctx = null;
    this.simulation = null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function makeGlowSprite(color) {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, toRgba(color, 0.55));
  g.addColorStop(0.35, toRgba(color, 0.2));
  g.addColorStop(1, toRgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

/** Accepts #hex or hsl(...) and returns an rgba() at the given alpha. */
function toRgba(color, a) {
  if (color.startsWith('#')) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  // hsl(h, s%, l%) → hsla(h, s%, l%, a)
  return color.replace(/^hsl\(/, 'hsla(').replace(/\)$/, `, ${a})`);
}

function clusterHue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

export default CouncilGraph;
