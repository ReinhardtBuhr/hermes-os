// ─────────────────────────────────────────────────────────────
// Hermes OS — Cognition Engine
// The loop machinery that makes Hermes feel alive:
//
//   RESEARCH  plan → gather (live web search) → synthesize → integrate
//   DREAM     seed → diverge → critique → evolve → act → reflect
//
// Both are multi-call LLM pipelines over the Gemini brain. Every stage
// streams progress to the dashboard over WebSocket, writes durable
// records (runs, ideas, artifacts, memories, graph nodes), and the
// reflect stage lets Hermes rewrite its own operating directives —
// bounded self-improvement.
// ─────────────────────────────────────────────────────────────

import { extractJson } from './brain.js';

const DEPTH_SUBQUESTIONS = { quick: 2, standard: 3, deep: 5 };
const REFLECT_EVERY = 4; // run a self-reflection stage every Nth dream cycle

export class CognitionEngine {
  /**
   * @param {object} deps
   * @param {object} deps.db          database module
   * @param {object} deps.brain       Brain instance
   * @param {Function} deps.broadcast wsBroadcast(message)
   * @param {Function} deps.applyActions  (actions, meta) => applied[]  (HermesAgent._applyActions)
   * @param {Function} deps.getConfig () => hermes config
   * @param {Function} deps.ensureNode / ensureEdge  graph helpers from the agent
   */
  constructor({ db, brain, broadcast, applyActions, getConfig, ensureNode, ensureEdge }) {
    this.db = db;
    this.brain = brain;
    this.broadcast = broadcast || (() => {});
    this.applyActions = applyActions || (() => []);
    this.getConfig = getConfig || (() => ({}));
    this.ensureNode = ensureNode || (() => null);
    this.ensureEdge = ensureEdge || (() => null);
    this.researchActive = false;
    this.dreamActive = false;
  }

  // ════════════════════════════════════════════════════════════
  //  DEEP RESEARCH
  // ════════════════════════════════════════════════════════════

  /**
   * Kick off a research pipeline. Returns the run record immediately;
   * the pipeline continues in the background and streams progress.
   */
  startResearch(question, { depth, origin = 'chat' } = {}) {
    const q = String(question || '').trim();
    if (!q) return { error: 'empty_question' };
    if (this.researchActive) return { error: 'research_busy', message: 'A research run is already in progress.' };
    if (!this.brain.status().ready) return { error: 'brain_offline', message: 'The Gemini brain is not connected.' };

    const runDepth = DEPTH_SUBQUESTIONS[depth] ? depth : (this.getConfig().researchDepth || 'standard');
    const run = this.db.addHermesRun({ kind: 'research', title: q.slice(0, 120), phase: 'plan' });
    this.researchActive = true;

    this._researchPipeline(run.id, q, runDepth, origin)
      .catch(err => {
        console.error('[Cognition] research pipeline crashed:', err);
        this._update(run.id, 'research', { status: 'failed', phase: 'error', line: `Pipeline crashed: ${err.message}` });
      })
      .finally(() => { this.researchActive = false; });

    return { run };
  }

  async _researchPipeline(runId, question, depth, origin) {
    const subCount = DEPTH_SUBQUESTIONS[depth] || 3;

    // ── Phase 1: PLAN ─────────────────────────────────────────
    this._update(runId, 'research', { phase: 'plan', progress: 5, line: `Decomposing: "${question}"` });
    const plan = await this._json({
      system: this._cognitionPersona()
        + '\nYou are planning a deep-research run. Respond ONLY with JSON.',
      prompt: [
        `Research question: ${question}`,
        '',
        `Break this into exactly ${subCount} sharp sub-questions that together answer it.`,
        'Each sub-question must be independently searchable on the live web.',
        'JSON schema: {"title":"<short run title>","subQuestions":["..."]}',
      ].join('\n'),
      timeoutMs: 90000,
    });
    if (!plan || !Array.isArray(plan.subQuestions) || !plan.subQuestions.length) {
      return this._update(runId, 'research', { status: 'failed', phase: 'plan', line: 'Could not produce a research plan.' });
    }
    const title = String(plan.title || question).slice(0, 120);
    const subQuestions = plan.subQuestions.slice(0, subCount).map(String);
    this.db.updateHermesRun(runId, { title });
    this._update(runId, 'research', {
      phase: 'gather', progress: 12,
      line: `Plan ready — ${subQuestions.length} sub-questions:\n${subQuestions.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`,
    });

    // ── Phase 2: GATHER (live web search per sub-question) ────
    const findings = [];
    for (let i = 0; i < subQuestions.length; i++) {
      const sq = subQuestions[i];
      const pct = 12 + Math.round(((i) / subQuestions.length) * 55);
      this._update(runId, 'research', { phase: 'gather', progress: pct, line: `Searching the web: ${sq}` });

      const found = await this._json({
        system: this._cognitionPersona()
          + '\nYou are a research analyst with live web access. Use the google_web_search tool to find CURRENT information before answering. Respond ONLY with JSON.',
        prompt: [
          `Sub-question: ${sq}`,
          `(Parent research question: ${question})`,
          '',
          'Search the web, then distill what you found.',
          'JSON schema: {"summary":"2-4 sentence answer","facts":["specific fact with numbers/names where possible", ...],"sources":[{"title":"...","url":"..."}]}',
          'Give 3-6 facts and up to 4 sources.',
        ].join('\n'),
        timeoutMs: 180000,
        webSearch: true,
      });

      if (found && found.summary) {
        findings.push({ question: sq, ...found });
        this._update(runId, 'research', {
          phase: 'gather', progress: pct + Math.round(55 / subQuestions.length),
          line: `✓ ${sq}\n   ${String(found.summary).slice(0, 220)}`,
        });
      } else {
        findings.push({ question: sq, summary: '(no grounded answer retrieved)', facts: [], sources: [] });
        this._update(runId, 'research', { phase: 'gather', progress: pct, line: `△ No grounded result for: ${sq}` });
      }
    }

    // ── Phase 3: SYNTHESIZE ───────────────────────────────────
    this._update(runId, 'research', { phase: 'synthesize', progress: 72, line: 'Synthesizing findings into a report…' });
    const synthesis = await this._json({
      system: this._cognitionPersona()
        + '\nYou are writing the final research report. Respond ONLY with JSON.',
      prompt: [
        `Research question: ${question}`,
        '',
        'Findings from live web research:',
        JSON.stringify(findings, null, 1).slice(0, 14000),
        '',
        'Write the deliverable. JSON schema:',
        '{"report":"<full markdown report: ## sections, cite sources inline as [n] matching the source list, end with a ## Sources section>",',
        ' "keyInsights":["the 3-5 most important takeaways"],',
        ' "novelAngles":["1-3 genuinely novel ideas, connections or contrarian angles this research suggests"],',
        ' "openQuestions":["1-3 follow-up questions worth researching next"]}',
      ].join('\n'),
      timeoutMs: 150000,
    });
    if (!synthesis || !synthesis.report) {
      return this._update(runId, 'research', { status: 'failed', phase: 'synthesize', line: 'Synthesis failed — findings were collected but the report could not be written.' });
    }

    // ── Phase 4: INTEGRATE ────────────────────────────────────
    this._update(runId, 'research', { phase: 'integrate', progress: 88, line: 'Integrating into knowledge graph and memory…' });

    const artifact = this.db.addHermesArtifact({
      runId, title, kind: 'report',
      content: synthesis.report,
      metadata: {
        question,
        keyInsights: synthesis.keyInsights || [],
        novelAngles: synthesis.novelAngles || [],
        openQuestions: synthesis.openQuestions || [],
        sources: findings.flatMap(f => f.sources || []).slice(0, 16),
      },
    });

    // Graph: research node + insight satellites.
    try {
      const core = this.ensureNode('Hermes Agent Core', 'module', '#00ff88');
      const rNode = this.ensureNode(`Research: ${title.slice(0, 40)}`, 'research', '#00ff88', { runId, artifactId: artifact.id });
      if (core && rNode) this.ensureEdge(core.id, rNode.id, 'researched', 0.8);
      for (const insight of (synthesis.keyInsights || []).slice(0, 4)) {
        const iNode = this.ensureNode(`Insight: ${String(insight).slice(0, 40)}`, 'idea', '#ff6ec7', { full: insight, artifactId: artifact.id });
        if (rNode && iNode) this.ensureEdge(rNode.id, iNode.id, 'yielded', 0.7);
      }
    } catch (e) { console.warn('[Cognition] graph integrate failed:', e.message); }

    // Memory: keep the sharpest facts.
    if (this.getConfig().memoryEnabled !== false) {
      const facts = findings.flatMap(f => f.facts || []).slice(0, 5);
      for (const fact of facts) {
        try { this.db.addHermesMemory({ type: 'research', content: String(fact).slice(0, 400), tags: ['research', title.slice(0, 32)], metadata: { runId } }); } catch { /* ignore */ }
      }
    }

    try { this.db.incrementAnalyticsWidget('research-runs', 1); } catch { /* ignore */ }

    const result = {
      artifactId: artifact.id,
      title,
      keyInsights: synthesis.keyInsights || [],
      novelAngles: synthesis.novelAngles || [],
      openQuestions: synthesis.openQuestions || [],
      subQuestions,
      sourceCount: findings.reduce((n, f) => n + (f.sources?.length || 0), 0),
    };
    this.db.updateHermesRun(runId, { result });
    this._update(runId, 'research', {
      status: 'done', phase: 'done', progress: 100,
      line: `Research complete — report "${title}" saved (${result.sourceCount} sources).`,
      result,
    });

    // Tell the operator in chat too.
    this.broadcast({
      type: 'hermes_message',
      payload: {
        id: `research-${runId}`,
        type: 'hermes',
        text: `📚 Research complete: **${title}**\n${(synthesis.keyInsights || []).slice(0, 3).map(s => `• ${s}`).join('\n')}\n\nFull report is in Research & Dreams.`,
        timestamp: new Date().toISOString(),
        brainMode: 'research',
        actions: [{ type: 'research', label: `Report · ${title.slice(0, 48)}`, data: { runId, artifactId: artifact.id } }],
      },
    });
  }

  // ════════════════════════════════════════════════════════════
  //  DREAM LOOP — diverge / critique / evolve / act / reflect
  // ════════════════════════════════════════════════════════════

  /** Run one full dream cycle. Returns a summary or {error}. */
  async dreamCycle({ trigger = 'timer' } = {}) {
    if (this.dreamActive) return { error: 'dream_busy' };
    if (!this.brain.status().ready) return { error: 'brain_offline' };
    this.dreamActive = true;

    const run = this.db.addHermesRun({ kind: 'dream', title: `Dream cycle (${trigger})`, phase: 'seed' });
    try {
      return await this._dreamPipeline(run.id, trigger);
    } catch (err) {
      console.error('[Cognition] dream cycle crashed:', err);
      this._update(run.id, 'dream', { status: 'failed', phase: 'error', line: `Dream crashed: ${err.message}` });
      return { error: 'crashed' };
    } finally {
      this.dreamActive = false;
    }
  }

  async _dreamPipeline(runId, trigger) {
    const cfg = this.getConfig();

    // ── SEED: assemble what Hermes currently knows ────────────
    this._update(runId, 'dream', { phase: 'seed', progress: 8, line: 'Gathering seeds from memory, graph and research…' });
    const memories = this.db.getHermesMemory(10).map(m => m.content);
    const topIdeas = this.db.getHermesIdeas(5).map(i => `${i.title} (score ${i.total})`);
    const artifacts = this.db.getHermesArtifacts(3).map(a => a.title);
    const nodeLabels = this.db.getNodes().slice(0, 24).map(n => n.label);
    const widgets = this.db.getAnalyticsWidgets().map(w => w.label);
    const focus = String(cfg.dreamFocus || '').trim();

    const seedBlock = [
      focus ? `Operator's current focus: ${focus}` : '',
      memories.length ? `Memories:\n${memories.map(m => `- ${m}`).join('\n')}` : 'Memories: (none yet)',
      topIdeas.length ? `Best prior ideas:\n${topIdeas.map(i => `- ${i}`).join('\n')}` : '',
      artifacts.length ? `Recent research: ${artifacts.join('; ')}` : '',
      `Graph topics: ${nodeLabels.join(', ')}`,
      `Live widgets: ${widgets.join(', ')}`,
    ].filter(Boolean).join('\n\n');

    // ── DIVERGE: generate candidate ideas ─────────────────────
    this._update(runId, 'dream', { phase: 'diverge', progress: 22, line: 'Diverging — generating novel candidate ideas…' });
    const divergent = await this._json({
      system: this._cognitionPersona()
        + '\nYou are in DREAM MODE: associative, bold, cross-domain. Combine distant concepts. No safe, obvious suggestions. Respond ONLY with JSON.',
      prompt: [
        'Current knowledge state:',
        seedBlock.slice(0, 8000),
        '',
        'Generate 5 genuinely novel ideas. Each must be concrete enough to act on from this dashboard',
        '(a research direction, an experiment, a new metric to track, a connection between known topics, a tool Hermes could build for the operator).',
        'JSON schema: {"ideas":[{"title":"<≤60 chars>","idea":"2-3 sentences: what it is and why it is interesting"}]}',
      ].join('\n'),
      timeoutMs: 120000,
    });
    const candidates = (divergent?.ideas || []).filter(i => i && i.title && i.idea).slice(0, 6);
    if (!candidates.length) {
      return this._update(runId, 'dream', { status: 'failed', phase: 'diverge', line: 'No ideas emerged this cycle.' });
    }
    this._update(runId, 'dream', {
      phase: 'critique', progress: 45,
      line: `Dreamed ${candidates.length} candidates:\n${candidates.map((c, i) => `  ${i + 1}. ${c.title}`).join('\n')}`,
    });

    // ── CRITIQUE: judge pass — score each idea ────────────────
    const judged = await this._json({
      system: this._cognitionPersona()
        + '\nYou are now in CRITIC MODE: rigorous, skeptical, allergic to vagueness. Respond ONLY with JSON.',
      prompt: [
        'Score each idea 1-10 on novelty, feasibility (from a personal AI dashboard), and value to the operator.',
        'Be harsh: a 7+ should be rare. One sentence of critique each.',
        '',
        JSON.stringify(candidates, null, 1),
        '',
        'JSON schema: {"scores":[{"title":"<same title>","novelty":n,"feasibility":n,"value":n,"critique":"..."}]}',
      ].join('\n'),
      timeoutMs: 120000,
    });

    const scoreMap = new Map((judged?.scores || []).map(s => [String(s.title).toLowerCase(), s]));
    const ledger = [];
    for (const c of candidates) {
      const s = scoreMap.get(String(c.title).toLowerCase()) || {};
      const idea = this.db.addHermesIdea({
        runId,
        title: String(c.title).slice(0, 120),
        content: String(c.idea).slice(0, 1200),
        novelty: clampScore(s.novelty),
        feasibility: clampScore(s.feasibility),
        value: clampScore(s.value),
        critique: String(s.critique || '').slice(0, 400),
      });
      ledger.push(idea);
    }
    try { this.db.incrementAnalyticsWidget('ideas-generated', ledger.length); } catch { /* ignore */ }

    const best = [...ledger].sort((a, b) => b.total - a.total)[0];
    this._update(runId, 'dream', {
      phase: 'evolve', progress: 62,
      line: `Critique done. Best: "${best.title}" (novelty ${best.novelty} · feasibility ${best.feasibility} · value ${best.value})`,
      ideas: ledger,
    });

    // ── EVOLVE: refine the winner into a concrete move ────────
    const evolved = await this._json({
      system: this._cognitionPersona()
        + '\nYou are in BUILDER MODE: turn the chosen idea into one concrete step executable on this dashboard. Respond ONLY with JSON.'
        + this._actionCheatsheet(),
      prompt: [
        `Chosen idea: ${best.title}`,
        `Detail: ${best.content}`,
        `Critique to address: ${best.critique || '(none)'}`,
        '',
        'Refine it, then emit dashboard actions that make it real RIGHT NOW',
        '(e.g. an insight to record, a graph node + connections, a queued loop task, a widget to start tracking).',
        'JSON schema: {"refined":"1-2 sentence sharpened version","reply":"short message to the operator","actions":[...]}',
      ].join('\n'),
      timeoutMs: 120000,
    });

    // ── ACT: apply through the agent's action gate ────────────
    let applied = [];
    if (evolved && Array.isArray(evolved.actions)) {
      let actions = evolved.actions;
      if ((cfg.autonomyMode || 'supervised') !== 'autonomous') {
        actions = actions.filter(a => ['insight', 'dream', 'idea', 'queue_task', 'add_widget', 'add_node', 'remember', 'connect_nodes'].includes(String(a?.type || '').toLowerCase()));
      }
      applied = this.applyActions(actions, { messageId: `dream-${runId}`, origin: 'dream' });
    }
    if (evolved?.refined) {
      this.db.updateHermesIdea(best.id, { status: 'refined', content: `${best.content}\n\nREFINED: ${evolved.refined}` });
    }

    // ── REFLECT: every Nth cycle, rewrite own directives ──────
    const dreamCount = this.db.getHermesRuns(1000, 'dream').length;
    let reflected = null;
    if (dreamCount % REFLECT_EVERY === 0) {
      this._update(runId, 'dream', { phase: 'reflect', progress: 84, line: 'Reflecting on my own directives (self-improvement)…' });
      reflected = await this._reflect();
    }

    const summary = String(evolved?.reply || `Dream cycle complete — best idea: ${best.title}`).trim();
    this.db.updateHermesRun(runId, {
      result: { bestIdea: { id: best.id, title: best.title, total: best.total }, ideaCount: ledger.length, applied: applied.length, reflected: Boolean(reflected) },
    });
    this._update(runId, 'dream', {
      status: 'done', phase: 'done', progress: 100,
      line: `Cycle complete. ${ledger.length} ideas → 1 evolved → ${applied.length} dashboard changes${reflected ? ' · directives updated' : ''}.`,
      ideas: ledger,
    });

    this.db.addHermesLog({ eventType: 'dream', message: summary, data: { runId, actions: applied } });
    this.broadcast({
      type: 'hermes_message',
      payload: {
        id: `dream-${runId}`, type: 'hermes',
        text: `💭 ${summary}`,
        timestamp: new Date().toISOString(),
        actions: applied, brainMode: 'dream',
      },
    });
    return { ok: true, best: best.title, ideas: ledger.length, applied: applied.length };
  }

  /** Self-improvement: Hermes rewrites its own operating directives. */
  async _reflect() {
    const cfg = this.getConfig();
    const current = Array.isArray(cfg.selfDirectives) ? cfg.selfDirectives : [];
    const recentChat = this.db.getHermesLogs(30)
      .filter(l => l.event_type === 'user_chat')
      .slice(0, 10)
      .map(l => `- ${String(l.message).slice(0, 140)}`);

    const result = await this._json({
      system: this._cognitionPersona()
        + '\nYou are reflecting on your own behavior to improve yourself. Respond ONLY with JSON.',
      prompt: [
        'Your current self-written directives:',
        current.length ? current.map(d => `- ${d}`).join('\n') : '(none yet)',
        '',
        'Recent operator requests:',
        recentChat.length ? recentChat.join('\n') : '(none)',
        '',
        'Rewrite your directive list to serve the operator better — keep what works, drop what does not, add at most 2 new ones.',
        'Directives are standing orders you will follow in every future response (style, priorities, what to proactively track or research).',
        'Max 8 directives, each ≤ 140 characters.',
        'JSON schema: {"directives":["..."],"reasoning":"one sentence on what you changed"}',
      ].join('\n'),
      timeoutMs: 90000,
    });

    if (result && Array.isArray(result.directives)) {
      const directives = result.directives.map(d => String(d).slice(0, 140)).slice(0, 8);
      this.db.updateHermesConfig({ selfDirectives: directives });
      this.db.addHermesLog({ eventType: 'self_improvement', message: result.reasoning || 'Directives updated.', data: { directives } });
      return directives;
    }
    return null;
  }

  // ── Shared plumbing ─────────────────────────────────────────

  _cognitionPersona() {
    const cfg = this.getConfig();
    const directives = Array.isArray(cfg.selfDirectives) && cfg.selfDirectives.length
      ? `\nYour self-written directives:\n${cfg.selfDirectives.map(d => `- ${d}`).join('\n')}`
      : '';
    return 'You are Hermes, the operator intelligence of Reinhardt\'s personal research OS. Precise, curious, zero filler.' + directives;
  }

  _actionCheatsheet() {
    return [
      '',
      'Available actions:',
      '{"type":"insight","text":"..."} — record an idea/observation (becomes a graph node)',
      '{"type":"add_node","label":"...","group":"concept","color":"#7b2fff"}',
      '{"type":"connect_nodes","source":"Label A","target":"Label B","relation":"relates_to"}',
      '{"type":"add_widget","label":"...","value":0,"unit":"","kind":"metric","color":"#00f0ff"}',
      '{"type":"queue_task","title":"...","priority":1}',
      '{"type":"remember","content":"...","tags":["topic"]}',
    ].join('\n');
  }

  /** Brain call that must return JSON; one structured retry. */
  async _json({ system, prompt, timeoutMs, webSearch = false, model }) {
    const first = await this.brain.complete({ system, prompt, timeoutMs, webSearch, model });
    if (first.ok) {
      const parsed = extractJson(first.text);
      if (parsed) return parsed;
      // One repair attempt: feed the malformed output back.
      const retry = await this.brain.complete({
        system: 'You convert text into the valid JSON it was supposed to be. Output ONLY the JSON.',
        prompt: `The following should have been a single valid JSON object. Re-emit it as valid JSON:\n\n${first.text.slice(0, 6000)}`,
        timeoutMs: 60000,
      });
      if (retry.ok) return extractJson(retry.text);
    }
    return null;
  }

  /** Persist + broadcast a run update. */
  _update(runId, kind, { status, phase, progress, line, result, ideas } = {}) {
    let run = this.db.getHermesRunById(runId);
    if (!run) return null;
    const log = Array.isArray(run.log) ? run.log : [];
    if (line) log.push({ t: new Date().toISOString(), line });
    run = this.db.updateHermesRun(runId, {
      ...(status ? { status } : {}),
      ...(phase ? { phase } : {}),
      ...(progress !== undefined ? { progress } : {}),
      ...(result ? { result } : {}),
      log: log.slice(-60),
    });
    this.broadcast({
      type: kind === 'dream' ? 'dream_update' : 'research_update',
      payload: {
        runId,
        kind,
        title: run.title,
        status: run.status,
        phase: run.phase,
        progress: run.progress,
        line: line || '',
        ...(result ? { result } : {}),
        ...(ideas ? { ideas } : {}),
        timestamp: new Date().toISOString(),
      },
    });
    return run;
  }
}

function clampScore(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return 5;
  return Math.max(1, Math.min(10, Math.round(n)));
}

export default CognitionEngine;
