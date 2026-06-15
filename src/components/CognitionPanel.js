/* ═══════════════════════════════════════════════════════════════════
   HERMES OS — Cognition Panel
   Deep research (plan → web search → synthesize → report) and the
   dream loop (seed → diverge → critique → evolve → reflect), live.
   ═══════════════════════════════════════════════════════════════════ */

import {
  startResearch, runDreamCycle, getRuns, getIdeas, getArtifact, getArtifacts,
  getHermesStatus, updateHermesConfig,
} from '../utils/api.js';

const RESEARCH_PHASES = ['plan', 'gather', 'synthesize', 'integrate', 'done'];
const DREAM_PHASES = ['seed', 'diverge', 'critique', 'evolve', 'reflect', 'done'];

export class CognitionPanel {
  constructor(container) {
    this.container = container;
    this.el = null;
    this.researchLog = [];
    this.dreamLog = [];
    this.dreamEnabled = false;
    this.currentArtifactId = null;
  }

  async init() {
    this.render();
    await Promise.allSettled([
      this._loadStatus(),
      this._loadRuns(),
      this._loadIdeas(),
      this._loadArtifacts(),
    ]);
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'cognition';
    this.el.innerHTML = `
      <div class="cog-columns">

        <!-- ── DEEP RESEARCH ─────────────────────────────────── -->
        <section class="card cog-card cog-research">
          <div class="cog-head">
            <h3>📚 Deep Research</h3>
            <span class="cog-pill" id="cog-research-state">idle</span>
          </div>
          <p class="cog-sub">Ask anything. Hermes plans sub-questions, searches the live web, and writes a cited report into your knowledge graph.</p>
          <div class="cog-ask">
            <input type="text" id="cog-question" placeholder="e.g. What are the breakthrough battery chemistries to watch?" />
            <select id="cog-depth" title="Research depth">
              <option value="quick">Quick</option>
              <option value="standard" selected>Standard</option>
              <option value="deep">Deep</option>
            </select>
            <button id="cog-research-btn" class="cog-btn">Research</button>
          </div>

          <div class="cog-progress" id="cog-research-progress" hidden>
            <div class="cog-phases" id="cog-research-phases"></div>
            <div class="cog-bar"><div class="cog-bar-fill" id="cog-research-bar"></div></div>
            <pre class="cog-log mono" id="cog-research-log"></pre>
          </div>

          <div class="cog-report" id="cog-report" hidden>
            <div class="cog-report-head">
              <h4 id="cog-report-title"></h4>
              <button class="cog-btn cog-btn-ghost" id="cog-report-close">✕</button>
            </div>
            <div class="cog-md" id="cog-report-body"></div>
          </div>

          <div class="cog-list-head">Reports</div>
          <ul class="cog-runs" id="cog-artifacts"><li class="cog-empty">No research yet — ask your first question above.</li></ul>
        </section>

        <!-- ── DREAM LOOP ────────────────────────────────────── -->
        <section class="card cog-card cog-dream">
          <div class="cog-head">
            <h3>💭 Dream Loop</h3>
            <span class="cog-pill" id="cog-dream-state">idle</span>
          </div>
          <p class="cog-sub">Autonomous idea engine: diverge → critique → evolve → act. Every 4th cycle Hermes rewrites its own directives.</p>

          <div class="cog-dream-controls">
            <label class="cog-toggle">
              <input type="checkbox" id="cog-dream-enabled" />
              <span class="cog-toggle-track"><span class="cog-toggle-thumb"></span></span>
              <span class="cog-toggle-label">Auto-dream</span>
            </label>
            <input type="text" id="cog-dream-focus" placeholder="Focus (optional) — e.g. my YouTube channel growth" />
            <button id="cog-dream-btn" class="cog-btn">Dream now</button>
          </div>

          <div class="cog-progress" id="cog-dream-progress" hidden>
            <div class="cog-phases" id="cog-dream-phases"></div>
            <div class="cog-bar"><div class="cog-bar-fill" id="cog-dream-bar"></div></div>
            <pre class="cog-log mono" id="cog-dream-log"></pre>
          </div>

          <div class="cog-list-head">Idea ledger <span class="cog-list-hint">scored by the critic: novelty · feasibility · value</span></div>
          <ul class="cog-ideas" id="cog-ideas"><li class="cog-empty">No ideas yet — run a dream cycle.</li></ul>

          <div class="cog-list-head">Self-written directives</div>
          <ul class="cog-directives" id="cog-directives"><li class="cog-empty">None yet — Hermes writes these itself during reflection.</li></ul>
        </section>
      </div>
    `;
    this.container.appendChild(this.el);

    this._renderPhaseChips('cog-research-phases', RESEARCH_PHASES, null);
    this._renderPhaseChips('cog-dream-phases', DREAM_PHASES, null);

    // ── Bindings ──
    const q = this.el.querySelector('#cog-question');
    this.el.querySelector('#cog-research-btn').addEventListener('click', () => this._startResearch());
    q.addEventListener('keydown', e => { if (e.key === 'Enter') this._startResearch(); });
    this.el.querySelector('#cog-dream-btn').addEventListener('click', () => this._dreamNow());
    this.el.querySelector('#cog-report-close').addEventListener('click', () => this._hideReport());
    this.el.querySelector('#cog-dream-enabled').addEventListener('change', (e) => this._setDreamEnabled(e.target.checked));
    const focus = this.el.querySelector('#cog-dream-focus');
    focus.addEventListener('change', () => {
      updateHermesConfig({ dreamFocus: focus.value.trim() }).catch(() => {});
    });
  }

  // ── Live WebSocket hooks (routed from main.js) ────────────────
  onResearchUpdate(payload = {}) {
    this._paintRun('research', payload);
    if (payload.status === 'done') {
      this._loadArtifacts();
      this._loadRuns();
      if (payload.result?.artifactId) this._openArtifact(payload.result.artifactId);
    }
    if (payload.status === 'failed') this._setPill('cog-research-state', 'failed', 'bad');
  }

  onDreamUpdate(payload = {}) {
    this._paintRun('dream', payload);
    if (payload.ideas) this._loadIdeas();
    if (payload.status === 'done') { this._loadStatus(); this._loadIdeas(); }
    if (payload.status === 'failed') this._setPill('cog-dream-state', 'failed', 'bad');
  }

  onStatus(status = {}) {
    const agent = status.agent || {};
    this._applyAgentStatus(agent);
  }

  // ── Actions ────────────────────────────────────────────────────
  async _startResearch() {
    const input = this.el.querySelector('#cog-question');
    const question = input.value.trim();
    if (!question) { input.focus(); return; }
    const depth = this.el.querySelector('#cog-depth').value;
    const btn = this.el.querySelector('#cog-research-btn');
    btn.disabled = true;
    this.researchLog = [];
    this._hideReport();
    try {
      await startResearch(question, depth);
      input.value = '';
      this._setPill('cog-research-state', 'running', 'live');
      this.el.querySelector('#cog-research-progress').hidden = false;
    } catch (err) {
      this._appendLog('research', `⚠ ${err.message}`);
      this._setPill('cog-research-state', 'error', 'bad');
      this.el.querySelector('#cog-research-progress').hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  async _dreamNow() {
    const btn = this.el.querySelector('#cog-dream-btn');
    btn.disabled = true;
    this.dreamLog = [];
    try {
      await runDreamCycle();
      this._setPill('cog-dream-state', 'dreaming', 'live');
      this.el.querySelector('#cog-dream-progress').hidden = false;
    } catch (err) {
      this._appendLog('dream', `⚠ ${err.message}`);
      this.el.querySelector('#cog-dream-progress').hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  async _setDreamEnabled(on) {
    this.dreamEnabled = on;
    try { await updateHermesConfig({ dreamLoopEnabled: on }); } catch { /* ignore */ }
    this._setPill('cog-dream-state', on ? 'armed' : 'idle', on ? 'live' : '');
  }

  // ── Run painting ───────────────────────────────────────────────
  _paintRun(kind, payload) {
    const phases = kind === 'research' ? RESEARCH_PHASES : DREAM_PHASES;
    const wrap = this.el?.querySelector(`#cog-${kind}-progress`);
    if (!wrap) return;
    wrap.hidden = false;
    this._renderPhaseChips(`cog-${kind}-phases`, phases, payload.phase);
    const bar = this.el.querySelector(`#cog-${kind}-bar`);
    if (bar && payload.progress !== undefined) bar.style.width = `${Math.max(2, Math.min(100, payload.progress))}%`;
    if (payload.line) this._appendLog(kind, payload.line);
    if (payload.status === 'done') {
      this._setPill(`cog-${kind}-state`, 'done', 'ok');
    } else if (payload.status === 'running' || !payload.status) {
      this._setPill(`cog-${kind}-state`, payload.phase || 'running', 'live');
    }
  }

  _appendLog(kind, line) {
    const store = kind === 'research' ? this.researchLog : this.dreamLog;
    store.push(line);
    const el = this.el?.querySelector(`#cog-${kind}-log`);
    if (el) {
      el.textContent = store.slice(-40).join('\n');
      el.scrollTop = el.scrollHeight;
    }
  }

  _renderPhaseChips(hostId, phases, active) {
    const host = this.el?.querySelector(`#${hostId}`);
    if (!host) return;
    const activeIdx = phases.indexOf(active);
    host.innerHTML = phases.map((p, i) => {
      const cls = i < activeIdx ? 'is-past' : i === activeIdx ? 'is-active' : '';
      return `<span class="cog-phase ${cls}">${p}</span>`;
    }).join('<span class="cog-phase-sep">→</span>');
  }

  _setPill(id, text, mood = '') {
    const pill = this.el?.querySelector(`#${id}`);
    if (!pill) return;
    pill.textContent = text;
    pill.className = `cog-pill ${mood ? `cog-pill--${mood}` : ''}`;
  }

  // ── Data loads ────────────────────────────────────────────────
  async _loadStatus() {
    try {
      const status = await getHermesStatus();
      this._applyAgentStatus(status.agent || {});
    } catch { /* offline */ }
  }

  _applyAgentStatus(agent) {
    const toggle = this.el?.querySelector('#cog-dream-enabled');
    if (toggle) {
      this.dreamEnabled = Boolean(agent.dreamLoopEnabled);
      toggle.checked = this.dreamEnabled;
    }
    const focus = this.el?.querySelector('#cog-dream-focus');
    if (focus && document.activeElement !== focus && agent.dreamFocus !== undefined) {
      focus.value = agent.dreamFocus || '';
    }
    if (agent.dreamActive) this._setPill('cog-dream-state', 'dreaming', 'live');
    else if (this.dreamEnabled) this._setPill('cog-dream-state', 'armed', 'live');
    if (agent.researchActive) this._setPill('cog-research-state', 'running', 'live');

    const host = this.el?.querySelector('#cog-directives');
    if (host) {
      const list = Array.isArray(agent.selfDirectives) ? agent.selfDirectives : [];
      host.innerHTML = list.length
        ? list.map(d => `<li>◈ ${esc(d)}</li>`).join('')
        : '<li class="cog-empty">None yet — Hermes writes these itself during reflection.</li>';
    }
  }

  async _loadRuns() {
    try {
      const runs = await getRuns('research', 8);
      const active = (runs || []).find(r => r.status === 'running');
      if (active) {
        this._setPill('cog-research-state', active.phase || 'running', 'live');
        const wrap = this.el.querySelector('#cog-research-progress');
        wrap.hidden = false;
        this.researchLog = (active.log || []).map(l => l.line);
        this._appendLog('research', '');
        this._renderPhaseChips('cog-research-phases', RESEARCH_PHASES, active.phase);
      }
    } catch { /* ignore */ }
  }

  async _loadIdeas() {
    try {
      const ideas = await getIdeas('total', 14);
      const host = this.el?.querySelector('#cog-ideas');
      if (!host) return;
      if (!ideas?.length) return;
      host.innerHTML = ideas.map(i => `
        <li class="cog-idea" title="${esc(i.critique || '')}">
          <div class="cog-idea-main">
            <span class="cog-idea-title">${esc(i.title)}</span>
            <span class="cog-idea-status cog-idea-status--${esc(i.status)}">${esc(i.status)}</span>
          </div>
          <div class="cog-idea-body">${esc(String(i.content).slice(0, 200))}</div>
          <div class="cog-idea-scores">
            <span title="novelty">N ${i.novelty}</span>
            <span title="feasibility">F ${i.feasibility}</span>
            <span title="value">V ${i.value}</span>
            <span class="cog-idea-total" title="total">Σ ${i.total}</span>
          </div>
        </li>`).join('');
    } catch { /* ignore */ }
  }

  async _loadArtifacts() {
    try {
      const artifacts = await getArtifacts(10);
      const host = this.el?.querySelector('#cog-artifacts');
      if (!host) return;
      if (!artifacts?.length) return;
      host.innerHTML = artifacts.map(a => `
        <li class="cog-run" data-artifact="${esc(a.id)}">
          <span class="cog-run-title">${esc(a.title)}</span>
          <span class="cog-run-meta">${new Date(a.created_at + 'Z').toLocaleString()}</span>
        </li>`).join('');
      host.querySelectorAll('[data-artifact]').forEach(li => {
        li.addEventListener('click', () => this._openArtifact(li.dataset.artifact));
      });
    } catch { /* ignore */ }
  }

  async _openArtifact(id) {
    try {
      const artifact = await getArtifact(id);
      if (!artifact) return;
      this.currentArtifactId = id;
      this.el.querySelector('#cog-report-title').textContent = artifact.title;
      this.el.querySelector('#cog-report-body').innerHTML = renderMarkdown(artifact.content);
      this.el.querySelector('#cog-report').hidden = false;
      this.el.querySelector('#cog-report').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch { /* ignore */ }
  }

  _hideReport() {
    const r = this.el?.querySelector('#cog-report');
    if (r) r.hidden = true;
    this.currentArtifactId = null;
  }

  destroy() {
    if (this.el?.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = null;
  }
}

// ── Tiny safe markdown renderer (headings, bold, code, lists, links) ──
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderMarkdown(md) {
  const lines = String(md || '').split('\n');
  const out = [];
  let inList = false;
  let inCode = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

  for (const raw of lines) {
    const line = raw;
    if (/^```/.test(line.trim())) {
      closeList();
      inCode = !inCode;
      out.push(inCode ? '<pre class="cog-code mono">' : '</pre>');
      continue;
    }
    if (inCode) { out.push(esc(line)); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { closeList(); out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`); continue; }
    const li = line.match(/^\s*[-*•]\s+(.*)/);
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)/);
    if (ol) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li><span class="cog-md-num">${ol[1]}.</span> ${inline(ol[2])}</li>`);
      continue;
    }
    closeList();
    if (!line.trim()) { out.push(''); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (inCode) out.push('</pre>');
  return out.join('\n');

  function inline(s) {
    let t = esc(s);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return t;
  }
}

export default CognitionPanel;
