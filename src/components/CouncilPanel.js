/* ═══════════════════════════════════════════════════════════════════
   HERMES OS — Research Council Panel
   The council chamber, live: seven agent stations fire in realtime as
   the WebSocket streams their work; hypotheses battle in an Elo
   tournament judged on goal-derived criteria; every council grows its
   own force graph; and when the gavel falls, the verdict agent delivers
   a final report with a winner, standings, and next steps.
   ═══════════════════════════════════════════════════════════════════ */

import * as d3 from 'd3';
import { CouncilGraph } from './CouncilGraph.js';
import {
  startCouncil, listCouncils, getCouncilDetail, stopCouncil, resumeCouncil,
  submitCouncilEvidence, concludeCouncil, getCouncilGraph, getCouncilTree, updateCouncilAgent,
  vetoCouncilHypothesis, setCouncilPower, reviveAgents, purgeCouncilProposals,
} from '../utils/api.js';

const POWER_LABELS = {
  1: ['Eco', '~6 calls/iter · gentle on quota'],
  2: ['Standard', '~9 calls/iter · the proven pace'],
  3: ['High', '~12 calls/iter · 2 judge lanes'],
  4: ['Turbo', '~15 calls/iter · 3 judge lanes'],
  5: ['Max', '~19 calls/iter · 4 judge lanes — burns quota fast'],
};

// Brain-core lanes (hybrid mode lights both at once).
const LANE_META = {
  gemini: { name: 'GEMINI', color: '#00f0ff' },
  openrouter: { name: 'NEX · OPENROUTER', color: '#7b2fff' },
};

const INTENSITY_PRESETS = {
  relaxed: { generateCount: 2, evolveCount: 1, matchesPerIteration: 3, iterationDelayMs: 60000, proximityEvery: 3 },
  standard: {},
  intense: { generateCount: 4, evolveCount: 3, matchesPerIteration: 8, iterationDelayMs: 8000 },
};

// The chamber: every agent station, in working order around the core.
const STATIONS = [
  { role: 'supervisor', icon: '🧭', name: 'Supervisor', duty: 'plans & allocates' },
  { role: 'generation', icon: '✨', name: 'Generation', duty: 'proposes candidates' },
  { role: 'reflection', icon: '🔍', name: 'Reflection', duty: 'stress-tests' },
  { role: 'evolution',  icon: '🧬', name: 'Evolution',  duty: 'refines leaders' },
  { role: 'ranking',    icon: '⚔',  name: 'Ranking',    duty: 'judges matches' },
  { role: 'proximity',  icon: '🧲', name: 'Proximity',  duty: 'clusters & dedupes' },
  { role: 'interpret',  icon: '🧪', name: 'Interpret',  duty: 'reads evidence' },
];

// The verdict agent lives in the core (⚖) — right-click it like any station.
const CORE_AGENT = { role: 'verdict', icon: '⚖', name: 'Verdict', duty: 'closes the tournament' };

const STATION_BY_ROLE = Object.fromEntries([...STATIONS, CORE_AGENT].map(s => [s.role, s]));

// Tunable agent attributes: rendered as the colored halo around each
// station, edited via right-click → Change attributes.
const TRAITS = [
  { key: 'strictness',   label: 'Strictness',    color: '#ff3366', desc: 'Quality bar — lenient ↔ treats everything as slop until proven' },
  { key: 'creativity',   label: 'Creativity',    color: '#ff9f1c', desc: 'Style — conventional ↔ radically inventive' },
  { key: 'skepticism',   label: 'Skepticism',    color: '#7b2fff', desc: 'Trust — face value ↔ hunts the fatal flaw in every claim' },
  { key: 'thoroughness', label: 'Thoroughness',  color: '#00f0ff', desc: 'Depth — quick headlines ↔ exhaustive analysis' },
  { key: 'riskAppetite', label: 'Risk appetite', color: '#00ff88', desc: 'Bets — safe ground ↔ moonshots' },
];

const ROLE_ICONS = {
  system: '⚙', supervisor: '🧭', generation: '✨', reflection: '🔍', ranking: '⚔',
  proximity: '🧲', evolution: '🧬', interpret: '🧪', criteria: '🎯', verdict: '🏛',
  meta: '📚', falsify: '🔬', debate: '🗣',
};

const STATUS_LABELS = {
  running: ['council in session', 'live'],
  quota_paused: ['quota — auto-resume armed', 'warn'],
  stopped: ['adjourned', ''],
  concluded: ['verdict delivered', 'ok'],
  failed: ['failed', 'bad'],
};

export class CouncilPanel {
  constructor(container) {
    this.container = container;
    this.el = null;
    this.councilId = null;
    this.detail = null;
    this.expanded = new Set();
    this._prints = {};            // section fingerprints — repaint only on change
    this._pollTimer = null;
    this._tickTimer = null;
    this._refreshQueued = false;
    this._stationTimers = {};
    this._sim = null;
    this._graphCounts = '';

    // Agent minds + traits (live)
    this.agents = new Map();      // role → {traits, directive, mind, …}
    this._menuEl = null;          // right-click context menu
    this._drawerEl = null;        // attribute editor / mind viewer
    this._drawerRole = null;
    this._drawerTab = 'attributes';
    this._traitDebounce = null;
    this._docClick = null;        // document-level dismiss handler

    // Hypothesis-graph (smooth canvas engine, exclusive to this council)
    this._graph = null;           // CouncilGraph instance
    this._graphData = null;
    this._lineageOf = null;       // slug whose lineage is highlighted
    this._popoverEl = null;

    // Operator purge: check-mark hypotheses to KEEP, clear the rest
    this._keep = new Set();       // hypothesis ids marked to survive a purge
    this._keepMode = false;       // checkmark column visible?
    this._purgeModalEl = null;

    // Debate Chamber — its own live feed of AI arguing
    this._debates = [];           // newest-first list of debate payloads
    this._debatePrint = '';
    this._seenDebates = new Set(); // dedupe key per debate

    // Evidence photo attachments (pending upload)
    this._evidenceFiles = [];

    // Evolution Tree (the growing forest)
    this._treePrint = '';         // structural fingerprint — redraw only on change
    this._treeStatus = new Map(); // slug → last status (detects fresh withering)

    // Operator-feedback + telemetry visuals
    this._vetoModalEl = null;     // veto reason popup
    this._lastLeader = null;      // slug of the current #1 (new-leader pulse)
    this._brainStats = {};        // lane → {calls, ok, ms total, last, pulseTimer}
    this._raceDpr = window.devicePixelRatio || 1;
  }

  async init() {
    this.render();
    await this._loadCouncils();
    // Poll as a WS fallback; cheap because repaints are fingerprint-gated.
    this._pollTimer = setInterval(() => { if (!document.hidden) this._refreshDetail(); }, 15000);
    // 1-second ticker only touches countdown text nodes — never the DOM tree.
    this._tickTimer = setInterval(() => this._tick(), 1000);
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'council';
    this.el.innerHTML = `
      <section class="card cog-card council-head-card">
        <div class="cog-head">
          <h3>⚖ Research Council</h3>
          <span class="council-head-actions">
            <button id="cn-revive" class="cog-btn cog-btn-ghost council-revive"
              title="Agents look offline or stuck? One click: re-tests the brain, re-engages idle council loops, probes paused ones — and if the backend itself is down, holds on while launchd/guardian restart it.">⟳ Revive agents</button>
            <span class="cog-pill" id="cn-state">idle</span>
          </span>
        </div>

        <div class="cog-ask council-ask">
          <input type="text" id="cn-goal" placeholder="Research goal — e.g. find app ideas that don't exist yet but people need" />
          <select id="cn-intensity" title="Work intensity per iteration">
            <option value="relaxed">Relaxed</option>
            <option value="standard" selected>Standard</option>
            <option value="intense">Intense</option>
          </select>
          <label class="council-web" title="Ground generation, falsification probes and deep verification in live Google search (rides the Gemini lane). On by default — untick to save quota.">
            <input type="checkbox" id="cn-web" checked /> web
          </label>
          <button id="cn-start" class="cog-btn">Convene</button>
        </div>

        <div class="council-current" id="cn-current" hidden>
          <div class="council-goal" id="cn-goal-display"></div>
          <div class="council-criteria" id="cn-criteria"></div>
          <div class="council-stats" id="cn-stats"></div>
          <div class="council-controls">
            <select id="cn-picker" title="Switch council"></select>
            <span class="council-countdown mono" id="cn-countdown"></span>
            <button id="cn-conclude" class="cog-btn council-btn-gold" hidden>🏛 Conclude &amp; Verdict</button>
            <button id="cn-stop" class="cog-btn cog-btn-ghost" hidden>■ Stop</button>
            <button id="cn-resume" class="cog-btn" hidden>▶ Resume</button>
          </div>
          <div class="council-power" id="cn-power-wrap" title="Token burn ↔ speed. Applies from the next iteration — live, mid-run.">
            <span class="council-power-icon">⚡</span>
            <input type="range" id="cn-power" min="1" max="5" step="1" value="2" />
            <span class="council-power-label" id="cn-power-label">Standard · ~9 calls/iter</span>
          </div>
          <div class="council-guidance" id="cn-guidance" hidden></div>
        </div>

        <div class="council-banner" id="cn-banner" hidden></div>
      </section>

      <!-- ── THE CHAMBER: agents working in realtime ─────────── -->
      <section class="card cog-card council-chamber-card">
        <div class="cog-head">
          <h3>🏛 Council Chamber</h3>
          <span class="cog-list-hint">halo = attributes · <strong>right-click an agent to retune it live</strong> · click for its mind</span>
        </div>
        <div class="council-chamber" id="cn-chamber"></div>
        <div class="council-brains" id="cn-brains"></div>
      </section>

      <!-- ── DEBATE CHAMBER: rival AI perspectives argue, live ─ -->
      <section class="card cog-card council-debate-card">
        <div class="cog-head">
          <h3>🗣 Debate Chamber</h3>
          <span class="cog-list-hint" id="cn-debate-hint">rival AI perspectives argue each direction & every high-stakes match — live</span>
        </div>
        <div class="council-debate-feed" id="cn-debate">
          <div class="cog-empty">No debates yet — they ignite when the council weighs new directions or a leadership match. 🔥</div>
        </div>
      </section>

      <!-- ── VERDICT (appears when the gavel falls) ──────────── -->
      <section class="card cog-card council-verdict" id="cn-verdict" hidden></section>

      <!-- ── EVOLUTION TREE: the growing forest of ideas ─────── -->
      <section class="card cog-card council-tree-card">
        <div class="cog-head">
          <h3>🌳 Evolution Tree</h3>
          <span class="cog-list-hint" id="cn-tree-hint">every idea takes root — branches are evolutions, glow is Elo</span>
        </div>
        <div class="council-tree" id="cn-tree">
          <div class="cog-empty">The forest is empty — convene a council and watch ideas take root. 🌱</div>
        </div>
        <div class="tree-legend mono">
          <span>🌱 root idea</span>
          <span>🧬 dashed ring = evolved</span>
          <span>✨ glow &amp; size = Elo</span>
          <span>🍂 withered = rejected</span>
          <span>👑 champion</span>
          <span>hover = sap line · click = details</span>
        </div>
      </section>

      <div class="cog-columns council-columns">
        <section class="card cog-card">
          <div class="cog-head"><h3>🏆 Leaderboard</h3><span class="cog-list-hint" id="cn-board-hint">Elo from pairwise judging</span></div>
          <div class="council-board-toolbar" id="cn-board-toolbar" hidden>
            <button id="cn-keep-toggle" class="cog-btn cog-btn-ghost" title="Show check-marks so you can mark the ideas to KEEP before clearing the rest">✓ Mark keepers</button>
            <span class="council-keep-count mono" id="cn-keep-count" hidden></span>
            <span class="council-toolbar-spacer"></span>
            <button id="cn-purge" class="cog-btn council-btn-purge"
              title="Clear every proposed topic from the board. The council is told these directions were weak and pivots — keeping any you check-marked as the direction to favor.">🧹 Clear all &amp; pivot</button>
          </div>
          <ul class="council-board" id="cn-board"><li class="cog-empty">No hypotheses yet — convene a council above.</li></ul>
        </section>

        <section class="card cog-card">
          <div class="cog-head"><h3>🕸 Hypothesis Graph</h3><span class="cog-list-hint">size = Elo · color = cluster · dashed = lineage</span></div>
          <div class="council-graph" id="cn-graph"></div>
        </section>
      </div>

      <div class="cog-columns council-columns">
        <section class="card cog-card">
          <div class="cog-head"><h3>⚔ Tournament</h3><span class="cog-list-hint">Elo race — every line is a hypothesis fighting for #1</span></div>
          <canvas id="cn-race" class="council-race" height="150"></canvas>
          <ul class="council-matches" id="cn-matches"><li class="cog-empty">No matches yet.</li></ul>
        </section>

        <section class="card cog-card">
          <div class="cog-head"><h3>📡 Activity</h3></div>
          <pre class="cog-log mono council-log" id="cn-log"></pre>

          <div class="cog-list-head">Evidence loop <span class="cog-list-hint">N independent analyses + consensus feed the next round</span></div>
          <div class="council-evidence-form">
            <textarea id="cn-evidence" rows="3" placeholder="Paste experiment output, measurements, market data — anything the council should reckon with…"></textarea>
            <div class="council-evidence-thumbs" id="cn-evidence-thumbs" hidden></div>
            <div class="council-evidence-actions">
              <label class="cog-btn cog-btn-ghost council-evidence-photo" title="Attach photos — charts, screenshots, whiteboards. They ride along with the evidence drop.">
                📷 Add photos
                <input type="file" id="cn-evidence-images" accept="image/*" multiple hidden />
              </label>
              <button id="cn-evidence-btn" class="cog-btn">Submit evidence</button>
            </div>
          </div>
          <ul class="council-evidence-list" id="cn-evidence-list"></ul>
        </section>
      </div>
    `;
    this.container.appendChild(this.el);

    this._buildChamber();

    // ── Bindings (delegated where lists are involved) ──
    this.el.querySelector('#cn-start').addEventListener('click', () => this._start());
    this.el.querySelector('#cn-revive').addEventListener('click', () => this._revive());
    this.el.querySelector('#cn-goal').addEventListener('keydown', e => { if (e.key === 'Enter') this._start(); });
    this.el.querySelector('#cn-stop').addEventListener('click', () => this._stop());
    this.el.querySelector('#cn-resume').addEventListener('click', () => this._resume());
    this.el.querySelector('#cn-conclude').addEventListener('click', () => this._conclude());
    this.el.querySelector('#cn-evidence-btn').addEventListener('click', () => this._submitEvidence());
    this.el.querySelector('#cn-picker').addEventListener('change', (e) => this._switchCouncil(e.target.value));
    this.el.querySelector('#cn-board').addEventListener('click', (e) => {
      const keepBox = e.target.closest('[data-keep]');
      if (keepBox) {
        e.stopPropagation();
        this._toggleKeep(keepBox.dataset.keep);
        return;
      }
      const vetoBtn = e.target.closest('[data-veto]');
      if (vetoBtn) {
        e.stopPropagation();
        this._openVetoModal(vetoBtn.dataset.veto);
        return;
      }
      const li = e.target.closest('[data-hyp]');
      if (li) this._toggleHyp(li.dataset.hyp);
    });

    // Purge controls: clear the board / mark keepers.
    this.el.querySelector('#cn-purge').addEventListener('click', () => this._openPurgeModal());
    this.el.querySelector('#cn-keep-toggle').addEventListener('click', () => this._toggleKeepMode());

    // Evidence photos.
    const imgInput = this.el.querySelector('#cn-evidence-images');
    imgInput.addEventListener('change', () => this._addEvidenceFiles(imgInput.files));
    this.el.querySelector('#cn-evidence-thumbs').addEventListener('click', (e) => {
      const rm = e.target.closest('[data-rm-img]');
      if (rm) this._removeEvidenceFile(Number(rm.dataset.rmImg));
    });

    // Power dial: live preview while dragging, commit on release.
    const power = this.el.querySelector('#cn-power');
    power.addEventListener('input', () => this._paintPowerLabel(Number(power.value)));
    power.addEventListener('change', () => this._commitPower(Number(power.value)));
  }

  // ════════════════════════════════════════════════════════════
  //  THE CHAMBER — live agent ring (SVG, CSS-animated)
  // ════════════════════════════════════════════════════════════

  _buildChamber() {
    const W = 860, H = 340, cx = W / 2, cy = H / 2 - 10;
    const rx = 350, ry = 118;
    const station = (s, i) => {
      const angle = (i / STATIONS.length) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(angle) * rx;
      const y = cy + Math.sin(angle) * ry;
      return `
        <g class="chamber-station" id="cn-station-${s.role}" data-role="${s.role}" data-x="${x}" data-y="${y}">
          <line class="chamber-beam" x1="${x}" y1="${y}" x2="${cx}" y2="${cy}" />
          <circle class="chamber-halo" cx="${x}" cy="${y}" r="26" />
          <g class="trait-halo" id="cn-halo-${s.role}"></g>
          <circle class="chamber-node" cx="${x}" cy="${y}" r="20" />
          <circle class="chamber-think-ring" cx="${x}" cy="${y}" r="23" />
          <text class="chamber-icon" x="${x}" y="${y + 5}" text-anchor="middle">${s.icon}</text>
          <text class="chamber-name" x="${x}" y="${y + 38}" text-anchor="middle">${s.name}</text>
          <text class="chamber-action" id="cn-action-${s.role}" x="${x}" y="${y + 51}" text-anchor="middle">${s.duty}</text>
        </g>`;
    };
    this.el.querySelector('#cn-chamber').innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="chamber-svg" preserveAspectRatio="xMidYMid meet">
        <ellipse class="chamber-ring" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" />
        <g class="chamber-core chamber-station" id="cn-core" data-role="verdict" data-x="${cx}" data-y="${cy}">
          <circle class="chamber-core-halo" cx="${cx}" cy="${cy}" r="42" />
          <g class="trait-halo" id="cn-halo-verdict"></g>
          <circle class="chamber-core-node" cx="${cx}" cy="${cy}" r="32" />
          <circle class="chamber-think-ring" cx="${cx}" cy="${cy}" r="36" />
          <text class="chamber-icon" x="${cx}" y="${cy + 6}" text-anchor="middle">⚖</text>
          <text class="chamber-name" x="${cx}" y="${cy + 56}" text-anchor="middle" id="cn-core-label">research goal</text>
        </g>
        ${STATIONS.map(station).join('')}
      </svg>`;

    // Right-click an agent → retune menu. Left-click → its live mind.
    const chamber = this.el.querySelector('#cn-chamber');
    chamber.addEventListener('contextmenu', (e) => {
      const g = e.target.closest('[data-role]');
      if (!g) return;
      e.preventDefault();
      this._openAgentMenu(g.dataset.role, e.clientX, e.clientY);
    });
    chamber.addEventListener('click', (e) => {
      const g = e.target.closest('[data-role]');
      if (!g) return;
      this._openDrawer(g.dataset.role, 'mind');
    });
  }

  /** Paint each agent's trait halo: five arc segments, opacity = value. */
  _paintTraitHalos() {
    if (!this.el) return;
    for (const s of [...STATIONS, CORE_AGENT]) {
      const host = this.el.querySelector(`#cn-halo-${s.role}`);
      const station = this.el.querySelector(`[data-role="${s.role}"]`);
      if (!host || !station) continue;
      const agent = this.agents.get(s.role);
      if (!agent) { host.innerHTML = ''; continue; }
      const x = Number(station.dataset.x);
      const y = Number(station.dataset.y);
      const r = s.role === 'verdict' ? 39 : 27;
      const seg = (Math.PI * 2) / TRAITS.length;
      const gap = 0.10;
      host.innerHTML = TRAITS.map((t, i) => {
        const a0 = -Math.PI / 2 + i * seg + gap / 2;
        const a1 = -Math.PI / 2 + (i + 1) * seg - gap / 2;
        const v = Number(agent.traits?.[t.key]) || 0;
        return `<path d="${arcPath(x, y, r, a0, a1)}" stroke="${t.color}"
          stroke-opacity="${(0.12 + 0.88 * (v / 10)).toFixed(2)}" stroke-width="${2.2 + v * 0.22}"
          fill="none" stroke-linecap="round"><title>${esc(t.label)}: ${v}/10</title></path>`;
      }).join('');
    }
  }

  /** Fire a station: glow + beam + action caption. Pure class toggles — cheap. */
  _fireStation(role, line = '') {
    const map = { criteria: 'ranking', meta: 'supervisor', falsify: 'reflection', verdict: null, system: null };
    const target = map[role] !== undefined ? map[role] : role;

    if (role === 'verdict' || role === 'system') {
      const core = this.el?.querySelector('#cn-core');
      if (core) {
        core.classList.remove('is-firing');
        void core.getBoundingClientRect();
        core.classList.add('is-firing');
      }
      if (role === 'verdict') return;
    }
    if (!target) return;
    const g = this.el?.querySelector(`#cn-station-${target}`);
    if (!g) return;
    g.classList.remove('is-firing');
    void g.getBoundingClientRect(); // restart the CSS animation
    g.classList.add('is-firing');

    const action = this.el.querySelector(`#cn-action-${target}`);
    if (action && line) {
      action.textContent = trunc(line.replace(/^[⚔✓✗+↳≈⏸▶🏛🏆⚠🛠]+\s*/, ''), 44);
      action.classList.add('is-live');
    }
    clearTimeout(this._stationTimers[target]);
    this._stationTimers[target] = setTimeout(() => {
      g.classList.remove('is-firing');
    }, 4200);
  }

  // ════════════════════════════════════════════════════════════
  //  Live WebSocket hook (routed from main.js)
  // ════════════════════════════════════════════════════════════

  onCouncilUpdate(payload = {}) {
    if (!payload.councilId) return;
    if (!this.councilId) this.councilId = payload.councilId;
    if (payload.councilId !== this.councilId) return;
    // Realtime: the chamber reacts instantly; heavier data follows coalesced.
    this._fireStation(payload.role, payload.line || '');
    if (payload.status) this._setStatusPill(payload.status);
    // Feed the role's mind history so the viewer is rich even between polls.
    const agent = this.agents.get(payload.role);
    if (agent && payload.line) {
      agent.mind = agent.mind || { history: [] };
      agent.mind.history = agent.mind.history || [];
      agent.mind.history.push({ at: payload.timestamp || new Date().toISOString(), kind: 'event', text: payload.line, ok: true });
      if (agent.mind.history.length > 40) agent.mind.history.splice(0, agent.mind.history.length - 40);
      if (this._drawerRole === payload.role && this._drawerTab === 'mind') this._renderDrawer();
    }
    if (!this._refreshQueued) {
      this._refreshQueued = true;
      setTimeout(() => { this._refreshQueued = false; this._refreshDetail(); }, 3000);
    }
  }

  /** Live mind stream: an agent started or finished thinking. */
  onAgentState(payload = {}) {
    if (!payload.councilId || payload.councilId !== this.councilId || !this.el) return;
    const { role, state, task, thought, ms, ok } = payload;
    const agent = this.agents.get(role);
    if (agent) {
      agent.mind = agent.mind || { history: [] };
      agent.mind.state = state;
      if (task) agent.mind.task = task;
      if (state !== 'thinking') {
        agent.mind.lastMs = ms || agent.mind.lastMs;
        agent.mind.calls = (agent.mind.calls || 0) + 1;
        if (ok) agent.mind.ok = (agent.mind.ok || 0) + 1;
        else agent.mind.failed = (agent.mind.failed || 0) + 1;
        if (thought) agent.mind.thought = thought;
      }
    }

    // Chamber visuals: pulse while thinking, stream the thought when done.
    const mapped = role === 'criteria' ? 'ranking' : role;
    const g = this.el.querySelector(`[data-role="${mapped}"]`);
    if (g) {
      g.classList.toggle('is-thinking', state === 'thinking');
      const action = this.el.querySelector(`#cn-action-${mapped}`);
      if (action) {
        if (state === 'thinking') {
          action.textContent = trunc(`🧠 ${task || 'thinking'}…`, 46);
          action.classList.add('is-live');
        } else if (thought) {
          action.textContent = trunc(thought, 46);
          action.classList.add('is-live');
        }
      }
    }
    if (this._drawerRole === role) this._renderDrawer();
  }

  /** The operator retuned an agent (possibly from another tab) — repaint. */
  onAgentTraits(payload = {}) {
    if (!payload.councilId || payload.councilId !== this.councilId || !payload.agent) return;
    this.agents.set(payload.role, { ...this.agents.get(payload.role), ...payload.agent });
    this._paintTraitHalos();
    if (this._drawerRole === payload.role && !this._drawerEl?.contains(document.activeElement)) {
      this._renderDrawer();
    }
  }

  /** Merge the agents block from a detail fetch into live state. */
  _updateAgents(list) {
    if (!Array.isArray(list)) return;
    for (const agent of list) {
      const prev = this.agents.get(agent.role);
      // Keep the freshest mind: WS events may be ahead of the poll.
      const mind = prev?.mind && (prev.mind.calls || 0) > (agent.mind?.calls || 0) ? prev.mind : agent.mind;
      this.agents.set(agent.role, { ...agent, mind });
    }
    this._paintTraitHalos();
  }

  // ════════════════════════════════════════════════════════════
  //  Right-click menu + attribute editor / mind viewer
  // ════════════════════════════════════════════════════════════

  _openAgentMenu(role, x, y) {
    this._closeMenu();
    const s = STATION_BY_ROLE[role];
    if (!s) return;
    const menu = document.createElement('div');
    menu.className = 'agent-menu';
    menu.innerHTML = `
      <div class="agent-menu-head">${s.icon} ${esc(s.name)} <small>${esc(s.duty)}</small></div>
      <button data-act="attributes">🎛 Change attributes</button>
      <button data-act="mind">🧠 View mind</button>
      <button data-act="reset">↺ Reset to defaults</button>
    `;
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 12)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 12)}px`;
    this._menuEl = menu;

    menu.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      this._closeMenu();
      if (act === 'attributes') this._openDrawer(role, 'attributes');
      else if (act === 'mind') this._openDrawer(role, 'mind');
      else if (act === 'reset') this._resetAgent(role);
    });

    this._docClick = (e) => { if (!menu.contains(e.target)) this._closeMenu(); };
    setTimeout(() => {
      document.addEventListener('mousedown', this._docClick, true);
      document.addEventListener('keydown', this._escClose = (ev) => { if (ev.key === 'Escape') { this._closeMenu(); this._closeDrawer(); } });
    }, 0);
  }

  _closeMenu() {
    if (this._menuEl) { this._menuEl.remove(); this._menuEl = null; }
    if (this._docClick) { document.removeEventListener('mousedown', this._docClick, true); this._docClick = null; }
  }

  async _resetAgent(role) {
    if (!this.councilId) return;
    const defaults = { strictness: 5, creativity: 5, skepticism: 5, thoroughness: 6, riskAppetite: 5 };
    const hardDefaults = {
      generation: { strictness: 4, creativity: 8, skepticism: 4, thoroughness: 6, riskAppetite: 7 },
      reflection: { strictness: 8, creativity: 3, skepticism: 9, thoroughness: 8, riskAppetite: 2 },
      ranking:    { strictness: 8, creativity: 3, skepticism: 8, thoroughness: 7, riskAppetite: 3 },
      proximity:  { strictness: 6, creativity: 4, skepticism: 6, thoroughness: 6, riskAppetite: 4 },
      evolution:  { strictness: 5, creativity: 7, skepticism: 5, thoroughness: 7, riskAppetite: 6 },
      interpret:  { strictness: 7, creativity: 3, skepticism: 8, thoroughness: 8, riskAppetite: 2 },
      verdict:    { strictness: 7, creativity: 4, skepticism: 7, thoroughness: 8, riskAppetite: 3 },
    }[role] || defaults;
    try {
      const agent = await updateCouncilAgent(this.councilId, role, { ...hardDefaults, directive: '' });
      this.agents.set(role, { ...this.agents.get(role), ...agent });
      this._paintTraitHalos();
      if (this._drawerRole === role) this._renderDrawer();
    } catch (err) {
      this._flashBanner(`⚠ ${err.message}`, 'bad');
    }
  }

  _openDrawer(role, tab = 'attributes') {
    if (!STATION_BY_ROLE[role]) return;
    this._drawerRole = role;
    this._drawerTab = tab;
    if (!this._drawerEl) {
      this._drawerEl = document.createElement('div');
      this._drawerEl.className = 'agent-drawer';
      document.body.appendChild(this._drawerEl);
    }
    this._renderDrawer();
  }

  _closeDrawer() {
    if (this._drawerEl) { this._drawerEl.remove(); this._drawerEl = null; }
    this._drawerRole = null;
    if (this._escClose) { document.removeEventListener('keydown', this._escClose); this._escClose = null; }
  }

  _renderDrawer() {
    if (!this._drawerEl || !this._drawerRole) return;
    const role = this._drawerRole;
    const s = STATION_BY_ROLE[role];
    const agent = this.agents.get(role) || { traits: {}, directive: '', mind: {} };
    const mind = agent.mind || {};
    const tab = this._drawerTab;

    const sliders = TRAITS.map(t => {
      const v = Number(agent.traits?.[t.key]) || 5;
      return `
        <div class="agent-slider" title="${esc(t.desc)}">
          <div class="agent-slider-head">
            <span class="agent-slider-dot" style="background:${t.color}"></span>
            <label>${esc(t.label)}</label>
            <span class="agent-slider-val mono" id="ad-val-${t.key}">${v}</span>
          </div>
          <input type="range" min="1" max="10" step="1" value="${v}" data-trait="${t.key}"
                 style="--trait-color:${t.color}" />
          <div class="agent-slider-desc">${esc(t.desc)}</div>
        </div>`;
    }).join('');

    const stateChip = mind.state === 'thinking'
      ? `<span class="agent-state agent-state--thinking">● thinking${mind.task ? ` — ${esc(trunc(mind.task, 42))}` : ''}</span>`
      : `<span class="agent-state">○ idle</span>`;

    const history = (mind.history || []).slice(-22).reverse().map(h => `
      <li class="${h.ok === false ? 'is-fail' : ''} ${h.kind === 'event' ? 'is-event' : ''}">
        <span class="mono agent-hist-time">${fmtTime(h.at)}</span>
        <span class="agent-hist-text">${linkify(h.text || '')}</span>
        ${h.ms ? `<span class="mono agent-hist-ms">${(h.ms / 1000).toFixed(1)}s</span>` : ''}
      </li>`).join('');

    this._drawerEl.innerHTML = `
      <div class="agent-drawer-head">
        <span class="agent-drawer-icon">${s.icon}</span>
        <div class="agent-drawer-title">
          <h4>${esc(s.name)} agent</h4>
          <span>${esc(s.duty)}</span>
        </div>
        ${stateChip}
        <button class="agent-drawer-x" data-act="close">✕</button>
      </div>
      <div class="agent-drawer-tabs">
        <button class="${tab === 'attributes' ? 'is-active' : ''}" data-tab="attributes">🎛 Attributes</button>
        <button class="${tab === 'mind' ? 'is-active' : ''}" data-tab="mind">🧠 Mind</button>
      </div>
      ${tab === 'attributes' ? `
        <div class="agent-drawer-body">
          <div class="agent-drawer-note">Changes apply <strong>live</strong> — on this agent's very next action, even mid-iteration. It will acknowledge the retune.</div>
          ${sliders}
          <div class="agent-directive">
            <label>Standing directive <small>(free-text order, obeyed above all defaults)</small></label>
            <textarea rows="3" id="ad-directive" placeholder="e.g. Reject anything that isn't backed by a concrete mechanism. No buzzwords.">${esc(agent.directive || '')}</textarea>
          </div>
          <div class="agent-drawer-foot">
            <button class="cog-btn cog-btn-ghost" data-act="reset">↺ Defaults</button>
            <span class="agent-save-state mono" id="ad-save"></span>
          </div>
        </div>` : `
        <div class="agent-drawer-body">
          <div class="agent-mind-stats mono">
            <span>${mind.calls || 0} calls</span>
            <span class="ok">${mind.ok || 0} ok</span>
            <span class="fail">${mind.failed || 0} failed</span>
            <span>${mind.lastMs ? `${(mind.lastMs / 1000).toFixed(1)}s last` : ''}</span>
          </div>
          ${mind.thought ? `<div class="agent-thought">💭 ${linkify(mind.thought)}</div>` : '<div class="agent-thought agent-thought--empty">No thoughts yet — convene a council and watch this agent live.</div>'}
          <div class="cog-list-head">Thought stream</div>
          <ul class="agent-history">${history || '<li class="is-event"><span class="agent-hist-text">Quiet so far.</span></li>'}</ul>
        </div>`}
    `;

    // Bindings
    this._drawerEl.querySelector('[data-act="close"]').onclick = () => this._closeDrawer();
    this._drawerEl.querySelectorAll('[data-tab]').forEach(b => {
      b.onclick = () => { this._drawerTab = b.dataset.tab; this._renderDrawer(); };
    });
    const resetBtn = this._drawerEl.querySelector('[data-act="reset"]');
    if (resetBtn) resetBtn.onclick = () => this._resetAgent(role);

    this._drawerEl.querySelectorAll('input[type="range"]').forEach(input => {
      input.addEventListener('input', () => {
        const key = input.dataset.trait;
        const valEl = this._drawerEl.querySelector(`#ad-val-${key}`);
        if (valEl) valEl.textContent = input.value;
        this._queueTraitPatch(role);
      });
    });
    const directive = this._drawerEl.querySelector('#ad-directive');
    if (directive) directive.addEventListener('input', () => this._queueTraitPatch(role));
  }

  /** Debounce slider/directive edits into one PATCH; confirm with "✓ live". */
  _queueTraitPatch(role) {
    const save = this._drawerEl?.querySelector('#ad-save');
    if (save) { save.textContent = '…'; save.className = 'agent-save-state mono'; }
    clearTimeout(this._traitDebounce);
    this._traitDebounce = setTimeout(async () => {
      if (!this._drawerEl || this._drawerRole !== role || !this.councilId) return;
      const patch = {};
      this._drawerEl.querySelectorAll('input[type="range"]').forEach(i => { patch[i.dataset.trait] = Number(i.value); });
      const directive = this._drawerEl.querySelector('#ad-directive');
      if (directive) patch.directive = directive.value;
      try {
        const agent = await updateCouncilAgent(this.councilId, role, patch);
        this.agents.set(role, { ...this.agents.get(role), ...agent });
        this._paintTraitHalos();
        const saveEl = this._drawerEl?.querySelector('#ad-save');
        if (saveEl) { saveEl.textContent = '✓ applied live'; saveEl.className = 'agent-save-state mono is-ok'; }
      } catch (err) {
        const saveEl = this._drawerEl?.querySelector('#ad-save');
        if (saveEl) { saveEl.textContent = `⚠ ${err.message}`; saveEl.className = 'agent-save-state mono is-bad'; }
      }
    }, 450);
  }

  // ════════════════════════════════════════════════════════════
  //  Actions
  // ════════════════════════════════════════════════════════════

  async _start() {
    const input = this.el.querySelector('#cn-goal');
    const goal = input.value.trim();
    if (!goal) { input.focus(); return; }
    const config = {
      ...(INTENSITY_PRESETS[this.el.querySelector('#cn-intensity').value] || {}),
      webSearch: this.el.querySelector('#cn-web').checked,
    };
    const btn = this.el.querySelector('#cn-start');
    btn.disabled = true;
    try {
      const created = await startCouncil(goal, config);
      input.value = '';
      this._switchCouncil(created.id);
      await this._loadCouncils();
    } catch (err) {
      this._flashBanner(`⚠ ${err.message}`, 'bad');
    } finally {
      btn.disabled = false;
    }
  }

  _switchCouncil(id) {
    if (!id || id === this.councilId) return;
    this.councilId = id;
    this.detail = null;
    this.expanded.clear();
    this._prints = {};
    this._graphCounts = '';
    this.agents.clear();
    this._closeMenu();
    this._closeDrawer();
    this._hideNodePopover();
    this._closePurgeModal();
    this._lineageOf = null;
    if (this._graph) { this._graph.destroy(); this._graph = null; }
    this.el.querySelector('#cn-graph')?.replaceChildren();
    this._keep.clear();
    this._keepMode = false;
    this._evidenceFiles = [];
    this._renderEvidenceThumbs();
    this._debates = [];
    this._seenDebates = new Set();
    this._debatePrint = '';
    this.el.querySelector('#cn-debate')?.replaceChildren();
    this._treePrint = '';
    this._treeStatus = new Map();
    this.el.querySelector('#cn-tree')?.replaceChildren();
    const log = this.el.querySelector('#cn-log');
    if (log) log.textContent = '';
    this._refreshDetail();
  }

  /**
   * The operator's big red button for "the agents went offline".
   * Backend reachable → one POST re-tests the brain, re-engages idle
   * council loops and probes paused ones. Backend dead → hold on and
   * poll health while launchd/the guardian restart it, then reload.
   */
  async _revive() {
    const btn = this.el.querySelector('#cn-revive');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = '⟳ Reviving…';
    try {
      const data = await reviveAgents();
      const b = data?.brain || {};
      const parts = [];
      if (data?.loops) parts.push(`${data.loops} council loop${data.loops > 1 ? 's' : ''} re-engaged`);
      if (data?.probes) parts.push(`${data.probes} paused council${data.probes > 1 ? 's' : ''} probed`);
      this._flashBanner(
        b.ok
          ? `✓ <strong>Agents revived.</strong> Brain online (${esc(b.provider || '?')} · ${esc(b.model || '')} · ${b.ms}ms)${parts.length ? ` · ${parts.join(' · ')}` : ' · all loops were already live'}.`
          : `⚠ Backend is up but the brain test failed (<strong>${esc(b.reason || 'unknown')}</strong>) — check the model chooser in the topbar, or quota may be exhausted (councils auto-resume when it returns).`,
        b.ok ? 'ok' : 'warn', 10000);
      this._refreshDetail();
    } catch {
      // Backend unreachable — launchd KeepAlive + the guardian bring it
      // back; we hold the line and reconnect the moment it's healthy.
      this._flashBanner('⏳ Backend unreachable — launchd/guardian are restarting it. Holding for reconnect…', 'warn', 0);
      const t0 = Date.now();
      while (Date.now() - t0 < 120000) {
        await new Promise(r => setTimeout(r, 3000));
        try {
          const h = await fetch('/api/health');
          if (h.ok) { window.location.reload(); return; }
        } catch { /* still down — keep holding */ }
      }
      this._flashBanner('⚠ Backend still down after 2 minutes — from a terminal run: <code>npm run service:restart</code>', 'bad', 0);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  async _stop() {
    if (!this.councilId) return;
    try { await stopCouncil(this.councilId); } catch (err) { this._flashBanner(`⚠ ${err.message}`, 'bad'); }
    this._refreshDetail();
  }

  async _resume() {
    if (!this.councilId) return;
    try { await resumeCouncil(this.councilId); } catch (err) { this._flashBanner(`⚠ ${err.message}`, 'bad'); }
    this._refreshDetail();
  }

  async _conclude() {
    if (!this.councilId) return;
    const btn = this.el.querySelector('#cn-conclude');
    btn.disabled = true;
    btn.textContent = '🏛 Deliberating…';
    this._flashBanner('🏛 The council is deliberating its final verdict — this takes a minute or two…', 'gold', 0);
    try {
      await concludeCouncil(this.councilId);
      this._hideBanner();
    } catch (err) {
      this._flashBanner(`⚠ Verdict: ${err.message}`, 'bad');
    } finally {
      btn.disabled = false;
      btn.textContent = '🏛 Conclude & Verdict';
      this._refreshDetail();
    }
  }

  async _submitEvidence() {
    if (!this.councilId) return;
    const area = this.el.querySelector('#cn-evidence');
    const content = area.value.trim();
    const files = this._evidenceFiles.slice();
    if (!content && !files.length) { area.focus(); return; }
    const btn = this.el.querySelector('#cn-evidence-btn');
    btn.disabled = true;
    const original = btn.textContent;
    if (files.length) btn.textContent = 'Uploading…';
    try {
      await submitCouncilEvidence(this.councilId, content, files);
      area.value = '';
      this._evidenceFiles = [];
      this._renderEvidenceThumbs();
      this._refreshDetail();
    } catch (err) {
      this._flashBanner(`⚠ ${err.message}`, 'bad');
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  /** Queue selected photos for the next evidence submission. */
  _addEvidenceFiles(fileList) {
    const incoming = [...(fileList || [])].filter(f => f.type.startsWith('image/'));
    for (const f of incoming) {
      if (this._evidenceFiles.length >= 8) break;
      this._evidenceFiles.push(f);
    }
    const input = this.el.querySelector('#cn-evidence-images');
    if (input) input.value = ''; // allow re-picking the same file
    this._renderEvidenceThumbs();
  }

  _removeEvidenceFile(idx) {
    this._evidenceFiles.splice(idx, 1);
    this._renderEvidenceThumbs();
  }

  _renderEvidenceThumbs() {
    const host = this.el?.querySelector('#cn-evidence-thumbs');
    if (!host) return;
    if (!this._evidenceFiles.length) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    host.innerHTML = this._evidenceFiles.map((f, i) => `
      <span class="council-evidence-thumb">
        <img src="${URL.createObjectURL(f)}" alt="${esc(f.name)}" />
        <button data-rm-img="${i}" title="Remove">✕</button>
      </span>`).join('');
  }

  _toggleHyp(id) {
    if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id);
    const li = this.el.querySelector(`[data-hyp="${cssEscape(id)}"]`);
    if (!li) return;
    const detail = li.querySelector('.council-hyp-detail');
    if (detail) { detail.hidden = !detail.hidden; li.classList.toggle('is-open', !detail.hidden); }
  }

  // ════════════════════════════════════════════════════════════
  //  Operator veto — strike a hypothesis, teach the council
  // ════════════════════════════════════════════════════════════

  _openVetoModal(hypId) {
    const hyp = (this.detail?.hypotheses || []).find(h => h.id === hypId);
    if (!hyp) return;
    this._closeVetoModal();
    const overlay = document.createElement('div');
    overlay.className = 'veto-overlay';
    overlay.innerHTML = `
      <div class="veto-modal">
        <div class="veto-head">⛔ Veto ${esc(hyp.slug)} — “${esc(trunc(hyp.title, 64))}”</div>
        <p class="veto-sub">This strikes it from the tournament, refunds the Elo it took from
        opponents, and becomes standing guidance every agent obeys from its next call.</p>
        <textarea class="veto-reason" rows="3"
          placeholder="Why? (optional — but a reason teaches the council your taste, e.g. “too generic, nothing a musician couldn't already do”)"></textarea>
        <div class="veto-actions">
          <button class="cog-btn cog-btn-ghost" data-act="cancel">Cancel</button>
          <button class="cog-btn veto-confirm" data-act="veto">⛔ Veto it</button>
        </div>
      </div>`;
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) this._closeVetoModal(); });
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => this._closeVetoModal());
    overlay.querySelector('[data-act="veto"]').addEventListener('click', async () => {
      const btn = overlay.querySelector('[data-act="veto"]');
      const reason = overlay.querySelector('.veto-reason').value.trim();
      btn.disabled = true;
      btn.textContent = '⛔ Striking…';
      try {
        const result = await vetoCouncilHypothesis(this.councilId, hyp.id, reason);
        this._closeVetoModal();
        const refunded = (result?.refunds || []).length;
        this._flashBanner(
          `⛔ ${hyp.slug} vetoed${reason ? ' — the council noted your reason' : ''}.`
          + `${refunded ? ` ${refunded} past judgement${refunded > 1 ? 's' : ''} reversed.` : ''}`
          + ' Every agent adapts from its next call.', 'bad');
        this._refreshDetail();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '⛔ Veto it';
        this._flashBanner(`⚠ Veto failed: ${err.message}`, 'bad');
      }
    });
    document.body.appendChild(overlay);
    this._vetoModalEl = overlay;
    overlay.querySelector('.veto-reason').focus();
  }

  _closeVetoModal() {
    if (this._vetoModalEl?.parentNode) this._vetoModalEl.parentNode.removeChild(this._vetoModalEl);
    this._vetoModalEl = null;
  }

  /** WS: a veto landed (possibly from another tab) — repaint fast. */
  onVeto(payload = {}) {
    if (!payload.councilId || payload.councilId !== this.councilId) return;
    this._fireStation('system', `⛔ ${payload.slug} vetoed by operator`);
    this._refreshDetail();
  }

  /** WS: the power dial moved. */
  onPower(payload = {}) {
    if (!payload.councilId || payload.councilId !== this.councilId || !this.el) return;
    const slider = this.el.querySelector('#cn-power');
    if (slider && Number(slider.value) !== payload.power) slider.value = payload.power;
    this._paintPowerLabel(payload.power);
  }

  // ════════════════════════════════════════════════════════════
  //  Power dial
  // ════════════════════════════════════════════════════════════

  _paintPowerLabel(p) {
    const label = this.el?.querySelector('#cn-power-label');
    const meta = POWER_LABELS[p];
    if (label && meta) label.textContent = `${meta[0]} · ${meta[1]}`;
    const wrap = this.el?.querySelector('#cn-power-wrap');
    if (wrap) wrap.dataset.level = p;
  }

  async _commitPower(p) {
    if (!this.councilId) return;
    try {
      await setCouncilPower(this.councilId, p);
      this._flashBanner(`⚡ Power → ${POWER_LABELS[p]?.[0] || p}/5 — applies from the next iteration.`, 'gold');
    } catch (err) {
      this._flashBanner(`⚠ Power change failed: ${err.message}`, 'bad');
    }
  }

  // ════════════════════════════════════════════════════════════
  //  Brain cores — which physical brain is thinking, live
  // ════════════════════════════════════════════════════════════

  /** WS: one brain call finished somewhere in the council. */
  onCouncilCall(payload = {}) {
    if (!payload.councilId || payload.councilId !== this.councilId || !this.el) return;
    // Key off the provider that ACTUALLY served (a rate-limited
    // OpenRouter lane falls through to Gemini — show the truth).
    const lane = payload.provider === 'openrouter' ? 'openrouter' : 'gemini';
    const s = this._brainStats[lane] || (this._brainStats[lane] = { calls: 0, ok: 0, msTotal: 0, last: 0, model: '' });
    s.calls += 1;
    if (payload.ok) s.ok += 1;
    s.msTotal += Number(payload.ms) || 0;
    s.last = Number(payload.ms) || 0;
    s.model = payload.model || s.model;
    s.role = payload.role || '';
    this._paintBrains();
    // Pulse the core that just fired.
    const core = this.el.querySelector(`.brain-core[data-lane="${lane}"]`);
    if (core) {
      core.classList.remove('is-firing');
      void core.getBoundingClientRect();
      core.classList.add('is-firing');
    }
  }

  _paintBrains() {
    const host = this.el?.querySelector('#cn-brains');
    if (!host) return;
    const lanes = Object.keys(this._brainStats);
    if (!lanes.length) { host.innerHTML = ''; return; }
    const order = ['gemini', 'openrouter'].filter(l => lanes.includes(l));
    host.innerHTML = order.map(lane => {
      const meta = LANE_META[lane];
      const s = this._brainStats[lane];
      const avg = s.calls ? Math.round(s.msTotal / s.calls / 100) / 10 : 0;
      return `
        <div class="brain-core" data-lane="${lane}" style="--core-color:${meta.color}">
          <span class="brain-core-orb"></span>
          <span class="brain-core-name">${meta.name}</span>
          <span class="brain-core-stats mono">${s.calls} calls · ${avg}s avg${s.role ? ` · last: ${esc(s.role)}` : ''}</span>
        </div>`;
    }).join('');
  }

  // ════════════════════════════════════════════════════════════
  //  Elo race — the tournament as a living chart
  // ════════════════════════════════════════════════════════════

  _paintRace(matches = [], hypotheses = []) {
    const canvas = this.el?.querySelector('#cn-race');
    if (!canvas) return;
    const ordered = [...matches].reverse(); // chronological
    if (ordered.length < 2) { canvas.hidden = true; return; }
    canvas.hidden = false;

    // Build per-slug Elo series across match history.
    const series = new Map(); // slug → [{x, elo}]
    ordered.forEach((m, x) => {
      if (m.a_slug) {
        if (!series.has(m.a_slug)) series.set(m.a_slug, []);
        series.get(m.a_slug).push({ x, elo: Number(m.elo_a_after) || 1200 });
      }
      if (m.b_slug) {
        if (!series.has(m.b_slug)) series.set(m.b_slug, []);
        series.get(m.b_slug).push({ x, elo: Number(m.elo_b_after) || 1200 });
      }
    });

    // Keep the 6 best current hypotheses (active first), color-stable.
    const aliveSlugs = new Set(hypotheses.filter(h => h.status === 'active').map(h => h.slug));
    const ranked = [...series.entries()]
      .sort((a, b) => (b[1][b[1].length - 1]?.elo || 0) - (a[1][a[1].length - 1]?.elo || 0))
      .filter(([slug]) => aliveSlugs.size === 0 || aliveSlugs.has(slug))
      .slice(0, 6);
    if (!ranked.length) { canvas.hidden = true; return; }

    const dpr = this._raceDpr;
    const cssW = canvas.clientWidth || canvas.parentElement.clientWidth || 400;
    const cssH = 150;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    let lo = Infinity, hi = -Infinity;
    for (const [, pts] of ranked) for (const p of pts) { lo = Math.min(lo, p.elo); hi = Math.max(hi, p.elo); }
    if (!Number.isFinite(lo) || hi - lo < 20) { lo -= 20; hi += 20; }
    const pad = 14;
    const X = (x) => pad + (x / Math.max(1, ordered.length - 1)) * (cssW - pad * 2 - 60);
    const Y = (e) => pad + (1 - (e - lo) / (hi - lo)) * (cssH - pad * 2);

    // Grid whisper.
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let g = 0; g < 3; g++) {
      const y = pad + (g / 2) * (cssH - pad * 2);
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(cssW - pad, y); ctx.stroke();
    }

    const palette = ['#00f0ff', '#ffd700', '#7b2fff', '#00ff88', '#ff9f1c', '#ff3366'];
    ranked.forEach(([slug, pts], i) => {
      const color = palette[i % palette.length];
      ctx.strokeStyle = color;
      ctx.lineWidth = i === 0 ? 2.2 : 1.4;
      ctx.shadowColor = color;
      ctx.shadowBlur = i === 0 ? 8 : 4;
      ctx.beginPath();
      pts.forEach((p, k) => { k === 0 ? ctx.moveTo(X(p.x), Y(p.elo)) : ctx.lineTo(X(p.x), Y(p.elo)); });
      ctx.stroke();
      ctx.shadowBlur = 0;
      const last = pts[pts.length - 1];
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(X(last.x), Y(last.elo), i === 0 ? 3.5 : 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.font = `${i === 0 ? '600 ' : ''}10px ui-monospace, monospace`;
      ctx.fillText(`${slug} ${Math.round(last.elo)}`, X(last.x) + 7, Y(last.elo) + 3.5);
    });
  }

  /** Operator-taste chips under the controls: what the council has learned. */
  _paintGuidance(council) {
    const host = this.el?.querySelector('#cn-guidance');
    if (!host) return;
    const guidance = Array.isArray(council.guidance) ? council.guidance : [];
    if (!guidance.length) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    host.innerHTML = `<span class="council-guidance-label">🧠 council learned:</span> `
      + guidance.slice(-5).map(v => {
        if (v.kind === 'purge') {
          const kept = (v.keptSlugs || []).length;
          return `<span class="council-guidance-chip is-purge" title="${esc(v.reason || 'operator cleared the board')}">🧹 cleared ${(v.clearedSlugs || []).length}${kept ? ` · favoring ${esc((v.keptSlugs || []).join(', '))}` : ' · pivoting'}</span>`;
        }
        return `<span class="council-guidance-chip" title="${esc(v.reason || 'no reason given')}">⛔ ${esc(v.slug)}${v.reason ? ` · ${esc(trunc(v.reason, 34))}` : ''}</span>`;
      }).join('');
  }

  // ════════════════════════════════════════════════════════════
  //  Data → DOM (fingerprint-gated: no change, no repaint)
  // ════════════════════════════════════════════════════════════

  async _loadCouncils() {
    try {
      const councils = await listCouncils() || [];
      const picker = this.el.querySelector('#cn-picker');
      picker.innerHTML = councils.map(c =>
        `<option value="${esc(c.id)}">${esc(c.goal.slice(0, 56))} · ${esc(c.status)}</option>`).join('');
      if (!this.councilId) {
        const active = councils.find(c => ['running', 'quota_paused'].includes(c.status)) || councils[0];
        this.councilId = active?.id || null;
      }
      if (this.councilId) picker.value = this.councilId;
      await this._refreshDetail();
    } catch { /* backend offline */ }
  }

  async _refreshDetail() {
    if (!this.councilId || !this.el) return;
    let detail;
    try { detail = await getCouncilDetail(this.councilId); } catch { return; }
    if (!detail?.council || !this.el) return;
    this.detail = detail;
    const { council, hypotheses, matches, events, evidence } = detail;

    this._updateAgents(detail.agents);
    this._paintHeader(council, hypotheses);
    this._paintGuidance(council);
    // Full board rebuild only when the visible structure changes (rank order,
    // status, cluster, attached media). Raw Elo + W-L tick on every match —
    // those refresh in place via _updateBoardNumbers, so we don't rebuild 30
    // rich rows (and re-decode their photos) several times a second.
    const boardPrint = hash(JSON.stringify(
      hypotheses.filter(h => h.status !== 'rejected').slice(0, 30)
        .map(h => [h.id, h.status, h.cluster, (h.images || []).length > 0, (h.sources || []).length > 0, Number(h.slop_risk) >= 5])
    ));
    if (this._changed('board', boardPrint)) this._paintBoard(council, hypotheses);
    else this._updateBoardNumbers(council, hypotheses);
    if (this._changed('matches', matches)) {
      this._paintMatches(matches);
      this._paintRace(matches, hypotheses);
    }
    if (this._changed('evidence', evidence)) this._paintEvidence(evidence);
    if (this._changed('events', events?.length && events[events.length - 1].id)) this._paintLog(events);
    this._syncDebates(events);
    if (this._changed('verdict', council.verdict?.concludedAt || '')) this._paintVerdict(council);
    this._refreshGraph();
    this._refreshTree();
  }

  // ════════════════════════════════════════════════════════════
  //  DEBATE CHAMBER — rival AI perspectives argue, in realtime
  // ════════════════════════════════════════════════════════════

  /** Rebuild the debate list from persisted events (survives reloads). */
  _syncDebates(events = []) {
    const debates = events
      .filter(e => e.role === 'debate' && e.data && Array.isArray(e.data.turns))
      .map(e => ({ id: e.id, iteration: e.iteration, ...e.data }));
    if (!debates.length && !this._debates.length) return;
    const print = hash(JSON.stringify(debates.map(d => d.id)));
    if (print === this._debatePrint) return;
    this._debatePrint = print;
    for (const d of debates) this._seenDebates.add(this._debateKey(d));
    // Newest first; cap the rendered history.
    this._debates = debates.slice().reverse().slice(0, 24);
    this._paintDebates();
  }

  _debateKey(d) {
    return `${d.kind}:${d.title}:${d.iteration}:${(d.turns || []).length}`;
  }

  /** WS: a fresh debate is being spoken — prepend it and reveal it live. */
  onCouncilDebate(payload = {}) {
    if (!payload.councilId || payload.councilId !== this.councilId || !this.el) return;
    if (!Array.isArray(payload.turns) || !payload.turns.length) return;
    const key = this._debateKey(payload);
    if (this._seenDebates.has(key)) return;
    this._seenDebates.add(key);
    this._debates.unshift({ id: `live-${Date.now()}`, ...payload });
    this._debates = this._debates.slice(0, 24);
    if (payload.status) this._setStatusPill(payload.status);
    this._fireStation(payload.kind === 'ranking' ? 'ranking' : 'generation', '🗣 debate in the chamber');
    this._paintDebates(true);
    const hint = this.el.querySelector('#cn-debate-hint');
    if (hint) hint.textContent = `${this._debates.length} debate${this._debates.length === 1 ? '' : 's'} · newest just landed`;
  }

  _paintDebates(animateFirst = false) {
    const host = this.el?.querySelector('#cn-debate');
    if (!host) return;
    if (!this._debates.length) {
      host.innerHTML = '<div class="cog-empty">No debates yet — they ignite when the council weighs new directions or a leadership match. 🔥</div>';
      return;
    }
    host.innerHTML = this._debates.map((d, i) => this._renderDebate(d, animateFirst && i === 0)).join('');
  }

  _renderDebate(d, isLive = false) {
    const kindTag = d.kind === 'ranking'
      ? '<span class="debate-kind debate-kind--match">⚔ high-stakes match</span>'
      : '<span class="debate-kind debate-kind--gen">✨ direction</span>';
    const refs = d.refs && d.refs.a
      ? `<span class="debate-refs mono">${esc(d.refs.a)} vs ${esc(d.refs.b)}${d.refs.winner ? ` → 🏆 ${esc(d.refs.winner)}` : ' → ⚖ draw'}</span>`
      : '';
    const turns = (d.turns || []).map((t, i) => `
      <div class="debate-turn debate-side--${esc(t.side || 'synthesis')}" ${isLive ? `style="animation-delay:${i * 0.5}s"` : ''}>
        <span class="debate-avatar">${esc(t.icon || '🗣')}</span>
        <div class="debate-bubble">
          <span class="debate-speaker">${esc(t.speaker || 'Voice')}</span>
          <span class="debate-text">${richText(t.text || '')}</span>
        </div>
      </div>`).join('');
    return `
      <div class="debate-card ${isLive ? 'is-live' : ''}">
        <div class="debate-card-head">
          ${kindTag}
          <span class="debate-title">${esc(d.title || 'Debate')}</span>
          ${refs}
        </div>
        <div class="debate-turns">${turns}</div>
        ${d.summary ? `<div class="debate-ruling">${richText(d.summary)}</div>` : ''}
      </div>`;
  }

  _changed(key, value) {
    const print = typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : hash(JSON.stringify(value ?? ''));
    if (this._prints[key] === print) return false;
    this._prints[key] = print;
    return true;
  }

  _paintHeader(council, hypotheses) {
    const current = this.el.querySelector('#cn-current');
    current.hidden = false;
    this.el.querySelector('#cn-goal-display').textContent = council.goal;
    this._setStatusPill(council.status);

    const criteria = Array.isArray(council.criteria) ? council.criteria : [];
    const critHost = this.el.querySelector('#cn-criteria');
    critHost.innerHTML = criteria.length
      ? `judged on ${criteria.map(c => `<span class="council-crit-chip" title="${esc(c.description)}">${esc(c.name)}</span>`).join('')}`
      : '';

    const stats = council.stats || {};
    const active = hypotheses.filter(h => h.status === 'active').length;
    this.el.querySelector('#cn-stats').textContent =
      `iteration ${council.iteration} · ${active} active / ${hypotheses.length} total hypotheses · `
      + `${stats.matchesPlayed || 0} matches · ${stats.callsUsed || 0} brain calls`
      + `${stats.evidenceProcessed ? ` · ${stats.evidenceProcessed} evidence drops` : ''}`;

    const live = ['running', 'quota_paused'].includes(council.status);
    this.el.querySelector('#cn-stop').hidden = !live;
    this.el.querySelector('#cn-resume').hidden = live;
    const ranked = hypotheses.some(h => h.matches > 0);
    this.el.querySelector('#cn-conclude').hidden = !ranked || council.status === 'concluded';

    // Power dial: reflect the stored level (don't fight an active drag).
    const power = this.el.querySelector('#cn-power');
    const stored = Number(council.config?.power) || 2;
    if (power && document.activeElement !== power && Number(power.value) !== stored) {
      power.value = stored;
      this._paintPowerLabel(stored);
    }
    this.el.querySelector('#cn-power-wrap').hidden = !live && council.status !== 'stopped';

    // The loud part: never let a paused council look like a dead one.
    const banner = this.el.querySelector('#cn-banner');
    if (council.status === 'quota_paused') {
      banner.hidden = false;
      banner.className = 'council-banner council-banner--warn';
      banner.innerHTML = `⏸ <strong>Model quota exhausted — the council is holding, not dead.</strong><br>
        It probes automatically and resumes the moment quota returns
        (<span id="cn-probe-eta" class="mono"></span>). Switching the AI brain in the topbar resumes it instantly. You can also hit <em>Conclude &amp; Verdict</em> once a brain is back to get the final report from the ${(council.stats?.matchesPlayed || 0)} matches already played.`;
    } else if (!banner.classList.contains('council-banner--flash')) {
      banner.hidden = true;
    }
  }

  /** 1s ticker: countdowns only. Touches two text nodes, nothing else. */
  _tick() {
    const council = this.detail?.council;
    if (!council || !this.el) return;
    const eta = this.el.querySelector('#cn-probe-eta');
    if (eta && council.next_probe_at) {
      const ms = new Date(council.next_probe_at).getTime() - Date.now();
      eta.textContent = ms > 0 ? `next probe in ${fmtCountdown(ms)}` : 'probing now…';
    }
    const cd = this.el.querySelector('#cn-countdown');
    if (cd) {
      const next = council.stats?.nextIterationAt;
      if (council.status === 'running' && next) {
        const ms = new Date(next).getTime() - Date.now();
        cd.textContent = ms > 500 ? `next round in ${fmtCountdown(ms)}` : 'in session…';
      } else if (council.status === 'running') {
        cd.textContent = 'in session…';
      } else {
        cd.textContent = '';
      }
    }
  }

  _paintBoard(council, hypotheses = []) {
    const host = this.el.querySelector('#cn-board');
    const criteria = (council.criteria || []).map(c => c.name);
    const rows = hypotheses.filter(h => h.status !== 'rejected').slice(0, 30);

    // Toolbar only matters once there are live proposals to clear.
    const activeCount = rows.filter(h => h.status === 'active').length;
    const toolbar = this.el.querySelector('#cn-board-toolbar');
    if (toolbar) toolbar.hidden = activeCount === 0;
    // Drop keep-marks for hypotheses that no longer exist / went inactive.
    const activeIds = new Set(rows.filter(h => h.status === 'active').map(h => h.id));
    for (const id of [...this._keep]) if (!activeIds.has(id)) this._keep.delete(id);
    this._paintKeepCount();

    if (!rows.length) return;

    const hint = this.el.querySelector('#cn-board-hint');
    if (hint) hint.textContent = criteria.length ? `Elo from pairwise judging on: ${criteria.join(' · ')}` : 'Elo from pairwise judging';

    // New-leader pulse: the moment a different hypothesis takes #1.
    const leader = rows.find(h => h.status === 'active');
    if (leader && this._lastLeader && leader.slug !== this._lastLeader) {
      this._flashBanner(`👑 NEW LEADER: ${leader.slug} “${trunc(leader.title, 70)}” takes #1 (elo ${Math.round(leader.elo)}).`, 'gold');
      this._fireStation('system', `👑 ${leader.slug} takes the lead`);
    }
    if (leader) this._lastLeader = leader.slug;

    const medal = (i) => i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
    host.classList.toggle('is-keep-mode', this._keepMode);
    host.innerHTML = rows.map((h, i) => {
      const open = this.expanded.has(h.id);
      const chips = this._scoreChips(h, criteria);
      const vetoed = h.status === 'vetoed';
      const kept = this._keep.has(h.id);
      const canKeep = h.status === 'active';
      return `
        <li class="council-hyp ${h.status !== 'active' ? 'council-hyp--retired' : ''} ${vetoed ? 'council-hyp--vetoed' : ''} ${i === 0 && !vetoed ? 'council-hyp--first' : ''} ${kept ? 'council-hyp--kept' : ''} ${open ? 'is-open' : ''}" data-hyp="${esc(h.id)}">
          <div class="council-hyp-row">
            ${canKeep ? `<button class="council-keep-box ${kept ? 'is-kept' : ''}" data-keep="${esc(h.id)}" title="${kept ? 'Kept — the council will favor & pivot toward this' : 'Check to KEEP this when clearing the board — the AI favors & pivots toward it'}" aria-label="keep">${kept ? '✓' : ''}</button>` : '<span class="council-keep-box council-keep-box--empty"></span>'}
            <span class="council-rank">${vetoed ? '⛔' : medal(i)}</span>
            <span class="council-elo mono">${Math.round(h.elo)}</span>
            <span class="council-hyp-title">${esc(h.slug)} · ${esc(h.title)}</span>
            <span class="council-hyp-meta mono">${h.wins}W-${h.losses}L</span>
            ${(h.images || []).length ? `<span class="council-tag" title="Shares ${h.images.length} photo${h.images.length > 1 ? 's' : ''}">🖼</span>` : ''}
            ${(h.sources || []).length ? `<span class="council-tag" title="${h.sources.length} cited source${h.sources.length > 1 ? 's' : ''}">🔗</span>` : ''}
            ${h.cluster ? `<span class="council-cluster" style="--cluster-hue:${clusterHue(h.cluster)}">${esc(trunc(h.cluster, 18))}</span>` : ''}
            ${h.origin === 'evolution' ? '<span class="council-tag" title="Evolved from a parent hypothesis">🧬</span>' : ''}
            ${Number(h.slop_risk) >= 5 ? `<span class="council-slop ${Number(h.slop_risk) >= 7 ? 'is-bad' : 'is-warn'}" title="Reflection's AI-slop risk score">🛡${Math.round(h.slop_risk)}</span>` : ''}
            ${h.status !== 'active' ? `<span class="council-tag council-tag--dim">${esc(h.status)}</span>` : ''}
            ${h.status === 'active' ? `<button class="council-veto-btn" data-veto="${esc(h.id)}" title="Veto — strike it and teach the council why">✕</button>` : ''}
          </div>
          <div class="council-hyp-detail" ${open ? '' : 'hidden'}>
            ${chips ? `<div class="council-scorebars">${chips}</div>` : ''}
            <p><strong>Statement.</strong> ${richText(h.statement)}</p>
            ${h.rationale ? `<p><strong>Rationale.</strong> ${richText(h.rationale)}</p>` : ''}
            ${h.critique ? `<p class="council-critique"><strong>Reflection.</strong> ${richText(h.critique)}</p>` : ''}
            ${imageStrip(h.images)}
            ${sourcesRow(h.sources)}
          </div>
        </li>`;
    }).join('');
  }

  /**
   * Cheap live refresh between full rebuilds: update only the Elo and W-L
   * text nodes in place. No innerHTML churn, no photo re-decode, no reflow
   * of 30 rich rows — so the leaderboard stays live without driving lag.
   */
  _updateBoardNumbers(council, hypotheses = []) {
    const host = this.el?.querySelector('#cn-board');
    if (!host) return;
    for (const h of hypotheses) {
      const li = host.querySelector(`[data-hyp="${cssEscape(h.id)}"]`);
      if (!li) continue;
      const elo = li.querySelector('.council-elo');
      if (elo) { const v = String(Math.round(h.elo)); if (elo.textContent !== v) elo.textContent = v; }
      const meta = li.querySelector('.council-hyp-meta');
      if (meta) { const v = `${h.wins}W-${h.losses}L`; if (meta.textContent !== v) meta.textContent = v; }
    }
  }

  // ── Operator purge: keep some, clear the rest, pivot ───────

  _paintKeepCount() {
    const el = this.el?.querySelector('#cn-keep-count');
    if (!el) return;
    const n = this._keep.size;
    el.hidden = n === 0;
    el.textContent = n ? `${n} to keep` : '';
    const purge = this.el?.querySelector('#cn-purge');
    if (purge) purge.textContent = n ? `🧹 Clear rest & pivot (keep ${n})` : '🧹 Clear all & pivot';
  }

  _toggleKeepMode() {
    this._keepMode = !this._keepMode;
    const btn = this.el.querySelector('#cn-keep-toggle');
    if (btn) {
      btn.classList.toggle('is-active', this._keepMode);
      btn.textContent = this._keepMode ? '✓ Marking keepers' : '✓ Mark keepers';
    }
    this.el.querySelector('#cn-board')?.classList.toggle('is-keep-mode', this._keepMode);
  }

  _toggleKeep(id) {
    if (this._keep.has(id)) this._keep.delete(id); else this._keep.add(id);
    if (this._keep.size && !this._keepMode) this._toggleKeepMode();
    const box = this.el.querySelector(`[data-keep="${cssEscape(id)}"]`);
    const li = this.el.querySelector(`[data-hyp="${cssEscape(id)}"]`);
    const kept = this._keep.has(id);
    if (box) { box.classList.toggle('is-kept', kept); box.textContent = kept ? '✓' : ''; }
    if (li) li.classList.toggle('council-hyp--kept', kept);
    this._paintKeepCount();
  }

  _openPurgeModal() {
    const actives = (this.detail?.hypotheses || []).filter(h => h.status === 'active');
    if (!actives.length) { this._flashBanner('Nothing to clear — no active proposals on the board.', 'warn'); return; }
    const keepIds = [...this._keep].filter(id => actives.some(h => h.id === id));
    const clearCount = actives.length - keepIds.length;
    const keptHyps = actives.filter(h => keepIds.includes(h.id));
    this._closePurgeModal();
    const overlay = document.createElement('div');
    overlay.className = 'veto-overlay';
    overlay.innerHTML = `
      <div class="veto-modal purge-modal">
        <div class="veto-head">🧹 Clear ${clearCount} proposed topic${clearCount === 1 ? '' : 's'} & pivot the council</div>
        <p class="veto-sub">
          ${clearCount} proposal${clearCount === 1 ? '' : 's'} will be cleared from the leaderboard immediately, and every
          council agent is told these directions were weak — they pivot on the next round.
          ${keptHyps.length
            ? `<br><strong>Keeping ${keptHyps.length}</strong> as the direction to favor: ${keptHyps.map(h => `<span class="purge-keep-chip">✓ ${esc(h.slug)} ${esc(trunc(h.title, 36))}</span>`).join(' ')}`
            : '<br>You haven\'t marked any to keep — the council will pivot to entirely new territory. Tip: ✕ this, check the ✓ boxes on ideas worth keeping, then clear.'}
        </p>
        <textarea class="veto-reason" rows="3" placeholder="Why did these miss? (optional — teaches the council your taste, e.g. “all too incremental, I want wilder swings”)"></textarea>
        <div class="veto-actions">
          <button class="cog-btn cog-btn-ghost" data-act="cancel">Cancel</button>
          <button class="cog-btn council-btn-purge" data-act="purge">🧹 Clear ${keptHyps.length ? 'the rest' : 'all'} &amp; pivot</button>
        </div>
      </div>`;
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) this._closePurgeModal(); });
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => this._closePurgeModal());
    overlay.querySelector('[data-act="purge"]').addEventListener('click', () => this._purge(keepIds, overlay));
    document.body.appendChild(overlay);
    this._purgeModalEl = overlay;
    overlay.querySelector('.veto-reason').focus();
  }

  async _purge(keepIds, overlay) {
    const btn = overlay.querySelector('[data-act="purge"]');
    const reason = overlay.querySelector('.veto-reason')?.value.trim() || '';
    btn.disabled = true;
    btn.textContent = '🧹 Clearing…';
    try {
      const result = await purgeCouncilProposals(this.councilId, keepIds, reason);
      this._closePurgeModal();
      this._keep.clear();
      this._fireStation('system', '🧹 Board cleared — pivoting');
      this._flashBanner(
        `🧹 <strong>Board cleared.</strong> ${result.cleared} proposal${result.cleared === 1 ? '' : 's'} struck`
        + `${result.kept ? ` · keeping ${result.keptSlugs.join(', ')} as the pivot direction — agents will favor ${result.kept === 1 ? 'it' : 'them'}` : ' · the council pivots to fresh territory'}.`,
        result.kept ? 'gold' : 'bad', 9000);
      this._prints.board = null;
      this._refreshDetail();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '🧹 Clear & pivot';
      this._flashBanner(`⚠ Clear failed: ${err.message}`, 'bad');
    }
  }

  _closePurgeModal() {
    if (this._purgeModalEl?.parentNode) this._purgeModalEl.parentNode.removeChild(this._purgeModalEl);
    this._purgeModalEl = null;
  }

  /** WS: a purge landed (possibly from another tab) — repaint fast. */
  onPurge(payload = {}) {
    if (!payload.councilId || payload.councilId !== this.councilId) return;
    this._fireStation('system', `🧹 ${(payload.cleared || []).length} proposals cleared — pivoting`);
    this._prints.board = null;
    this._refreshDetail();
  }

  _scoreChips(h, criteriaNames) {
    const scores = h.scores && Object.keys(h.scores).length
      ? h.scores
      : (h.novelty > 0 || h.plausibility > 0)
        ? { novelty: h.novelty, plausibility: h.plausibility }
        : null;
    if (!scores) return '';
    const names = criteriaNames.length ? criteriaNames.filter(n => scores[n] !== undefined) : Object.keys(scores);
    const list = names.length ? names : Object.keys(scores);
    return list.slice(0, 4).map(name => {
      const v = Number(scores[name]) || 0;
      return `
        <div class="council-scorebar" title="${esc(name)}: ${v.toFixed(1)}/10">
          <span class="council-scorebar-label">${esc(trunc(name, 14))}</span>
          <span class="council-scorebar-track"><span class="council-scorebar-fill" style="width:${Math.min(100, v * 10)}%"></span></span>
          <span class="council-scorebar-val mono">${v.toFixed(1)}</span>
        </div>`;
    }).join('');
  }

  _paintMatches(matches = []) {
    const host = this.el.querySelector('#cn-matches');
    if (!matches.length) return;
    host.innerHTML = matches.slice(0, 12).map(m => {
      const draw = !m.winner_id;
      const aWon = !draw && m.winner_id === m.a_id;
      const bWon = !draw && m.winner_id === m.b_id;
      const side = (slug, title, won) =>
        `<span class="council-side ${won ? 'is-winner' : ''}">${won ? '🏆 ' : ''}${esc(slug || '?')}<small> ${esc(trunc(title, 34))}</small></span>`;
      return `
        <li class="council-match">
          <div class="council-match-row">
            ${side(m.a_slug, m.a_title, aWon)}
            <span class="council-vs">${draw ? '⚖ draw' : 'vs'}</span>
            ${side(m.b_slug, m.b_title, bWon)}
          </div>
          ${m.rationale ? `<div class="council-match-why">${richText(m.rationale)}</div>` : ''}
        </li>`;
    }).join('');
  }

  _paintEvidence(evidence = []) {
    const host = this.el.querySelector('#cn-evidence-list');
    host.innerHTML = evidence.map(ev => {
      const c = ev.consensus || {};
      const body = ev.status === 'done'
        ? `${richText(c.summary || '')}${(c.agreedFindings || []).length ? `<ul>${c.agreedFindings.slice(0, 4).map(f => `<li>${richText(f)}</li>`).join('')}</ul>` : ''}`
        : `<em>${esc(ev.status)}…</em>`;
      return `
        <li class="council-ev">
          <div class="council-ev-head">
            <span class="council-tag ${ev.status === 'done' ? '' : 'council-tag--dim'}">${esc(ev.status)}</span>
            <span class="cog-run-meta">${new Date(ev.created_at + 'Z').toLocaleString()}</span>
          </div>
          ${imageStrip(ev.images)}
          <div class="council-ev-body">${body}</div>
        </li>`;
    }).join('');
  }

  _paintLog(events = []) {
    const el = this.el.querySelector('#cn-log');
    if (!el) return;
    // Debate events live in the Debate Chamber, not the raw activity log.
    // linkify() escapes everything itself, so innerHTML is safe here —
    // and source citations from the reality-check agents become clickable.
    el.innerHTML = events.filter(e => e.role !== 'debate').slice(-70)
      .map(e => `${ROLE_ICONS[e.role] || '·'} ${linkify(e.line)}`).join('\n');
    el.scrollTop = el.scrollHeight;
  }

  // ── Verdict hero ───────────────────────────────────────────
  _paintVerdict(council) {
    const host = this.el.querySelector('#cn-verdict');
    const v = council.verdict;
    if (!v || !v.winner) { host.hidden = true; return; }
    host.hidden = false;

    const podium = (v.ranking || []).slice(0, 3);
    const rest = (v.ranking || []).slice(3);
    const medals = ['🥇', '🥈', '🥉'];
    const card = (r, i) => `
      <div class="verdict-podium-card verdict-podium-card--${i}">
        <div class="verdict-medal">${medals[i] || ''}</div>
        <div class="verdict-podium-title">${esc(r.slug)} · ${esc(r.title)}</div>
        <div class="verdict-podium-tag">${esc(r.tagline || '')}</div>
        <div class="verdict-podium-meta mono">elo ${r.elo} · ${r.wins}W-${r.losses}L</div>
        ${Object.entries(r.criterionScores || {}).slice(0, 4).map(([name, score]) => `
          <div class="council-scorebar" title="${esc(name)}">
            <span class="council-scorebar-label">${esc(trunc(name, 12))}</span>
            <span class="council-scorebar-track"><span class="council-scorebar-fill" style="width:${Math.min(100, Number(score) * 10)}%"></span></span>
            <span class="council-scorebar-val mono">${Number(score).toFixed(0)}</span>
          </div>`).join('')}
        <div class="verdict-podium-points"><strong>+</strong> ${linkify(r.strongest || '')}</div>
        <div class="verdict-podium-points verdict-risk"><strong>!</strong> ${linkify(r.risk || '')}</div>
      </div>`;

    host.innerHTML = `
      <div class="verdict-head">
        <div class="verdict-gavel">🏛</div>
        <div>
          <div class="verdict-label">FINAL VERDICT · ${v.concludedAt ? new Date(v.concludedAt).toLocaleString() : ''}</div>
          <h2 class="verdict-winner">🏆 ${esc(v.winner.slug)} — ${esc(v.winner.title)}</h2>
          <p class="verdict-why">${linkify(v.winner.verdict)}</p>
        </div>
      </div>
      <div class="verdict-podium">${podium.map(card).join('')}</div>
      ${rest.length ? `<div class="verdict-rest">${rest.map((r, i) => `
        <div class="verdict-rest-row">
          <span class="council-rank">${i + 4}</span>
          <span class="council-hyp-title">${esc(r.slug)} · ${esc(r.title)}</span>
          <span class="council-hyp-meta mono">elo ${r.elo}</span>
          <span class="verdict-rest-tag">${esc(r.tagline || '')}</span>
        </div>`).join('')}</div>` : ''}
      <div class="verdict-synthesis">${renderMarkdown(v.synthesis || '')}</div>
      ${(v.nextSteps || []).length ? `
        <div class="cog-list-head">Next steps</div>
        <ul class="verdict-steps">${v.nextSteps.map(s => `<li>→ ${linkify(s)}</li>`).join('')}</ul>` : ''}
    `;
    host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ════════════════════════════════════════════════════════════
  //  Per-council hypothesis graph — the smooth canvas engine,
  //  exclusive to the active council (size=Elo, color=cluster).
  // ════════════════════════════════════════════════════════════

  async _refreshGraph() {
    if (!this.councilId || !this.el) return;
    let graph;
    try { graph = await getCouncilGraph(this.councilId); } catch { return; }
    if (!graph || !this.el) return;
    const host = this.el.querySelector('#cn-graph');
    if (!host) return;

    if (!graph.nodes.length) {
      if (this._graph) { this._graph.destroy(); this._graph = null; }
      host.innerHTML = '<div class="cog-empty">The graph grows as hypotheses are born, evolve and battle.</div>';
      this._graphCounts = '';
      return;
    }

    // Push to the canvas engine only when the visual content meaningfully
    // changed (a node born/retired/re-clustered, or an Elo tier shift) — NOT
    // on every 1-point Elo tick. The engine settles its physics once and then
    // costs nothing; re-feeding it every match kept it re-heating forever.
    const print = hash(JSON.stringify(
      graph.nodes.map(n => [n.id, Math.round(n.elo / 15), n.status, n.cluster, n.origin]).concat([graph.edges.length])
    ));
    if (print === this._graphCounts && this._graph) return;
    this._graphCounts = print;
    this._graphData = graph;

    if (!this._graph) {
      host.innerHTML = ''; // drop the empty placeholder
      this._graph = new CouncilGraph(host, {
        onNodeClick: (node, hostX, hostY) => this._showGraphPopover(node, hostX, hostY),
        onBackgroundClick: () => this._hideNodePopover(),
      });
    }
    this._graph.setData(graph);
    if (this._lineageOf) this._graph.highlightLineage(this._lineageOf);
  }

  /** Bridge the canvas node-click to the shared detail popover. */
  _showGraphPopover(node, hostX, hostY) {
    this._showNodePopover({ ...node, x: hostX, y: hostY }, '#cn-graph', { lineageBtn: true });
  }

  // ════════════════════════════════════════════════════════════
  //  EVOLUTION TREE — the growing forest of ideas
  //  Every hypothesis is planted in the ground; evolution children
  //  branch upward from their parents. Branches GROW in (animated
  //  path draw), nodes pop with an elastic ease, rejected ideas
  //  wither and shed falling leaves, and the champion wears a
  //  pulsing crown. The SVG persists across refreshes so updates
  //  are smooth transitions, never repaints.
  // ════════════════════════════════════════════════════════════

  async _refreshTree() {
    if (!this.councilId || !this.el) return;
    let data;
    try { data = await getCouncilTree(this.councilId); } catch { return; }
    const rows = data?.nodes || [];
    if (!this.el) return;
    // Repaint ONLY on a true structural change — a node born, withered,
    // re-parented or re-clustered. Elo is deliberately excluded: it moves on
    // every match, and keying the fingerprint to it re-ran the d3 SVG
    // transitions every few seconds, janking the whole council view. The
    // forest now animates exactly when its shape changes (the delightful
    // moment) and is otherwise free; node sizes + crown refresh on the next
    // structural change, which lands every generation round anyway.
    const print = hash(JSON.stringify(
      rows.map(n => [n.slug, n.status, n.parentSlug, n.cluster])
    ));
    if (print === this._treePrint) return;
    this._treePrint = print;
    this._drawTree(rows);
  }

  _drawTree(rows) {
    const host = this.el.querySelector('#cn-tree');
    if (!host) return;
    if (!rows.length) {
      host.innerHTML = '<div class="cog-empty">The forest is empty — convene a council and watch ideas take root. 🌱</div>';
      this._treeStatus = new Map();
      return;
    }

    const W = Math.max(640, host.clientWidth || 980);
    const H = 440;
    const PAD = 34;
    const groundY = H - 40;

    // ── Forest layout: a synthetic SOIL root under every founding idea ──
    const known = new Set(rows.map(r => r.slug));
    let root;
    try {
      root = d3.stratify()
        .id(d => d.slug)
        .parentId(d => (d.slug === '__soil__' ? null
          : (d.parentSlug && known.has(d.parentSlug) ? d.parentSlug : '__soil__')))(
          [{ slug: '__soil__' }, ...rows]
        );
    } catch { return; } // malformed lineage must never break the panel

    // Chronological forest: older roots stand to the left.
    root.sort((a, b) => (a.data.bornIteration || 0) - (b.data.bornIteration || 0)
      || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));

    const maxDepth = Math.max(1, ...root.descendants().map(n => n.depth));
    const levelH = maxDepth > 1 ? Math.min(96, (H - 150) / (maxDepth - 1)) : 96;

    d3.tree().size([W - PAD * 2, 1]).separation((a, b) => (a.parent === b.parent ? 1 : 1.4))(root);
    const nodes = root.descendants().filter(n => n.depth > 0);
    for (const n of nodes) {
      n.x = PAD + n.x;
      n.y = groundY - 30 - (n.depth - 1) * levelH;
    }

    // ── Visual vocabulary ──
    const rOf = h => Math.max(5, Math.min(18, 5 + (h.elo - 1170) / 10));
    const dotFill = h => {
      if (h.status === 'rejected' || h.status === 'vetoed') return 'rgba(150,126,96,0.55)';
      if (h.status === 'merged') return 'rgba(122,142,172,0.45)';
      if (h.status === 'archived') return h.cluster ? `hsla(${clusterHue(h.cluster)}, 40%, 46%, 0.4)` : 'rgba(0,240,255,0.28)';
      return h.cluster ? `hsla(${clusterHue(h.cluster)}, 90%, 60%, 0.92)` : 'rgba(0,240,255,0.85)';
    };
    const glowOf = h => (h.status === 'active'
      ? (h.cluster
        ? `hsla(${clusterHue(h.cluster)}, 95%, 62%, ${Math.min(0.9, 0.3 + Math.max(0, h.elo - 1185) / 140).toFixed(2)})`
        : 'rgba(0,240,255,0.55)')
      : 'transparent');
    const branchColor = h => {
      if (h.status === 'rejected' || h.status === 'vetoed') return 'rgba(150,126,96,0.32)';
      if (h.status === 'merged' || h.status === 'archived') return 'rgba(140,150,180,0.22)';
      return h.cluster ? `hsla(${clusterHue(h.cluster)}, 75%, 58%, 0.5)` : 'rgba(0,240,255,0.4)';
    };
    const branchW = h => Math.max(1.4, Math.min(6, 1.4 + (h.elo - 1170) / 55));
    const nodeClass = d => `tree-node${d.data.status !== 'active' ? ` is-retired tree-node--${d.data.status}` : ''}`;

    const actives = rows.filter(r => r.status === 'active').sort((a, b) => b.elo - a.elo);
    const champ = actives.find(r => r.matches > 0) || actives[0] || null;
    const top3 = new Set(actives.slice(0, 3).map(r => r.slug));

    // Big forests skip the grow/elastic/position transitions entirely: 750ms
    // of animated reflow on hundreds of SVG elements is what made the whole
    // view stutter. Below the threshold we keep the delightful animations.
    const animate = nodes.length <= 80;

    // ── Persistent SVG scaffold (created once, then only joined) ──
    let svg = d3.select(host).select('svg.council-tree-svg');
    if (svg.empty()) {
      host.innerHTML = '';
      svg = d3.select(host).append('svg').attr('class', 'council-tree-svg');
      svg.append('line').attr('class', 'tree-ground');
      svg.append('g').attr('class', 'tree-links');
      svg.append('g').attr('class', 'tree-nodes');
      svg.append('g').attr('class', 'tree-fx');
      svg.on('click', () => this._hideNodePopover());
    }
    svg.attr('viewBox', `0 0 ${W} ${H}`).attr('preserveAspectRatio', 'xMidYMax meet');
    svg.select('line.tree-ground')
      .attr('x1', PAD - 14).attr('x2', W - PAD + 14)
      .attr('y1', groundY).attr('y2', groundY);

    // ── Branches (lineage paths; roots sprout from the ground) ──
    const linkData = nodes.map(n => ({
      id: n.data.slug,
      target: n,
      sx: n.depth === 1 ? n.x : n.parent.x,
      sy: n.depth === 1 ? groundY + 2 : n.parent.y,
    }));
    const branchPath = d => {
      const tx = d.target.x, ty = d.target.y;
      const my = (d.sy + ty) / 2;
      return `M ${d.sx.toFixed(1)} ${d.sy.toFixed(1)} C ${d.sx.toFixed(1)} ${my.toFixed(1)}, ${tx.toFixed(1)} ${my.toFixed(1)}, ${tx.toFixed(1)} ${ty.toFixed(1)}`;
    };

    const links = svg.select('g.tree-links').selectAll('path.tree-branch').data(linkData, d => d.id);
    if (animate) links.exit().transition().duration(420).style('opacity', 0).remove();
    else links.exit().remove();

    const linksEnter = links.enter().append('path')
      .attr('fill', 'none')
      .attr('stroke-linecap', 'round')
      .attr('d', branchPath)
      .attr('stroke', d => branchColor(d.target.data))
      .attr('stroke-width', d => branchW(d.target.data));
    // The growth animation: each new branch draws itself from its parent.
    // Skipped on big forests — getTotalLength() forces a reflow per path.
    if (animate) linksEnter.each(function () {
      const len = this.getTotalLength ? this.getTotalLength() : 0;
      if (!len) return;
      d3.select(this)
        .attr('stroke-dasharray', `${len} ${len}`)
        .attr('stroke-dashoffset', len)
        .transition().duration(850).ease(d3.easeCubicOut)
        .attr('stroke-dashoffset', 0)
        .on('end', function () {
          d3.select(this).attr('stroke-dasharray', null).attr('stroke-dashoffset', null);
        });
    });

    const linksAll = linksEnter.merge(links)
      .attr('class', d => `tree-branch tree-branch--${d.target.data.status}`);
    (animate ? links.transition().duration(750).ease(d3.easeCubicInOut) : links)
      .attr('d', branchPath)
      .attr('stroke', d => branchColor(d.target.data))
      .attr('stroke-width', d => branchW(d.target.data));

    // ── Nodes ──
    const nodeSel = svg.select('g.tree-nodes').selectAll('g.tree-node').data(nodes, d => d.data.slug);
    if (animate) nodeSel.exit().transition().duration(420).style('opacity', 0).remove();
    else nodeSel.exit().remove();

    const nodeEnter = nodeSel.enter().append('g')
      .attr('transform', d => `translate(${d.x},${d.y})`)
      .style('opacity', animate ? 0 : 1);
    nodeEnter.append('circle').attr('class', 'tree-dot').attr('r', animate ? 0 : (d => rOf(d.data)));
    nodeEnter.append('text').attr('class', 'tree-slug').attr('text-anchor', 'middle');
    nodeEnter.append('text').attr('class', 'tree-title').attr('text-anchor', 'middle');
    nodeEnter.append('text').attr('class', 'tree-crown').attr('text-anchor', 'middle');
    nodeEnter.append('title');
    if (animate) {
      nodeEnter.transition().delay(380).duration(450).style('opacity', 1);
      nodeEnter.select('circle.tree-dot')
        .transition().delay(380).duration(750).ease(d3.easeElasticOut.amplitude(1).period(0.42))
        .attr('r', d => rOf(d.data));
    }

    const nodeAll = nodeEnter.merge(nodeSel).attr('class', nodeClass);
    (animate ? nodeSel.transition().duration(750).ease(d3.easeCubicInOut) : nodeSel)
      .attr('transform', d => `translate(${d.x},${d.y})`)
      .style('opacity', 1);
    (animate ? nodeSel.select('circle.tree-dot').transition().duration(750) : nodeSel.select('circle.tree-dot'))
      .attr('r', d => rOf(d.data));

    nodeAll.select('circle.tree-dot')
      .attr('fill', d => dotFill(d.data))
      .attr('stroke', d => (d.data.origin === 'evolution' ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.25)'))
      .attr('stroke-dasharray', d => (d.data.origin === 'evolution' ? '3 2' : null))
      .style('--glow', d => glowOf(d.data));
    nodeAll.select('text.tree-slug')
      .attr('dy', d => rOf(d.data) + 13)
      .text(d => d.data.slug);
    nodeAll.select('text.tree-title')
      .attr('dy', d => -rOf(d.data) - (champ && d.data.slug === champ.slug ? 24 : 9))
      .text(d => (top3.has(d.data.slug) ? trunc(d.data.title, 28) : ''));
    nodeAll.select('text.tree-crown')
      .attr('dy', d => -rOf(d.data) - 7)
      .text(d => (champ && d.data.slug === champ.slug ? '👑' : ''));
    nodeAll.classed('is-champion', d => Boolean(champ && d.data.slug === champ.slug));
    nodeAll.select('title').text(d =>
      `${d.data.slug} ${d.data.title}\nelo ${d.data.elo} · ${d.data.wins}W-${d.data.losses}L · ${d.data.status}`
      + `${d.data.cluster ? `\ncluster: ${d.data.cluster}` : ''}\nclick for details`);

    // ── Withering: ideas rejected since the last paint shed leaves ──
    for (const n of nodes) {
      const prev = this._treeStatus.get(n.data.slug);
      if (prev && prev !== n.data.status && (n.data.status === 'rejected' || n.data.status === 'vetoed')) {
        this._shedLeaves(svg, n, groundY);
      }
    }
    this._treeStatus = new Map(nodes.map(n => [n.data.slug, n.data.status]));

    // ── Interactivity: hover = sap line to the root, click = details ──
    nodeAll
      .on('mouseenter', (_e, d) => {
        const family = new Set(d.ancestors().map(a => a.data.slug));
        for (const c of d.descendants()) family.add(c.data.slug);
        family.delete('__soil__');
        nodeAll.classed('is-dim', n => !family.has(n.data.slug));
        linksAll
          .classed('is-sap', l => family.has(l.id))
          .classed('is-dim', l => !family.has(l.id));
      })
      .on('mouseleave', () => {
        nodeAll.classed('is-dim', false);
        linksAll.classed('is-sap', false).classed('is-dim', false);
      })
      .on('click', (e, d) => {
        e.stopPropagation();
        this._showNodePopover({ ...d.data, x: d.x, y: d.y }, '#cn-tree', { lineageBtn: false });
      });

    // Forest census in the card header.
    const hint = this.el.querySelector('#cn-tree-hint');
    if (hint) {
      hint.textContent = `${rows.length} ideas planted · ${actives.length} alive · ${maxDepth - 0} generation${maxDepth > 1 ? 's' : ''} deep`;
    }
  }

  /** A freshly-withered idea sheds a few falling leaves. Pure one-shot FX. */
  _shedLeaves(svg, n, groundY) {
    const fx = svg.select('g.tree-fx');
    for (let i = 0; i < 4; i += 1) {
      fx.append('circle')
        .attr('cx', n.x + (Math.random() * 16 - 8))
        .attr('cy', n.y + (Math.random() * 6 - 3))
        .attr('r', 1.8 + Math.random() * 1.8)
        .attr('fill', 'rgba(176,138,90,0.75)')
        .style('pointer-events', 'none')
        .transition()
        .delay(i * 140)
        .duration(1500 + Math.random() * 900)
        .ease(d3.easeQuadIn)
        .attr('cy', groundY - 2)
        .attr('cx', n.x + (Math.random() * 60 - 30))
        .style('opacity', 0)
        .remove();
    }
  }

  // ── Expandable node popover + lineage tracing ──────────────

  _showNodePopover(d, hostSel = '#cn-graph', { lineageBtn = true } = {}) {
    const host = this.el?.querySelector(hostSel);
    if (!host) return;
    this._hideNodePopover();

    const scoreChips = Object.entries(d.scores || {}).slice(0, 4).map(([name, v]) => `
      <div class="council-scorebar" title="${esc(name)}: ${Number(v).toFixed(1)}/10">
        <span class="council-scorebar-label">${esc(trunc(name, 12))}</span>
        <span class="council-scorebar-track"><span class="council-scorebar-fill" style="width:${Math.min(100, Number(v) * 10)}%"></span></span>
        <span class="council-scorebar-val mono">${Number(v).toFixed(1)}</span>
      </div>`).join('');

    const slop = Number(d.slopRisk) || 0;
    const pop = document.createElement('div');
    pop.className = 'cgraph-pop';
    pop.innerHTML = `
      <div class="cgraph-pop-head">
        <span class="cgraph-pop-slug mono">${esc(d.id)}</span>
        <span class="cgraph-pop-title">${esc(d.title)}</span>
        <button class="agent-drawer-x" data-act="close">✕</button>
      </div>
      <div class="cgraph-pop-meta mono">
        elo ${d.elo} · ${d.wins}W-${d.losses}L · born iter ${d.bornIteration ?? '?'}
        ${d.parentSlug ? ` · 🧬 child of ${esc(d.parentSlug)}` : ''}
        ${d.status !== 'active' ? ` · ${esc(d.status)}` : ''}
      </div>
      <div class="cgraph-pop-chips">
        ${d.cluster ? `<span class="council-cluster" style="--cluster-hue:${clusterHue(d.cluster)}">${esc(trunc(d.cluster, 22))}</span>` : ''}
        ${slop ? `<span class="council-slop ${slop >= 7 ? 'is-bad' : slop >= 5 ? 'is-warn' : ''}" title="Reflection's AI-slop risk score">🛡 slop ${slop}/10</span>` : ''}
      </div>
      ${d.statement ? `<p class="cgraph-pop-statement">${richText(d.statement)}</p>` : ''}
      ${d.critique ? `<p class="cgraph-pop-critique">🔍 ${esc(trunc(d.critique, 220))}</p>` : ''}
      ${scoreChips ? `<div class="council-scorebars">${scoreChips}</div>` : ''}
      ${imageStrip(d.images)}
      ${sourcesRow(d.sources)}
      <div class="cgraph-pop-actions">
        <button class="cog-btn" data-act="board">📋 Open in leaderboard</button>
        ${lineageBtn ? `<button class="cog-btn cog-btn-ghost ${this._lineageOf === d.id ? 'is-active' : ''}" data-act="lineage">🧬 ${this._lineageOf === d.id ? 'Clear lineage' : 'Trace lineage'}</button>` : ''}
      </div>
    `;
    host.appendChild(pop);

    // Position beside the node, clamped inside the host.
    const rect = pop.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    let x = (d.x || 0) + 18;
    let y = (d.y || 0) - rect.height / 2;
    if (x + rect.width > hostRect.width - 8) x = (d.x || 0) - rect.width - 18;
    x = Math.max(8, Math.min(x, hostRect.width - rect.width - 8));
    y = Math.max(8, Math.min(y, hostRect.height - rect.height - 8));
    pop.style.left = `${x}px`;
    pop.style.top = `${y}px`;
    this._popoverEl = pop;

    pop.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'close') this._hideNodePopover();
      else if (act === 'board') {
        const hyp = (this.detail?.hypotheses || []).find(h => h.slug === d.id);
        if (hyp) {
          this.expanded.add(hyp.id);
          this._prints.board = null;
          this._paintBoard(this.detail.council, this.detail.hypotheses);
          this.el.querySelector(`[data-hyp="${cssEscape(hyp.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } else if (act === 'lineage') {
        if (this._lineageOf === d.id) this._clearLineage();
        else { this._lineageOf = d.id; this._applyLineage(d.id); }
        this._showNodePopover(d, hostSel, { lineageBtn }); // re-render button state
      }
    });
  }

  _hideNodePopover() {
    if (this._popoverEl) { this._popoverEl.remove(); this._popoverEl = null; }
  }

  /** Light a hypothesis's whole family in the canvas graph; dim the rest. */
  _applyLineage(slug) {
    this._lineageOf = slug;
    this._graph?.highlightLineage(slug);
  }

  _clearLineage() {
    this._lineageOf = null;
    this._graph?.clearLineage();
  }

  // ── Small UI helpers ───────────────────────────────────────

  _setStatusPill(status) {
    const pill = this.el?.querySelector('#cn-state');
    if (!pill || !status) return;
    const [label, mood] = STATUS_LABELS[status] || [status, ''];
    pill.textContent = label;
    pill.className = `cog-pill ${mood ? `cog-pill--${mood}` : ''}`;
  }

  _flashBanner(html, mood = 'warn', hideAfterMs = 6000) {
    const banner = this.el?.querySelector('#cn-banner');
    if (!banner) return;
    banner.hidden = false;
    banner.className = `council-banner council-banner--${mood} council-banner--flash`;
    banner.innerHTML = html;
    clearTimeout(this._bannerTimer);
    if (hideAfterMs > 0) this._bannerTimer = setTimeout(() => this._hideBanner(), hideAfterMs);
  }

  _hideBanner() {
    const banner = this.el?.querySelector('#cn-banner');
    if (banner) { banner.hidden = true; banner.classList.remove('council-banner--flash'); }
  }

  destroy() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this._tickTimer) clearInterval(this._tickTimer);
    if (this._graph) { this._graph.destroy(); this._graph = null; }
    clearTimeout(this._traitDebounce);
    this._closeMenu();
    this._closeDrawer();
    this._closeVetoModal();
    this._closePurgeModal();
    for (const t of Object.values(this._stationTimers)) clearTimeout(t);
    if (this.el?.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = null;
  }
}

// ── Pure helpers ─────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Escape-safe linkifier: agent output often cites real URLs (falsification
// probes, deep verification, web-grounded rationales). Everything is HTML-
// escaped exactly like esc(); URLs additionally become anchors that open
// in a new window. Drop-in replacement for esc() on body text.
const URL_RE = /https?:\/\/[^\s<>"'`\])]+/g;
function linkify(s) {
  const str = String(s ?? '');
  let out = '';
  let last = 0;
  for (const m of str.matchAll(URL_RE)) {
    out += esc(str.slice(last, m.index));
    // Trailing sentence punctuation belongs to the prose, not the URL.
    const url = m[0].replace(/[.,;:!?…»”]+$/, '');
    const tail = m[0].slice(url.length);
    const label = trunc(url.replace(/^https?:\/\/(www\.)?/, ''), 42);
    out += `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(url)}">${esc(label)}</a>${esc(tail)}`;
    last = m.index + m[0].length;
  }
  out += esc(str.slice(last));
  return out;
}

// Rich body renderer for agent prose: clickable links AND shared media.
// Handles markdown images ![alt](url), markdown links [text](url), bare
// image URLs (rendered as thumbnails) and bare links — all HTML-escaped.
// A broken/fabricated image URL removes itself on error, so a hallucinated
// link never leaves a broken-image icon behind.
const RICH_RE = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"'`\])]+)/g;
const RICH_IMG_EXT = /\.(png|jpe?g|gif|webp|svg|avif)(\?[^\s]*)?$/i;

function richText(s) {
  const str = String(s ?? '');
  let out = '';
  let last = 0;
  for (const m of str.matchAll(RICH_RE)) {
    out += esc(str.slice(last, m.index));
    if (m[2] !== undefined) {            // ![alt](url) — markdown image
      out += imgTag(m[2], m[1]);
    } else if (m[4] !== undefined) {     // [text](url) — markdown link
      out += anchorTag(m[4], m[3]);
    } else if (m[5] !== undefined) {     // bare URL (maybe an image)
      const url = m[5].replace(/[.,;:!?…»")]+$/, '');
      const tail = m[5].slice(url.length);
      out += (RICH_IMG_EXT.test(url) ? imgTag(url) : anchorTag(url)) + esc(tail);
    }
    last = m.index + m[0].length;
  }
  out += esc(str.slice(last));
  return out;
}

function anchorTag(url, label) {
  const text = label || trunc(url.replace(/^https?:\/\/(www\.)?/, ''), 42);
  return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow" title="${esc(url)}">${esc(text)}</a>`;
}

function imgTag(url, alt = '') {
  return `<a class="rich-img-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">`
    + `<img class="rich-img" src="${esc(url)}" alt="${esc(alt || 'shared image')}" loading="lazy" referrerpolicy="no-referrer"`
    + ` onerror="this.closest('.rich-img-link').remove()" /></a>`;
}

/** A row of photo thumbnails an agent or the operator shared. */
function imageStrip(images) {
  const list = (Array.isArray(images) ? images : []).filter(u => typeof u === 'string' && u).slice(0, 6);
  if (!list.length) return '';
  return `<div class="council-img-strip">${list.map(u => imgTag(u)).join('')}</div>`;
}

/** A compact row of source chips (the domains an agent grounded a claim in). */
function sourcesRow(sources) {
  const list = (Array.isArray(sources) ? sources : []).filter(u => typeof u === 'string' && u).slice(0, 6);
  if (!list.length) return '';
  return `<div class="council-sources"><span class="council-sources-label">🔗 sources</span>`
    + list.map(u => {
      let host = u;
      try { host = new URL(u).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
      return `<a class="council-source-chip" href="${esc(u)}" target="_blank" rel="noopener noreferrer nofollow" title="${esc(u)}">${esc(trunc(host, 28))}</a>`;
    }).join('')
    + `</div>`;
}

function trunc(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return String(h);
}

function clusterHue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

function fmtCountdown(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour12: false });
  } catch { return ''; }
}

/** SVG arc segment around (cx,cy) — used by the trait halos. */
function arcPath(cx, cy, r, a0, a1) {
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

// Minimal safe markdown (headings, bold, lists) for the synthesis report.
function renderMarkdown(md) {
  const out = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const line of String(md || '').split('\n')) {
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { closeList(); out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`); continue; }
    const li = line.match(/^\s*[-*•]\s+(.*)/);
    if (li) { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    closeList();
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
  function inline(s) {
    return linkify(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }
}

export default CouncilPanel;
