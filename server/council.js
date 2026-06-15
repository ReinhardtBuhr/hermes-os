// ─────────────────────────────────────────────────────────────
// Hermes OS — Research Council Engine
// Coordinator-worker orchestration over the Gemini brain:
//
//   SUPERVISOR  decomposes the goal, allocates work per round
//   GENERATION  proposes new candidate hypotheses
//   REFLECTION  critiques & stress-tests each candidate
//   RANKING     Elo tournament via pairwise judge comparisons
//   PROXIMITY   clusters similar candidates, retires duplicates
//   EVOLUTION   refines the leaders into improved successors
//   INTERPRET   closed loop: N parallel analyses of external
//               data + a consensus pass, fed back into the loop
//
// The loop runs continuously. When the Gemini quota is exhausted
// the council pauses itself and probes on a backoff schedule
// until quota returns, then resumes — across backend restarts,
// since every step persists to SQLite first.
// ─────────────────────────────────────────────────────────────

import { extractJson } from './brain.js';
import * as store from './council-store.js';
import { addHermesArtifact } from './database.js';
import {
  criteriaPrompt, supervisorPrompt, generationPrompt, reflectionPrompt, rankingPrompt,
  proximityPrompt, evolutionPrompt, interpretPrompt, consensusPrompt, verdictPrompt,
  metaReviewPrompt, falsifyPrompt, deepVerifyPrompt,
} from './council-prompts.js';

const DEFAULT_CONFIG = {
  generateCount: 3,        // new hypotheses per iteration
  evolveCount: 2,          // leaders refined per iteration
  matchesPerIteration: 5,  // tournament budget per iteration
  supervisorEvery: 5,      // re-plan every N iterations
  proximityEvery: 2,       // cluster every N iterations
  iterationDelayMs: 20000, // breathing room between iterations
  maxActive: 24,           // hypothesis pool cap
  maxIterations: 0,        // 0 = run until stopped / quota
  webSearch: true,         // ground generation + reality checks in live search (untick to disable)
  evidenceInstances: 3,    // parallel analyses per evidence drop
  power: 0,                // 1-5 operator power dial (0 = use raw values above)
  parallelLanes: 1,        // concurrent judge calls per tournament batch
};

// The operator's power dial: token burn ↔ speed. Setting power overlays
// these presets onto the config; the loop re-reads config every
// iteration, so a slider move applies on the very next round.
export const POWER_PRESETS = {
  1: { label: 'Eco',      generateCount: 2, evolveCount: 1, matchesPerIteration: 3,  evidenceInstances: 2, iterationDelayMs: 45000, parallelLanes: 1, callsPerIter: '~6' },
  2: { label: 'Standard', generateCount: 3, evolveCount: 2, matchesPerIteration: 5,  evidenceInstances: 3, iterationDelayMs: 20000, parallelLanes: 1, callsPerIter: '~9' },
  3: { label: 'High',     generateCount: 4, evolveCount: 3, matchesPerIteration: 7,  evidenceInstances: 3, iterationDelayMs: 12000, parallelLanes: 2, callsPerIter: '~12' },
  4: { label: 'Turbo',    generateCount: 5, evolveCount: 3, matchesPerIteration: 9,  evidenceInstances: 4, iterationDelayMs: 8000,  parallelLanes: 3, callsPerIter: '~15' },
  5: { label: 'Max',      generateCount: 6, evolveCount: 4, matchesPerIteration: 12, evidenceInstances: 5, iterationDelayMs: 5000,  parallelLanes: 4, callsPerIter: '~19' },
};

// Hybrid-brain role affinity: each lane takes the work it is strongest
// at — judging stays on Gemini's strict graders, creative divergence
// rides the OpenRouter lane, and the high-volume roles alternate so
// both brains stay saturated. Ignored outside hybrid mode.
const ROLE_LANES = {
  generation: 'openrouter',
  evolution: 'openrouter',
  proximity: 'openrouter',
  supervisor: 'gemini',
  criteria: 'gemini',
  reflection: 'gemini',
  verdict: 'gemini',
  consensus: 'gemini',
  ranking: 'alternate',
  interpret: 'alternate',
  meta: 'gemini',
  falsify: 'gemini', // web grounding lives on the Gemini lane
};

// Meta-review cadence: synthesize tournament lessons every N iterations.
const META_EVERY = 4;
// Falsification cadence: web-check the leader every N iterations (webSearch on).
const FALSIFY_EVERY = 4;
// Deep-verification cadence: audit a leader's load-bearing assumptions on
// the even rounds falsification skips — a reality check every 2nd round.
const DEEP_VERIFY_EVERY = 2;

/** Split match pairs into batches that never share a hypothesis, so
 *  parallel judging can't double-write one candidate's Elo. */
function conflictFreeBatches(pairs, size) {
  const batches = [];
  let batch = [];
  let used = new Set();
  for (const pair of pairs) {
    const [a, b] = pair;
    if (batch.length >= size || used.has(a.id) || used.has(b.id)) {
      if (batch.length) batches.push(batch);
      batch = [];
      used = new Set();
    }
    batch.push(pair);
    used.add(a.id); used.add(b.id);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

// Quota probe backoff: quick checks first (per-minute rate limits
// clear fast), then settle into a 5-minute heartbeat. A probe is one
// tiny completion that fails fast while exhausted, so a frequent
// heartbeat is cheap and catches any quota reset within ~5 minutes.
const PROBE_DELAYS_MS = [60000, 120000, 300000];

// Pull a "quota resets in N" hint out of a provider error detail so the
// operator sees the real recovery window instead of a vague backoff. The
// Gemini CLI prints "Your quota will reset after 3h38m52s"; OpenRouter's
// free daily cap ("free-models-per-day") rolls over at 00:00 UTC.
function parseQuotaReset(detail = '') {
  const text = String(detail || '');
  const m = text.match(/reset(?:s)?(?:\s+\w+)?\s+(?:after|in)\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i);
  if (m && (m[1] || m[2] || m[3])) {
    const ms = ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000;
    if (ms > 0) return { ms, source: 'provider' };
  }
  if (/per[-\s]?day|daily|free-models-per-day/i.test(text)) {
    const next = new Date();
    next.setUTCHours(24, 0, 0, 0); // next 00:00 UTC
    return { ms: next.getTime() - Date.now(), source: 'daily' };
  }
  return null;
}

function humanizeMs(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h) return `${h}h${m ? ` ${m}m` : ''}`;
  if (m) return `${m}m`;
  return `${total}s`;
}

const ELO_K = 32;

// ── Diversity engine ─────────────────────────────────────────
// The council's defense against its own worst habit: re-proposing
// the same ideas under new names. Three layers:
//   1. a full-history TERRITORY MAP injected into generation +
//      supervisor prompts (the council never forgets explored ground);
//   2. a lexical NOVELTY GATE that blocks near-duplicates before
//      they enter the tournament (zero API cost);
//   3. BANNED NAMES — invented brand names that won a few matches
//      become attractors ("PolyLoop", "LoopMesh"…); once overused
//      they are outlawed for all future titles.

const GATE_STOPWORDS = new Set((
  'the a an and or of with for to in on by from into via using use is are be been was were as at that this these those it its '
  + 'their our your his her not no than then so such only also can could should would will may might must have has had do does '
  + 'done make makes made each every all any some more most other another new old over under between within without per while '
  + 'when where which who whom how what why because therefore thus hence based driven enabled real time'
).split(/\s+/));

function gateTokens(text) {
  // Split CamelCase compounds first ("LatentForge" → "latent forge"):
  // without this, LatentForge/LatentAnvil/LatentKiln share zero tokens
  // and an entire family of clone names sails through the novelty gate.
  return String(text || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/)
    .filter(w => w.length > 2 && !GATE_STOPWORDS.has(w));
}

/** Significant-word set of a text, for similarity comparison. */
function gateWords(text) {
  return new Set(gateTokens(text));
}

/** Consecutive word-pair set — paraphrase-resistant: a renamed idea keeps
 *  its distinctive phrases ("predictive buffer alignment") even when the
 *  overall vocabulary is shuffled. */
function gateBigrams(text) {
  const t = gateTokens(text);
  const out = new Set();
  for (let i = 0; i < t.length - 1; i += 1) out.add(`${t[i]} ${t[i + 1]}`);
  return out;
}

/** Overlap coefficient: |A∩B| / min(|A|,|B|) — robust to length mismatch. */
function gateOverlap(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const w of small) if (large.has(w)) inter += 1;
  return inter / small.size;
}

// Similarity thresholds, calibrated against real council history (217-
// hypothesis run). Words: fresh ideas ≤0.2, innocent baseline tops out
// ~0.31, true re-proposals 0.6+. Bigrams: fresh ≈0.04, baseline p99 0.13,
// renamed re-proposals 0.24+. A candidate is blocked when EITHER signal
// fires — a false block is cheap (next round regenerates with feedback);
// a false pass poisons the leaderboard. Evolution children legitimately
// resemble their parent, so only near-verbatim repeats are blocked there.
const GATE_THRESHOLD = {
  generation: { words: 0.45, bigrams: 0.18 },
  evolution: { words: 0.8, bigrams: 0.45 },
};
// A cluster with this many lifetime members is declared saturated.
const CLUSTER_SATURATION = 6;
// An invented title-name used by this many hypotheses gets banned.
const NAME_OVERUSE = 3;

class QuotaError extends Error {
  constructor(detail = '') { super('quota_exhausted'); this.detail = detail; }
}

export class CouncilEngine {
  constructor({ brain, broadcast, getConfig }) {
    this.brain = brain;
    this.broadcast = broadcast || (() => {});
    this.getConfig = getConfig || (() => ({}));
    this._looping = new Set();      // council ids with a live loop
    this._probeTimers = new Map();  // council id → timeout handle
    this._probeAttempts = new Map();
    this._concluding = new Set();
    this._minds = new Map();        // council id → { role → live mind state }
    this._gateNotes = new Map();    // council id → feedback line for the next generation round
    store.initCouncilStore();

    // Watchdog: a council marked running must always have a live loop, and a
    // quota-paused one a pending probe. If a loop promise ever dies silently
    // (crash, unhandled edge), this re-engages it within 90s.
    this._watchdog = setInterval(() => {
      try {
        for (const c of store.listCouncils(20)) {
          if (c.status === 'running' && !this._looping.has(c.id)) {
            console.warn('[Council] watchdog: re-engaging idle loop for', c.id);
            this._emit(c.id, c.iteration, 'system', '🛠 Watchdog: loop was idle — re-engaging.');
            this._loop(c.id).catch(() => {});
          } else if (c.status === 'quota_paused' && !this._probeTimers.has(c.id)) {
            this._scheduleProbe(c.id, 30000);
          }
        }
      } catch { /* never let the watchdog throw */ }
    }, 90000);
    if (typeof this._watchdog.unref === 'function') this._watchdog.unref();
  }

  // ── Public API ─────────────────────────────────────────────

  start(goal, config = {}) {
    const g = String(goal || '').trim();
    if (!g) return { error: 'empty_goal' };
    if (!this.brain.status().ready) return { error: 'brain_offline', message: 'The Gemini brain is not connected.' };
    const active = store.getActiveCouncil();
    if (active) return { error: 'council_busy', message: `Council "${active.goal.slice(0, 60)}…" is still ${active.status}. Stop it first.` };

    const cfg = this._mergeConfig(config);
    const council = store.createCouncil({ goal: g, config: cfg });
    this._emit(council.id, 0, 'system', `Council convened. Goal: ${g}`);
    this._loop(council.id).catch(err => console.error('[Council] loop crashed:', err));
    return { council };
  }

  stop(id) {
    const council = store.getCouncil(id);
    if (!council) return { error: 'not_found' };
    this._clearProbe(id);
    store.updateCouncil(id, { status: 'stopped', paused_reason: 'stopped by operator', next_probe_at: null });
    this._emit(id, council.iteration, 'system', 'Council stopped by operator.');
    return { council: store.getCouncil(id) };
  }

  resume(id) {
    const council = store.getCouncil(id);
    if (!council) return { error: 'not_found' };
    if (council.status === 'running') return { council };
    const active = store.getActiveCouncil();
    if (active && active.id !== id) return { error: 'council_busy', message: 'Another council is active. Stop it first.' };
    if (!this.brain.status().ready) return { error: 'brain_offline', message: 'The Gemini brain is not connected.' };

    this._clearProbe(id);
    store.updateCouncil(id, { status: 'running', paused_reason: '', next_probe_at: null });
    this._emit(id, council.iteration, 'system', 'Council resumed by operator.');
    this._loop(id).catch(err => console.error('[Council] loop crashed:', err));
    return { council: store.getCouncil(id) };
  }

  submitEvidence(id, content, images = []) {
    const council = store.getCouncil(id);
    if (!council) return { error: 'not_found' };
    const text = String(content || '').trim();
    const imgs = (Array.isArray(images) ? images : []).filter(u => typeof u === 'string' && u).slice(0, 8);
    if (!text && !imgs.length) return { error: 'empty_evidence' };
    // Photos travel with the drop and are noted in the analyzed text so the
    // interpretation agents know the operator attached visual evidence.
    const body = text || '(image evidence — see attached photos)';
    const stored = imgs.length ? `${body}\n\n[Operator attached ${imgs.length} image${imgs.length > 1 ? 's' : ''}: ${imgs.join(' ')}]` : body;
    const evidence = store.addEvidence({ councilId: id, content: stored, images: imgs });
    this._emit(id, council.iteration, 'interpret',
      `Evidence received (${text.length} chars${imgs.length ? ` · ${imgs.length} photo${imgs.length > 1 ? 's' : ''}` : ''}) — queued for the next iteration.`);
    return { evidence };
  }

  detail(id) {
    const council = store.getCouncil(id);
    if (!council) return null;
    return {
      council,
      hypotheses: store.getHypotheses(id, { status: 'all', limit: 60 }),
      matches: store.getMatches(id, 60),
      // Extra headroom: debate events share this feed but are split out into
      // the Debate Chamber on the client, so fetch enough to keep both rich.
      events: store.getEvents(id, 120),
      evidence: store.getEvidence(id, 6),
      agents: this.agents(id),
    };
  }

  /** Every agent's live profile: operator-tuned traits + what it is thinking right now. */
  agents(id) {
    const council = store.getCouncil(id);
    if (!council) return null;
    return store.getAllAgentTraits(id).map(profile => ({
      ...profile,
      mind: this._mindPublic(id, profile.role),
    }));
  }

  /**
   * Operator retunes one agent's attributes. Applied instantly: every brain
   * call re-reads traits from the store, so the next time this agent fires —
   * even mid-iteration — it works under the new personality, acknowledges
   * the retune in its prompt, and the whole council sees the change.
   */
  updateAgent(id, role, patch = {}) {
    const result = store.updateAgentTraits(id, role, patch);
    if (result.error) return result;
    if (result.changes.length) {
      const council = store.getCouncil(id);
      this._emit(id, council?.iteration || 0, 'system',
        `🎛 ${role.toUpperCase()} retuned by operator: ${result.changes.join(', ')} — live on its next action.`);
      this.broadcast({
        type: 'council_agent_traits',
        payload: { councilId: id, role, agent: { ...result.agent, mind: this._mindPublic(id, role) } },
      });
    }
    return result;
  }

  /**
   * Operator moves the power dial (1-5). Stored into config; the loop
   * re-reads config at the top of every iteration, so the new burn
   * rate + parallelism apply on the very next round — mid-run.
   */
  setPower(id, power) {
    const council = store.getCouncil(id);
    if (!council) return { error: 'not_found' };
    const p = Math.max(1, Math.min(5, Math.round(Number(power) || 0)));
    if (!POWER_PRESETS[p]) return { error: 'bad_power' };
    const config = { ...council.config, power: p };
    store.updateCouncil(id, { config });
    const preset = POWER_PRESETS[p];
    this._emit(id, council.iteration, 'system',
      `⚡ Power dial → ${p}/5 ${preset.label.toUpperCase()} (${preset.callsPerIter} calls/iteration, ${preset.parallelLanes} parallel judge lane${preset.parallelLanes > 1 ? 's' : ''}, ${Math.round(preset.iterationDelayMs / 1000)}s between rounds) — applies from the next iteration.`);
    this.broadcast({ type: 'council_power', payload: { councilId: id, power: p, preset } });
    return { council: store.getCouncil(id), preset };
  }

  /**
   * Operator veto: strike a hypothesis from the tournament, in realtime.
   * The council LEARNS from it three ways, all immediate:
   *   1. the hypothesis is retired (status 'vetoed') — off the leaderboard,
   *      out of matchmaking, evolution and the verdict;
   *   2. its past wins are REVERSED — every opponent it beat gets the Elo
   *      back, so the standings stop reflecting the operator-rejected line;
   *   3. the veto (with the operator's reason) becomes standing guidance
   *      injected into EVERY agent's prompt from the very next call:
   *      generation avoids the direction, judges rank similar ideas down.
   */
  veto(councilId, hypothesisId, reason = '') {
    const council = store.getCouncil(councilId);
    if (!council) return { error: 'not_found' };
    const hyp = store.getHypothesis(hypothesisId);
    if (!hyp || hyp.council_id !== councilId) return { error: 'hypothesis_not_found' };
    if (hyp.status === 'vetoed') return { error: 'already_vetoed' };
    const cleanReason = String(reason || '').trim().slice(0, 300);

    // 1. Strike it.
    store.updateHypothesis(hyp.id, {
      status: 'vetoed',
      critique: `${hyp.critique ? `${hyp.critique} ` : ''}⛔ OPERATOR VETO${cleanReason ? `: ${cleanReason}` : ''}.`,
    });

    // 2. Reverse its judgements: refund the Elo it took from opponents.
    const refunds = [];
    for (const m of store.getMatches(councilId, 500)) {
      if (m.winner_id !== hyp.id) continue;
      const loserId = m.a_id === hyp.id ? m.b_id : m.a_id;
      const loser = store.getHypothesis(loserId);
      if (!loser || loser.status === 'vetoed') continue;
      const before = m.a_id === loserId ? m.elo_a_before : m.elo_b_before;
      const after = m.a_id === loserId ? m.elo_a_after : m.elo_b_after;
      const delta = Math.max(0, Number(before || 0) - Number(after || 0));
      if (!delta) continue;
      store.updateHypothesis(loserId, {
        elo: loser.elo + delta,
        losses: Math.max(0, loser.losses - 1),
        matches: Math.max(0, loser.matches - 1),
      });
      refunds.push({ slug: loser.slug, amount: Math.round(delta) });
    }

    // 3. Teach the council: the veto becomes standing operator guidance,
    // injected into every agent prompt via traitsText (see prompts).
    const guidance = [
      ...(Array.isArray(council.guidance) ? council.guidance : []),
      { slug: hyp.slug, title: hyp.title, reason: cleanReason, at: new Date().toISOString() },
    ].slice(-12);
    store.updateCouncil(councilId, { guidance });

    const line = `⛔ OPERATOR VETO: ${hyp.slug} "${hyp.title}" struck from the tournament`
      + `${cleanReason ? ` — “${cleanReason}”` : ''}.`
      + (refunds.length ? ` ${refunds.length} past judgement${refunds.length > 1 ? 's' : ''} reversed — Elo refunded to ${refunds.map(r => `${r.slug} (+${r.amount})`).join(', ')}.` : '')
      + ' Every agent now treats this direction as a losing one.';
    this._emit(councilId, council.iteration, 'system', line, { veto: { slug: hyp.slug, refunds } });
    this.broadcast({
      type: 'council_veto',
      payload: {
        councilId, hypothesisId: hyp.id, slug: hyp.slug, title: hyp.title,
        reason: cleanReason, refunds, guidanceCount: guidance.length,
      },
    });
    return { hypothesis: store.getHypothesis(hyp.id), refunds, guidanceCount: guidance.length };
  }

  /**
   * Operator purge: clear the proposed leaderboard in one stroke. Every
   * ACTIVE hypothesis except the ones the operator check-marked to KEEP is
   * struck from the tournament. The council reacts immediately:
   *   1. cleared hypotheses → status 'rejected' (off the board, out of
   *      matchmaking / evolution / verdict; they wither in the tree);
   *   2. kept hypotheses are FAVORED — a confidence Elo bump + recorded as
   *      the operator-endorsed pivot direction;
   *   3. a standing PURGE directive (with the operator's reason + the kept
   *      directions) is injected into every agent prompt from its next call,
   *      and generation is forced to pivot hard on the next round.
   */
  clearProposals(councilId, { keepIds = [], reason = '' } = {}) {
    const council = store.getCouncil(councilId);
    if (!council) return { error: 'not_found' };
    const keep = new Set((Array.isArray(keepIds) ? keepIds : []).map(String));
    const actives = store.getHypotheses(councilId, { status: 'active', limit: 300 });
    if (!actives.length) return { error: 'nothing_to_clear' };

    const cleanReason = String(reason || '').trim().slice(0, 300);
    const cleared = [];
    const kept = [];
    for (const h of actives) {
      if (keep.has(h.id)) {
        // Favor it: a confidence bump puts the operator-endorsed lines on top.
        store.updateHypothesis(h.id, { elo: h.elo + 40 });
        kept.push(h);
      } else {
        store.updateHypothesis(h.id, {
          status: 'rejected',
          critique: `${h.critique ? `${h.critique} ` : ''}🧹 OPERATOR PURGE — cleared from the board as a weak direction${cleanReason ? `: ${cleanReason}` : ''}.`,
        });
        cleared.push(h);
      }
    }

    // Teach the council: a standing purge directive (rendered in traitsText).
    const guidance = [
      ...(Array.isArray(council.guidance) ? council.guidance : []),
      {
        kind: 'purge',
        clearedSlugs: cleared.map(h => h.slug),
        keptSlugs: kept.map(h => h.slug),
        keptTitles: kept.map(h => h.title),
        reason: cleanReason,
        at: new Date().toISOString(),
      },
    ].slice(-12);
    store.updateCouncil(councilId, { guidance });

    // Force generation to pivot hard on its very next round.
    this._gateNotes.set(councilId,
      `The operator just CLEARED THE BOARD: ${cleared.length} proposal${cleared.length === 1 ? '' : 's'} were rejected as weak${cleanReason ? ` ("${cleanReason}")` : ''}. `
      + (kept.length
        ? `PIVOT toward the surviving directions the operator KEPT (${kept.map(h => `${h.slug} "${h.title}"`).join('; ')}) — extend and deepen them, don't drift back to the cleared ones.`
        : 'Abandon every cleared direction entirely and open fresh territory.'));

    const line = `🧹 OPERATOR PURGE: ${cleared.length} proposal${cleared.length === 1 ? '' : 's'} cleared from the board`
      + `${cleanReason ? ` — “${cleanReason}”` : ''}.`
      + (kept.length
        ? ` Keeping ${kept.map(h => h.slug).join(', ')} as the pivot direction — agents will favor and build on ${kept.length === 1 ? 'it' : 'them'}.`
        : ' The council will pivot to entirely new territory next round.');
    this._emit(councilId, council.iteration, 'system', line,
      { purge: { cleared: cleared.map(h => h.slug), kept: kept.map(h => h.slug) } });
    this._fireGuidancePivot(councilId, council.iteration);
    this.broadcast({
      type: 'council_purge',
      payload: {
        councilId,
        cleared: cleared.map(h => ({ slug: h.slug, title: h.title })),
        kept: kept.map(h => ({ slug: h.slug, title: h.title })),
        reason: cleanReason,
      },
    });
    return { cleared: cleared.length, kept: kept.length, keptSlugs: kept.map(h => h.slug), clearedSlugs: cleared.map(h => h.slug) };
  }

  /** Nudge the running loop to regenerate immediately after a purge. */
  _fireGuidancePivot(councilId, iteration) {
    // The interruptible sleep checks status every 2s; shortening the next
    // iteration gap makes the pivot feel instant without disturbing the run.
    const council = store.getCouncil(councilId);
    if (council && council.status === 'running') {
      this._setStats(councilId, { nextIterationAt: new Date(Date.now() + 3000).toISOString() });
    }
  }

  // ── Live minds: what each agent is thinking, in realtime ───

  _mindOf(councilId, role) {
    if (!this._minds.has(councilId)) this._minds.set(councilId, {});
    const minds = this._minds.get(councilId);
    if (!minds[role]) {
      minds[role] = {
        role, state: 'idle', task: '', inflight: 0,
        startedAt: null, lastMs: 0, calls: 0, ok: 0, failed: 0,
        thought: '', history: [],
      };
    }
    return minds[role];
  }

  _mindPublic(councilId, role) {
    const m = this._mindOf(councilId, role);
    return {
      state: m.state, task: m.task, startedAt: m.startedAt, lastMs: m.lastMs,
      calls: m.calls, ok: m.ok, failed: m.failed, thought: m.thought,
      history: m.history.slice(-24),
    };
  }

  _mindStart(councilId, role, task, promptText = '') {
    const m = this._mindOf(councilId, role);
    m.inflight += 1;
    m.state = 'thinking';
    m.task = task || m.task;
    m.startedAt = new Date().toISOString();
    this.broadcast({
      type: 'council_agent_state',
      payload: {
        councilId, role, state: 'thinking', task,
        promptPreview: String(promptText).slice(0, 220),
        at: m.startedAt,
      },
    });
  }

  _mindEnd(councilId, role, { ok, ms, thought = '', reason = '' }) {
    const m = this._mindOf(councilId, role);
    m.inflight = Math.max(0, m.inflight - 1);
    m.state = m.inflight > 0 ? 'thinking' : 'idle';
    m.lastMs = ms;
    m.calls += 1;
    if (ok) m.ok += 1; else m.failed += 1;
    if (thought) m.thought = thought;
    m.history.push({
      at: new Date().toISOString(), kind: 'call',
      text: thought || (ok ? m.task : `failed: ${reason || 'no usable answer'}`),
      ms, ok,
    });
    if (m.history.length > 40) m.history.splice(0, m.history.length - 40);
    this.broadcast({
      type: 'council_agent_state',
      payload: { councilId, role, state: m.state, ok, ms, thought, at: new Date().toISOString() },
    });
  }

  /** Fresh traits for a role, consuming the one-shot retune acknowledgment. */
  _agentProfile(councilId, role) {
    const profile = store.getAgentTraits(councilId, role);
    if (!profile) return null;
    const note = store.consumePendingNote(councilId, role);
    if (note) profile.adaptNote = note;
    // Operator vetoes ride along into every prompt — the council's
    // learned taste, refreshed on each call so a veto applies instantly.
    const guidance = store.getCouncil(councilId)?.guidance;
    if (Array.isArray(guidance) && guidance.length) {
      profile.operatorGuidance = guidance.slice(-6);
    }
    return profile;
  }

  graph(id) {
    const council = store.getCouncil(id);
    if (!council) return null;
    return store.getCouncilGraph(id);
  }

  /** Evolution-forest projection: every hypothesis ever, with lineage. */
  tree(id) {
    const council = store.getCouncil(id);
    if (!council) return null;
    return { nodes: store.getCouncilTree(id) };
  }

  list() { return store.listCouncils(20); }

  /**
   * End the tournament and deliver the final verdict: the verdict agent
   * weighs the finalists (Elo standing + critiques + evidence) and writes
   * the closing report. Also saved as a Hermes artifact.
   */
  async conclude(id) {
    const council = store.getCouncil(id);
    if (!council) return { error: 'not_found' };
    if (this._concluding.has(id)) return { error: 'busy', message: 'The verdict is already being written.' };
    if (!this.brain.status().ready) return { error: 'brain_offline', message: 'The Gemini brain is not connected.' };

    const finalists = store.getHypotheses(id, { status: 'all', limit: 50 })
      .filter(h => h.status !== 'rejected' && h.status !== 'vetoed' && h.matches > 0)
      .slice(0, 8);
    if (!finalists.length) return { error: 'no_finalists', message: 'No ranked hypotheses yet — let the council run at least one full iteration first.' };

    // Halt the loop; the verdict is the council's final act.
    this._clearProbe(id);
    if (['running', 'quota_paused'].includes(council.status)) {
      store.updateCouncil(id, { status: 'stopped', paused_reason: 'concluding', next_probe_at: null });
    }

    this._concluding.add(id);
    this._emit(id, council.iteration, 'verdict', '🏛 The council is deliberating its final verdict — 3 independent deliberations, majority rules…');
    try {
      // Self-consistency (Wang 2022): the verdict is the council's most
      // important output, so it is sampled three times in parallel and
      // decided by majority vote — one bad sample can no longer crown
      // the wrong winner. Same pattern as the evidence-consensus loop.
      const deliberate = (i) => this._call(id, verdictPrompt({
        goal: council.goal,
        criteria: council.criteria || [],
        finalists,
        evidenceConsensus: this._latestConsensusSummary(id),
        stats: { ...council.stats, iterations: council.iteration },
        traits: this._agentProfile(id, 'verdict'),
      }), { timeoutMs: 200000, role: 'verdict', task: `deliberating the final verdict (${i}/3)` });

      const outcomes = await Promise.allSettled([deliberate(1), deliberate(2), deliberate(3)]);
      const quotaDeath = outcomes.find(o => o.status === 'rejected' && o.reason instanceof QuotaError);
      const samples = outcomes
        .filter(o => o.status === 'fulfilled' && o.value?.winner?.slug)
        .map(o => o.value);

      if (!samples.length) {
        if (quotaDeath) throw quotaDeath.reason;
        store.updateCouncil(id, { paused_reason: 'verdict failed — council stopped' });
        this._emit(id, council.iteration, 'verdict', '⚠ The verdict agent returned nothing usable — try Conclude again.');
        return { error: 'verdict_failed', message: 'The verdict agent returned nothing usable — try again.' };
      }

      const tally = new Map();
      for (const s of samples) {
        const slug = String(s.winner.slug).toUpperCase();
        tally.set(slug, (tally.get(slug) || 0) + 1);
      }
      const [majoritySlug, votes] = [...tally.entries()].sort((x, y) => y[1] - x[1])[0];
      const agreeing = samples.filter(s => String(s.winner.slug).toUpperCase() === majoritySlug);
      // Use the most detailed report among the agreeing deliberations.
      const result = agreeing.sort((x, y) => String(y.synthesis || '').length - String(x.synthesis || '').length)[0];
      if (samples.length > 1) {
        this._emit(id, council.iteration, 'verdict',
          `⚖ ${samples.length} independent deliberations returned — ${votes}/${samples.length} agree the winner is ${majoritySlug}.`);
      }

      const bySlug = new Map(finalists.map(h => [h.slug.toUpperCase(), h]));
      const winnerHyp = bySlug.get(String(result.winner.slug).toUpperCase()) || finalists[0];
      const verdict = {
        winner: { slug: winnerHyp.slug, title: winnerHyp.title, statement: winnerHyp.statement, verdict: String(result.winner.verdict || '') },
        ranking: (Array.isArray(result.ranking) ? result.ranking : []).map(r => {
          const h = bySlug.get(String(r.slug || '').toUpperCase());
          return h ? {
            slug: h.slug, title: h.title, elo: Math.round(h.elo), wins: h.wins, losses: h.losses,
            tagline: String(r.tagline || ''), strongest: String(r.strongest || ''), risk: String(r.risk || ''),
            criterionScores: r.criterionScores && typeof r.criterionScores === 'object' ? r.criterionScores : {},
          } : null;
        }).filter(Boolean),
        synthesis: String(result.synthesis || ''),
        nextSteps: (Array.isArray(result.nextSteps) ? result.nextSteps : []).map(String).slice(0, 5),
        concludedAt: new Date().toISOString(),
      };
      store.updateCouncil(id, { status: 'concluded', verdict, paused_reason: '' });

      // Mirror the report into the artifact library (Research & Dreams view).
      try {
        addHermesArtifact({
          title: `Council verdict: ${council.goal.slice(0, 90)}`,
          kind: 'council_verdict',
          content: [
            `# Council Verdict — ${council.goal}`,
            '',
            `**Winner: ${winnerHyp.slug} — ${winnerHyp.title}**`,
            '',
            verdict.winner.verdict,
            '',
            verdict.synthesis,
            '',
            '## Final standings',
            ...verdict.ranking.map((r, i) => `${i + 1}. **${r.slug} ${r.title}** (elo ${r.elo}, ${r.wins}W-${r.losses}L) — ${r.tagline}`),
            '',
            '## Next steps',
            ...verdict.nextSteps.map(s => `- ${s}`),
          ].join('\n'),
          metadata: { councilId: id, winner: winnerHyp.slug },
        });
      } catch (e) { console.warn('[Council] artifact save failed:', e.message); }

      this._emit(id, council.iteration, 'verdict',
        `🏆 VERDICT: ${winnerHyp.slug} "${winnerHyp.title}" wins. ${String(verdict.winner.verdict).slice(0, 180)}`,
        { verdict: true });
      return { council: store.getCouncil(id) };
    } catch (err) {
      if (err instanceof QuotaError) {
        store.updateCouncil(id, { paused_reason: 'verdict pending — quota exhausted' });
        this._emit(id, council.iteration, 'verdict', '⏸ Quota exhausted mid-verdict — press Conclude again once quota returns.');
        return { error: 'quota_exhausted', message: 'Gemini quota is exhausted — try Conclude again after the quota resets.' };
      }
      this._emit(id, council.iteration, 'verdict', `⚠ Verdict failed: ${err.message}`);
      return { error: 'verdict_failed', message: err.message };
    } finally {
      this._concluding.delete(id);
    }
  }

  /** Called once at boot: pick up councils that were live when the server died. */
  resumeOnBoot() {
    for (const council of store.listCouncils(50)) {
      if (council.status === 'running') {
        console.log(`[Council] Resuming council ${council.id} after restart`);
        this._emit(council.id, council.iteration, 'system', 'Backend restarted — council loop resuming.');
        setTimeout(() => this._loop(council.id).catch(() => {}), 4000);
      } else if (council.status === 'quota_paused') {
        console.log(`[Council] Re-arming quota probe for council ${council.id}`);
        this._scheduleProbe(council.id, 60000);
      }
    }
  }

  // ── Main loop ──────────────────────────────────────────────

  async _loop(councilId) {
    if (this._looping.has(councilId)) return;
    this._looping.add(councilId);
    let consecutiveErrors = 0;

    try {
      for (;;) {
        const council = store.getCouncil(councilId);
        if (!council || council.status !== 'running') break;

        const cfg = this._mergeConfig(council.config);
        if (cfg.maxIterations > 0 && council.iteration >= cfg.maxIterations) {
          this._emit(councilId, council.iteration, 'system', `Iteration limit (${cfg.maxIterations}) reached — moving to the final verdict.`);
          await this.conclude(councilId).catch(() => {});
          break;
        }

        this._setStats(councilId, { nextIterationAt: null });
        try {
          await this._iteration(council, cfg);
          consecutiveErrors = 0;
        } catch (err) {
          if (err instanceof QuotaError) {
            this._pause(councilId, 'quota_exhausted', err.detail);
            break;
          }
          consecutiveErrors += 1;
          console.error('[Council] iteration error:', err);
          this._emit(councilId, council.iteration + 1, 'system', `⚠ Iteration error (${consecutiveErrors}/3): ${err.message}`);
          if (consecutiveErrors >= 3) {
            // Treat persistent failure like a quota pause — probe and resume
            // rather than dying, so the council keeps its run-forever promise.
            this._pause(councilId, 'errors', err.message);
            break;
          }
        }

        this._setStats(councilId, { nextIterationAt: new Date(Date.now() + cfg.iterationDelayMs).toISOString() });
        await this._interruptibleSleep(councilId, cfg.iterationDelayMs);
      }
    } finally {
      this._looping.delete(councilId);
    }
  }

  async _iteration(council, cfg) {
    const id = council.id;
    const iter = council.iteration + 1;
    this._emit(id, iter, 'system', `── Iteration ${iter} ──`);

    // 0. CLOSED LOOP: analyze any queued external evidence first,
    //    so its consensus informs everything else this round.
    for (const evidence of store.getQueuedEvidence(id)) {
      if (!this._isRunning(id)) return;
      await this._processEvidence(council, evidence, iter, cfg);
    }
    const evidenceConsensus = this._latestConsensusSummary(id);

    // 0b. CRITERIA: derive goal-specific judging axes once, up front.
    // Everything downstream (generation, reflection, ranking, verdict)
    // judges against these instead of generic novelty/plausibility.
    let criteria = Array.isArray(council.criteria) ? council.criteria : [];
    if (!criteria.length) {
      this._emit(id, iter, 'criteria', 'Deriving judging criteria from the research goal…');
      const result = await this._call(id, criteriaPrompt({ goal: council.goal }),
        { timeoutMs: 90000, role: 'criteria', task: 'deriving goal-specific judging criteria' });
      criteria = (result?.criteria || [])
        .filter(c => c && c.name)
        .slice(0, 4)
        .map(c => ({ name: String(c.name).slice(0, 28), description: String(c.description || '').slice(0, 220) }));
      if (criteria.length) {
        store.updateCouncil(id, { criteria });
        this._emit(id, iter, 'criteria', `⚖ This council judges on: ${criteria.map(c => c.name.toUpperCase()).join(' · ')}`, { criteria });
      } else {
        this._emit(id, iter, 'criteria', '⚠ Could not derive criteria — judging on novelty + plausibility.');
      }
    }

    // 0c. DIVERSITY MEMORY: compile the council's full-history territory
    // map once per round — the antidote to re-proposing retired ideas.
    const mem = this._memoryContext(id, council.goal);

    // 1. SUPERVISOR: plan on the first iteration, then every Nth.
    let plan = council.plan && council.plan.allocation ? council.plan : null;
    if (iter === 1 || (cfg.supervisorEvery > 0 && (iter - 1) % cfg.supervisorEvery === 0)) {
      if (!this._isRunning(id)) return;
      this._emit(id, iter, 'supervisor', 'Supervisor planning this phase of work…');
      const top = store.getHypotheses(id, { status: 'active', limit: 10 });
      const result = await this._call(id, supervisorPrompt({
        goal: council.goal, iteration: iter,
        stats: { activeCount: top.length, matchCount: store.countMatches(id) },
        topHypotheses: top,
        clusters: this._clusterSummaryList(top),
        evidenceConsensus,
        prevPlan: plan,
        traits: this._agentProfile(id, 'supervisor'),
        memory: mem,
        meta: council.meta,
      }), { timeoutMs: 120000, role: 'supervisor', task: `planning iteration ${iter}` });
      if (result && result.allocation) {
        plan = result;
        store.updateCouncil(id, { plan });
        this._emit(id, iter, 'supervisor',
          `Plan: ${(result.focusAreas || []).join(' · ')}\n${result.assessment || ''}`, { plan: result });
      } else {
        this._emit(id, iter, 'supervisor', '⚠ Supervisor produced no plan — using defaults this round.');
      }
    }

    // 2. GENERATION: propose new candidates. The supervisor distributes
    // work but the operator's config is the budget ceiling (quota control).
    const genCount = clampInt(plan?.allocation?.generate, cfg.generateCount, 0, cfg.generateCount);
    const newcomers = [];
    if (genCount > 0 && this._isRunning(id)) {
      // Frontier cadence: every 3rd round generation is forbidden from
      // touching any explored cluster — forced exploration.
      const frontier = iter % 3 === 0 && mem.total >= 8;
      // Debate mode (co-scientist self-play): on frontier rounds, whenever
      // the novelty gate just caught it repeating itself, and on a regular
      // cadence once the pool is rich enough — so rival perspectives argue
      // out the council's direction often, not just rarely. Each debate is
      // streamed live into the Debate Chamber.
      const debate = frontier || Boolean(this._gateNotes.get(id)) || (mem.total >= 6 && iter % 2 === 0);
      this._emit(id, iter, 'generation',
        `Generating ${genCount} new hypotheses${frontier ? ' — 🧭 FRONTIER ROUND (unexplored territory only)' : ''}${debate ? ' — 🗣 debate mode' : ''}${cfg.webSearch ? ' (web-grounded)' : ''}…`);
      const actives = store.getHypotheses(id, { status: 'active', limit: 20 });
      const result = await this._call(id, generationPrompt({
        goal: council.goal, plan, criteria,
        topHypotheses: actives,
        clusterSummaries: this._clusterSummaryList(actives).map(c => `- ${c.name}: ${c.members.join(', ')}`),
        evidenceConsensus, count: genCount, webSearch: cfg.webSearch,
        traits: this._agentProfile(id, 'generation'),
        memory: mem, frontier, debate,
        gateFeedback: this._gateNotes.get(id) || '',
        meta: council.meta,
      }), {
        timeoutMs: cfg.webSearch ? 200000 : 150000, webSearch: cfg.webSearch,
        role: 'generation', task: `proposing ${genCount} new hypotheses${frontier ? ' (frontier round)' : ''}${debate ? ' (debate mode)' : ''}${cfg.webSearch ? ' (web-grounded)' : ''}`,
      });

      // Surface the staged debate in the Debate Chamber — the operator gets
      // to watch the rival perspectives argue, live, before the proposals
      // land. Structured into per-speaker turns; a short note marks the log.
      if (debate && result?.debate) {
        const turns = parseDebate(result.debate);
        this._emitDebate(id, iter, {
          kind: 'generation',
          title: frontier ? `🧭 Frontier direction debate · iteration ${iter}` : `Direction debate · iteration ${iter}`,
          turns,
          summary: 'Three rival researchers argue the next directions; only proposals that survive an attack are allowed through.',
        });
        this._emit(id, iter, 'generation', `🗣 Staged a ${turns.length}-voice debate before proposing — watch it in the Debate Chamber.`);
      }

      // Novelty gate: near-duplicates of ANY past hypothesis (or of each
      // other) are blocked before they ever enter the tournament.
      const blocked = [];
      const acceptedRows = [];
      for (const h of (result?.hypotheses || []).slice(0, genCount)) {
        if (!h?.title || !h?.statement) continue;
        const bannedHit = this._bannedNameHit(mem, h.title);
        if (bannedHit) {
          blocked.push({ title: h.title, of: { slug: `banned word "${bannedHit}"` } });
          this._emit(id, iter, 'generation',
            `🧬✗ Name gate BLOCKED "${String(h.title).slice(0, 70)}" — reuses banned name fragment "${bannedHit}"`);
          continue;
        }
        const dupe = this._gateCheck(mem, h, 'generation', acceptedRows);
        if (dupe) {
          blocked.push({ title: h.title, of: dupe });
          this._emit(id, iter, 'generation',
            `🧬✗ Novelty gate BLOCKED "${String(h.title).slice(0, 70)}" — ${Math.round(dupe.sim * 100)}% overlap with ${dupe.slug} "${String(dupe.title).slice(0, 60)}"`);
          continue;
        }
        const hyp = store.addHypothesis({
          councilId: id, slug: store.nextHypothesisSlug(id),
          title: h.title, statement: h.statement, rationale: h.rationale || '',
          origin: 'generation', bornIteration: iter,
        });
        // Citations + shared photos: keep the URLs an agent grounded this
        // proposal in (explicit "sources" field, or any links in its prose)
        // and any image it shared, so the leaderboard can show them.
        const srcs = (Array.isArray(h.sources) ? h.sources.map(String) : [])
          .concat(extractUrls(`${h.rationale || ''} ${h.statement || ''}`))
          .filter(u => /^https?:\/\//i.test(u));
        const dedupSrcs = [...new Set(srcs)].slice(0, 6);
        const imgs = (Array.isArray(h.images) ? h.images : [h.image])
          .filter(isImageUrl).map(String);
        const dedupImgs = [...new Set(imgs)].slice(0, 4);
        if (dedupSrcs.length || dedupImgs.length) {
          store.updateHypothesis(hyp.id, { sources: dedupSrcs, images: dedupImgs });
          hyp.sources = dedupSrcs;
          hyp.images = dedupImgs;
        }
        newcomers.push(hyp);
        const text = `${hyp.title} ${hyp.statement}`;
        const words = gateWords(text);
        for (const w of mem.goalWords) words.delete(w);
        acceptedRows.push({ id: hyp.id, slug: hyp.slug, title: hyp.title, words, bigrams: gateBigrams(text) });
        this._emit(id, iter, 'generation', `+ ${hyp.slug} "${hyp.title}"`, { hypothesisId: hyp.id });
      }
      if (blocked.length) {
        this._bumpStats(id, { duplicatesBlocked: blocked.length });
        this._gateNotes.set(id,
          `${blocked.length} of your last proposals were auto-blocked as near-duplicates (${blocked.map(b => `"${String(b.title).slice(0, 48)}" ≈ ${b.of.slug}`).join('; ')}).`);
      } else if (newcomers.length) {
        this._gateNotes.delete(id);
      }
      if (!newcomers.length) this._emit(id, iter, 'generation', '⚠ Generation produced no usable hypotheses this round.');
      this._bumpStats(id, { hypothesesCreated: newcomers.length });
    }

    // 3. REFLECTION: stress-test the newcomers. One batch call now also
    // returns: a PROMISE prior that seeds each survivor's starting Elo
    // (cold-start fix — early matches refine a real prior, not a coin
    // flip), the KEYSTONE assumption (deep-verification target for
    // evolution and judging), and SEMANTIC duplicate flags (catches
    // renamed mechanisms the lexical gate can't see). Zero extra calls.
    if (newcomers.length && this._isRunning(id)) {
      this._emit(id, iter, 'reflection', `Stress-testing ${newcomers.length} new candidates…`);
      const reflectionProfile = this._agentProfile(id, 'reflection');
      const dupePool = store.getHypotheses(id, { status: 'active', limit: 12 })
        .filter(h => !newcomers.some(n => n.id === h.id));
      const result = await this._call(id, reflectionPrompt({
        goal: council.goal, hypotheses: newcomers, criteria, traits: reflectionProfile,
        meta: council.meta,
        actives: dupePool,
        graveyard: (mem.graveyard || []).slice(-10),
      }), { timeoutMs: 150000, role: 'reflection', task: `stress-testing ${newcomers.map(h => h.slug).join(', ')}` });

      // Slop shield: the stricter the reflection agent, the lower the
      // slop-risk score it tolerates before a candidate is ejected outright.
      // strictness 8 (default) → reject slopRisk ≥ 5; strictness 10 → ≥ 3.
      const slopCeiling = Math.max(3, Math.min(9, 13 - reflectionProfile.traits.strictness));
      const knownSlugs = new Set([...dupePool, ...newcomers].map(h => h.slug.toUpperCase()));

      const reviews = new Map((result?.reviews || []).map(r => [String(r.slug).toUpperCase(), r]));
      for (const hyp of newcomers) {
        const r = reviews.get(hyp.slug.toUpperCase());
        if (!r) continue;
        let verdict = ['keep', 'revise', 'reject'].includes(r.verdict) ? r.verdict : 'keep';
        const slop = clampInt(r.slopRisk, 0, 1, 10);
        let slopShield = false;
        if (slop >= slopCeiling && verdict !== 'reject') {
          verdict = 'reject';
          slopShield = true;
        }

        // Semantic dedup: reflection saw the pool + graveyard; a flagged
        // mechanism-level duplicate is ejected like a gate block.
        const dupeOf = String(r.semanticDuplicateOf || '').toUpperCase();
        const semanticDupe = dupeOf && dupeOf !== 'NULL' && dupeOf !== hyp.slug.toUpperCase() && knownSlugs.has(dupeOf);
        if (semanticDupe && verdict !== 'reject') verdict = 'reject';

        // Elo seeding: the review IS a prior — testable, substantive,
        // promising candidates debut above 1200; borderline slop below.
        // Clamped to ±120 so a bad prior can never outweigh real matches.
        const promise = clampInt(r.promise, 5, 1, 10);
        const testability = clampInt(r.testability, 5, 1, 10);
        const seedElo = verdict === 'reject' ? hyp.elo
          : 1200 + Math.max(-120, Math.min(120,
            16 * (promise - 5) + 10 * (testability - 5) - 14 * (slop - 5)));

        store.updateHypothesis(hyp.id, {
          critique: [
            r.strengths ? `Strengths: ${r.strengths}` : '',
            r.weaknesses ? `Weaknesses: ${r.weaknesses}` : '',
            r.keystoneRisk ? `Keystone assumption: ${r.keystoneRisk}` : '',
            slopShield ? `Slop shield: slopRisk ${slop}/10 breached the strictness ceiling (${slopCeiling}).` : '',
            semanticDupe ? `Semantic duplicate of ${dupeOf}.` : '',
          ].filter(Boolean).join(' '),
          testability,
          slop_risk: slop,
          elo: seedElo,
          verdict,
          ...(verdict === 'reject' ? { status: 'rejected' } : {}),
        });
        if (semanticDupe) {
          this._bumpStats(id, { duplicatesBlocked: 1 });
          this._gateNotes.set(id,
            `Reflection rejected "${String(hyp.title).slice(0, 48)}" as a semantic re-statement of ${dupeOf} — same mechanism in new words. Propose genuinely different mechanisms.`);
          this._emit(id, iter, 'reflection', `🧬✗ ${hyp.slug} rejected — semantic duplicate of ${dupeOf} (same mechanism, new words).`);
          continue;
        }
        this._emit(id, iter, 'reflection',
          `${verdict === 'reject' ? (slopShield ? '🛡✗' : '✗') : '✓'} ${hyp.slug} → ${verdict}`
          + `${verdict !== 'reject' && seedElo !== 1200 ? ` (debuts at elo ${Math.round(seedElo)})` : ''}`
          + `${slop ? ` (slop ${slop}/10)` : ''}${slopShield ? ' — ejected by the slop shield' : r.weaknesses ? ` — ${String(r.weaknesses).slice(0, 130)}` : ''}`);
      }
    }

    // 4. EVOLUTION: refine the proven leaders (needs at least one ranked round).
    const evoCount = clampInt(plan?.allocation?.evolve, cfg.evolveCount, 0, cfg.evolveCount);
    if (iter >= 2 && evoCount > 0 && this._isRunning(id)) {
      // Parent selection is CLUSTER-DIVERSE: the best candidate of each
      // distinct cluster, not the overall top-N — otherwise one winning
      // family monopolizes evolution and floods the pool with siblings.
      const ranked = store.getHypotheses(id, { status: 'active', limit: 30 }).filter(h => h.matches >= 1);
      const parents = [];
      const usedClusters = new Set();
      for (const h of ranked) {
        if (parents.length >= evoCount) break;
        const key = h.cluster || h.slug;
        if (usedClusters.has(key)) continue;
        usedClusters.add(key);
        parents.push({ ...h, matchFeedback: this._lossFeedback(id, h.id) });
      }
      for (const h of ranked) { // top up if there were fewer clusters than slots
        if (parents.length >= evoCount) break;
        if (!parents.some(p => p.id === h.id)) parents.push({ ...h, matchFeedback: this._lossFeedback(id, h.id) });
      }
      // Diversity pressure (island-model style): every 4th round the pair
      // of MOST-DISTANT cluster leaders gets a crossover order (fuse the
      // mechanisms); otherwise a 20% wildcard chance orders one radical
      // mutation of a mid-ranked candidate instead of polite refinement.
      let crossover = null;
      let wildcard = null;
      if (parents.length >= 2 && iter % 4 === 2) {
        let worst = null;
        for (let i = 0; i < parents.length; i += 1) {
          for (let j = i + 1; j < parents.length; j += 1) {
            const sim = gateOverlap(
              gateWords(`${parents[i].title} ${parents[i].statement}`),
              gateWords(`${parents[j].title} ${parents[j].statement}`));
            if (!worst || sim < worst.sim) worst = { sim, a: parents[i].slug, b: parents[j].slug };
          }
        }
        if (worst) crossover = { a: worst.a, b: worst.b };
      } else if (parents.length && Math.random() < 0.2) {
        const mid = ranked.slice(Math.ceil(ranked.length / 3), Math.ceil((ranked.length * 2) / 3));
        const pick = mid[Math.floor(Math.random() * mid.length)];
        if (pick && !parents.some(p => p.id === pick.id)) {
          parents[parents.length - 1] = { ...pick, matchFeedback: this._lossFeedback(id, pick.id) };
        }
        wildcard = parents[parents.length - 1]?.slug || null;
      }

      if (parents.length) {
        this._emit(id, iter, 'evolution',
          `Evolving ${parents.map(p => p.slug).join(', ')}${crossover ? ` — 🧬 CROSSOVER ${crossover.a}×${crossover.b} (most distant families)` : wildcard ? ` — 🃏 WILDCARD mutation of ${wildcard}` : ' (best of each cluster)'}…`);
        const result = await this._call(id, evolutionPrompt({
          goal: council.goal, parents, evidenceConsensus,
          traits: this._agentProfile(id, 'evolution'),
          bannedNames: mem.bannedNames,
          meta: council.meta,
          crossover, wildcard,
        }), { timeoutMs: 150000, role: 'evolution', task: `evolving ${parents.map(p => p.slug).join(', ')}` });
        for (const r of (result?.refinements || []).slice(0, parents.length)) {
          if (!r?.title || !r?.statement) continue;
          const parent = parents.find(p => p.slug.toUpperCase() === String(r.parentSlug).toUpperCase()) || parents[0];
          // Children may resemble their parent, but a near-verbatim repeat
          // of anything else in history is still blocked — and a banned
          // name fragment is banned for children too.
          const bannedHit = this._bannedNameHit(mem, r.title);
          if (bannedHit) {
            this._bumpStats(id, { duplicatesBlocked: 1 });
            this._emit(id, iter, 'evolution',
              `🧬✗ Name gate BLOCKED evolved "${String(r.title).slice(0, 70)}" — reuses banned name fragment "${bannedHit}"`);
            continue;
          }
          const dupe = this._gateCheck(mem, r, 'evolution', [], new Set([parent.id]));
          if (dupe) {
            this._bumpStats(id, { duplicatesBlocked: 1 });
            this._emit(id, iter, 'evolution',
              `🧬✗ Novelty gate BLOCKED evolved "${String(r.title).slice(0, 70)}" — ${Math.round(dupe.sim * 100)}% overlap with ${dupe.slug}`);
            continue;
          }
          const child = store.addHypothesis({
            councilId: id, slug: store.nextHypothesisSlug(id),
            title: r.title, statement: r.statement, rationale: r.rationale || '',
            parentId: parent.id, origin: 'evolution', bornIteration: iter,
            // Children inherit most of the parent's proven standing (small
            // regression toward the mean) instead of a cold 1200 debut.
            elo: Math.max(1140, Math.min(1320, parent.elo - 25)),
          });
          if (r.addressed) store.updateHypothesis(child.id, { verdict: 'evolved', critique: `Evolved from ${parent.slug}: ${r.addressed}` });
          newcomers.push(child);
          this._emit(id, iter, 'evolution', `↳ ${parent.slug} evolved into ${child.slug} "${child.title}"`, { hypothesisId: child.id });
          this._bumpStats(id, { hypothesesCreated: 1 });
        }
      }
    }

    // 5. RANKING: the Elo tournament. Matches run in conflict-free
    // parallel batches (no hypothesis fights twice in one batch), sized
    // by the power dial — with the hybrid brain, both providers judge
    // simultaneously and the round finishes in a fraction of the time.
    const budget = clampInt(plan?.allocation?.matches, cfg.matchesPerIteration, 1, cfg.matchesPerIteration);
    const pairs = this._schedulePairs(id, newcomers, budget);

    // Balanced-position calibration: the single most DECISIVE pairing
    // each round (two established top-quartile contenders, close Elo)
    // gets judged twice with the cards swapped — split verdicts become
    // honest draws. Gated off at Eco power to protect quota.
    let hsKey = '';
    if (cfg.matchesPerIteration >= 5 && pairs.length) {
      const ranked = store.getHypotheses(id, { status: 'active', limit: 60 });
      const qElo = ranked.length >= 4 ? ranked[Math.max(0, Math.ceil(ranked.length / 4) - 1)].elo : -Infinity;
      let best = null;
      for (const [x, y] of pairs) {
        if (x.matches < 1 || y.matches < 1) continue;
        if (x.elo < qElo || y.elo < qElo) continue;
        const gap = Math.abs(x.elo - y.elo);
        if (gap > 90) continue;
        const value = Math.min(x.elo, y.elo) - gap;
        if (!best || value > best.value) best = { key: [x.id, y.id].sort().join('|'), value };
      }
      hsKey = best?.key || '';
    }

    const lanes = Math.max(1, clampInt(cfg.parallelLanes, 1, 1, 4));
    if (pairs.length) {
      this._emit(id, iter, 'ranking',
        `Tournament round: ${pairs.length} matches${lanes > 1 ? ` · ${lanes} judge lanes in parallel` : ''}${hsKey ? ' · 1 high-stakes match double-judged' : ''}…`);
    }
    for (const batch of conflictFreeBatches(pairs, lanes)) {
      if (!this._isRunning(id)) return;
      const outcomes = await Promise.allSettled(
        batch.map(([a, b]) => this._judgePair(council, iter, a, b, criteria,
          { calibrate: Boolean(hsKey) && [a.id, b.id].sort().join('|') === hsKey }))
      );
      // A quota death inside a parallel batch must still pause the
      // council; lesser errors only cost that one match.
      const quota = outcomes.find(o => o.status === 'rejected' && o.reason instanceof QuotaError);
      if (quota) throw quota.reason;
      const failed = outcomes.find(o => o.status === 'rejected');
      if (failed) throw failed.reason;
    }

    // 6. PROXIMITY: cluster + dedup the pool.
    if (cfg.proximityEvery > 0 && iter % cfg.proximityEvery === 0 && this._isRunning(id)) {
      const actives = store.getHypotheses(id, { status: 'active', limit: 40 });
      if (actives.length >= 4) {
        const result = await this._call(id, proximityPrompt({
          goal: council.goal, hypotheses: actives,
          traits: this._agentProfile(id, 'proximity'),
        }), { timeoutMs: 120000, role: 'proximity', task: `clustering ${actives.length} active hypotheses` });
        if (result?.clusters) {
          const bySlug = new Map(actives.map(h => [h.slug.toUpperCase(), h]));
          for (const cluster of result.clusters) {
            for (const slug of (cluster.members || [])) {
              const hyp = bySlug.get(String(slug).toUpperCase());
              if (hyp) store.updateHypothesis(hyp.id, { cluster: String(cluster.name || '').slice(0, 60) });
            }
          }
          let merged = 0;
          for (const dup of (result.duplicates || [])) {
            let redundant = bySlug.get(String(dup.redundant).toUpperCase());
            let keep = bySlug.get(String(dup.keep).toUpperCase());
            if (redundant && keep && redundant.id !== keep.id) {
              // Never retire the stronger candidate: the proven (higher-Elo)
              // side survives the merge regardless of the judge's labeling.
              if (redundant.elo > keep.elo) [redundant, keep] = [keep, redundant];
              store.updateHypothesis(redundant.id, { status: 'merged', critique: `Merged into ${keep.slug}: ${dup.reason || 'near-duplicate'}` });
              merged += 1;
              this._emit(id, iter, 'proximity', `≈ ${redundant.slug} merged into ${keep.slug} (${String(dup.reason || 'near-duplicate').slice(0, 100)})`);
            }
          }
          this._emit(id, iter, 'proximity', `Clustered into ${result.clusters.length} groups${merged ? `, ${merged} duplicates retired` : ''}.`);
        }
      }
    }

    // 6b. META-REVIEW (the council learns its own taste): every Nth
    // iteration one call reads ALL recent match rationales + critiques
    // and distills standing lessons — what keeps winning, what keeps
    // losing and why. Lessons are injected into generation, reflection,
    // evolution and the supervisor from the very next call.
    if (iter % META_EVERY === 0 && this._isRunning(id) && store.countMatches(id) >= 6) {
      this._emit(id, iter, 'meta', '📚 Meta-review: synthesizing lessons from the tournament so far…');
      const recent = store.getMatches(id, 15).map(m => ({
        winnerSlug: m.winner_slug,
        loserSlug: m.winner_id === m.a_id ? m.b_slug : m.a_slug,
        rationale: m.rationale,
      }));
      const result = await this._call(id, metaReviewPrompt({
        goal: council.goal, criteria,
        matches: recent,
        hypotheses: store.getHypotheses(id, { status: 'active', limit: 12 }),
        graveyard: (mem.graveyard || []).slice(-12),
        traits: this._agentProfile(id, 'meta'),
      }), { timeoutMs: 150000, role: 'meta', task: 'distilling tournament lessons' });
      if (result && Array.isArray(result.lessons) && result.lessons.length) {
        const meta = {
          lessons: result.lessons.map(String).slice(0, 4),
          winningPattern: String(result.winningPattern || '').slice(0, 300),
          losingPattern: String(result.losingPattern || '').slice(0, 300),
          reflectionFocus: String(result.reflectionFocus || '').slice(0, 300),
          updatedAt: new Date().toISOString(),
          iteration: iter,
        };
        store.updateCouncil(id, { meta });
        council.meta = meta; // later stages this round see it too
        this._emit(id, iter, 'meta',
          `📚 Lessons learned: ${meta.lessons.map(l => `“${String(l).slice(0, 90)}”`).join(' · ')}`, { meta });
      } else {
        this._emit(id, iter, 'meta', '⚠ Meta-review produced no usable lessons this round.');
      }
    }

    // 6c. FALSIFICATION (reality check): when web search is enabled,
    // every Nth iteration the tournament leader faces the live
    // literature — prior art and disconfirming evidence are hunted
    // POPPER-style; survival is recorded, failures feed evolution.
    if (cfg.webSearch && iter % FALSIFY_EVERY === 0 && this._isRunning(id)) {
      const leader = store.getHypotheses(id, { status: 'active', limit: 1 })
        .find(h => h.matches >= 1);
      if (leader) {
        this._emit(id, iter, 'reflection', `🔬 Falsification probe: ${leader.slug} "${leader.title}" faces the live literature…`);
        const result = await this._call(id, falsifyPrompt({
          goal: council.goal, hypothesis: leader, criteria,
          traits: this._agentProfile(id, 'falsify'),
        }), { timeoutMs: 220000, webSearch: true, role: 'reflection', task: `falsification probe on ${leader.slug}` });
        if (result) {
          const priorArt = (Array.isArray(result.priorArt) ? result.priorArt : []).slice(0, 4);
          const disconfirming = (Array.isArray(result.disconfirming) ? result.disconfirming : []).slice(0, 4);
          const survives = result.survives !== false;
          const note = String(result.note || '').slice(0, 280);
          // Citations keep their URL so the UI can render a clickable source.
          const cite = (name, url) => (url ? `${name} (${String(url).slice(0, 220)})` : String(name || ''));
          const stamp = [
            `Falsification probe (iter ${iter}): ${survives ? 'SURVIVED the literature' : 'CHALLENGED by the literature'}.`,
            priorArt.length ? `Prior art: ${priorArt.map(p => cite(p.name, p.url)).join(', ')}.` : '',
            disconfirming.length ? `Disconfirming: ${disconfirming.map(d => cite(String(d.claim).slice(0, 90), d.source)).join('; ')}.` : '',
            note,
          ].filter(Boolean).join(' ');
          const updates = { critique: `${leader.critique ? `${leader.critique} ` : ''}${stamp}`.slice(0, 1800) };
          // Prior art or contradiction = real-world Elo penalty; survival = small badge bonus.
          if (!survives) updates.elo = leader.elo - 60;
          else if (!priorArt.length && !disconfirming.length) updates.elo = leader.elo + 15;
          store.updateHypothesis(leader.id, updates);
          this._emit(id, iter, 'reflection',
            survives
              ? `🔬✓ ${leader.slug} survived the falsification probe${priorArt.length ? ` (prior art noted: ${priorArt.map(p => cite(p.name, p.url)).join(', ')})` : ' — no prior art, no contradiction found'}.`
              : `🔬✗ ${leader.slug} challenged by the live literature (elo −60): ${note || disconfirming.map(d => cite(d.claim, d.source)).join('; ').slice(0, 220)}`,
            { falsify: { slug: leader.slug, survives, priorArt: priorArt.length, disconfirming: disconfirming.length } });
        }
      }
    }

    // 6d. DEEP VERIFICATION (co-scientist style): on the even rounds
    // falsification skips, the strongest not-yet-audited leader has its
    // argument decomposed into load-bearing assumptions, each audited
    // independently — web-grounded when search is on. One audit per
    // hypothesis, ever (the critique stamp is the marker). A broken
    // assumption costs real Elo; the repair note becomes evolution's
    // work order via the critique field.
    if (iter % DEEP_VERIFY_EVERY === 0 && iter % FALSIFY_EVERY !== 0 && this._isRunning(id)) {
      const target = store.getHypotheses(id, { status: 'active', limit: 5 })
        .find(h => h.matches >= 2 && !String(h.critique || '').includes('Deep verification'));
      if (target) {
        this._emit(id, iter, 'reflection',
          `🧪 Deep verification: decomposing ${target.slug} "${target.title}" into its load-bearing assumptions…`);
        const result = await this._call(id, deepVerifyPrompt({
          goal: council.goal, hypothesis: target, criteria,
          traits: this._agentProfile(id, 'falsify'),
          webSearch: cfg.webSearch,
        }), {
          timeoutMs: cfg.webSearch ? 220000 : 150000, webSearch: cfg.webSearch,
          role: 'reflection', task: `deep-verifying ${target.slug}`,
        });
        if (result && Array.isArray(result.assumptions) && result.assumptions.length) {
          const audited = result.assumptions.slice(0, 5).map(a => ({
            claim: String(a.claim || '').slice(0, 160),
            status: ['holds', 'shaky', 'broken'].includes(a.status) ? a.status : 'shaky',
            evidence: String(a.evidence || '').slice(0, 160),
            source: String(a.source || '').slice(0, 220),
          }));
          const broken = audited.filter(a => a.status === 'broken');
          const shaky = audited.filter(a => a.status === 'shaky');
          // Trust the per-assumption audit over the model's own summary field.
          const overall = broken.length ? 'broken' : shaky.length ? 'cracked' : 'sound';
          const repair = String(result.repairNote || '').slice(0, 220);
          const src = (a) => (a.source ? ` (${a.source})` : '');
          const stamp = [
            `Deep verification (iter ${iter}): ${overall.toUpperCase()} — ${audited.length} load-bearing assumptions audited, ${broken.length} broken, ${shaky.length} shaky.`,
            ...broken.map(a => `BROKEN: "${a.claim}" — ${a.evidence}${src(a)}.`),
            ...shaky.slice(0, 2).map(a => `Shaky: "${a.claim}"${src(a)}.`),
            repair ? `Repair: ${repair}` : '',
          ].filter(Boolean).join(' ');
          const delta = overall === 'broken' ? -70 : overall === 'cracked' ? -20 : 20;
          store.updateHypothesis(target.id, {
            critique: `${target.critique ? `${target.critique} ` : ''}${stamp}`.slice(0, 1800),
            elo: target.elo + delta,
            ...(overall !== 'sound' ? { verdict: 'revise' } : {}),
          });
          this._bumpStats(id, { deepVerifications: 1 });
          this._emit(id, iter, 'reflection',
            overall === 'sound'
              ? `🧪✓ ${target.slug} deep-verified: all ${audited.length} load-bearing assumptions hold (elo +20).${result.note ? ` ${String(result.note).slice(0, 140)}` : ''}`
              : overall === 'cracked'
                ? `🧪⚠ ${target.slug} cracked under deep verification (elo −20): ${shaky.length} shaky assumption${shaky.length > 1 ? 's' : ''} — "${shaky[0]?.claim || ''}"${src(shaky[0] || {})}${repair ? ` · Repair: ${repair}` : ''}`
                : `🧪✗ ${target.slug} BROKEN under deep verification (elo −70): "${broken[0].claim}" — ${broken[0].evidence}${src(broken[0])}${repair ? ` · Repair: ${repair}` : ''}`,
            { deepVerify: { slug: target.slug, overall, broken: broken.length, shaky: shaky.length } });
        } else {
          this._emit(id, iter, 'reflection', `⚠ Deep verification of ${target.slug} returned nothing usable — will retry on a later round.`);
        }
      }
    }

    // 7. PRUNE: keep the pool within budget.
    const pool = store.getHypotheses(id, { status: 'active', limit: 200 });
    if (pool.length > cfg.maxActive) {
      for (const hyp of pool.slice(cfg.maxActive)) {
        store.updateHypothesis(hyp.id, { status: 'archived' });
      }
      this._emit(id, iter, 'system', `Pool pruned to top ${cfg.maxActive} by Elo (${pool.length - cfg.maxActive} archived).`);
    }

    // Iteration complete.
    const top = store.getHypotheses(id, { status: 'active', limit: 3 });
    store.updateCouncil(id, { iteration: iter });
    this._emit(id, iter, 'system',
      `Iteration ${iter} complete. Leader: ${top[0] ? `${top[0].slug} "${top[0].title}" (elo ${Math.round(top[0].elo)})` : '(none yet)'}`,
      { leaderboard: top.map(h => ({ slug: h.slug, title: h.title, elo: Math.round(h.elo) })) });
  }

  // ── Diversity internals ────────────────────────────────────

  /**
   * The council's long-term memory, compiled fresh each round from the FULL
   * hypothesis history (every status — the live pool is capped at ~24, but
   * hundreds may have been explored and retired). Returns:
   *   total      — lifetime hypothesis count
   *   occupancy  — territory-map lines per cluster, saturated ones flagged
   *   bannedNames— invented title names overused across the history
   *   graveyard  — recently retired titles (so they aren't resurrected)
   *   rows       — precomputed word sets for the novelty gate
   */
  _memoryContext(councilId, goal) {
    const memory = store.getHypothesisMemory(councilId);
    const goalWords = gateWords(goal);

    // Territory map: lifetime occupancy per cluster, plus the peak Elo
    // each territory ever reached (MAP-Elites-style illumination: a
    // strong leader in a barely-explored cluster marks premium ground).
    const clusters = new Map();
    for (const h of memory) {
      if (!h.cluster) continue;
      const c = clusters.get(h.cluster) || { total: 0, active: 0, bestElo: 0 };
      c.total += 1;
      if (h.status === 'active') c.active += 1;
      c.bestElo = Math.max(c.bestElo, Number(h.elo) || 0);
      clusters.set(h.cluster, c);
    }
    const occupancy = [...clusters.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 14)
      .map(([name, c]) =>
        `- ${name}: ${c.total} hypotheses tried (${c.active} still alive, peak elo ${Math.round(c.bestElo)})${c.total >= CLUSTER_SATURATION ? ' — SATURATED, CLOSED' : ''}`);
    const hotThin = [...clusters.entries()]
      .filter(([, c]) => c.total <= 3 && c.bestElo >= 1230)
      .sort((a, b) => b[1].bestElo - a[1].bestElo)
      .slice(0, 5)
      .map(([name]) => name);
    if (hotThin.length) {
      occupancy.push(`- 🔥 HOT-BUT-THIN territories (a strong leader, barely explored — premium ground for new work): ${hotThin.join('; ')}`);
    }

    // Banned names: invented capitalized/CamelCase title words that recur
    // across many hypotheses but aren't part of the goal's own vocabulary.
    // Counted at THREE granularities, because clone families mutate:
    //   - whole invented names      (LatentForge × 3        → ban "LatentForge")
    //   - CamelCase components      (LatentForge, LatentKiln,
    //                                LatentAnvil…           → ban "Latent")
    //   - recurring plain title words ("Hammering", "Baking" templates)
    const nameCounts = new Map();   // whole CamelCase names
    const partCounts = new Map();   // CamelCase components
    const wordCounts = new Map();   // plain title words
    for (const h of memory) {
      const seen = new Set();
      for (const raw of String(h.title || '').split(/[\s:–—-]+/)) {
        const w = raw.replace(/[^A-Za-z0-9]/g, '');
        if (w.length < 4 || !/^[A-Z]/.test(w) || seen.has(w)) continue;
        if (goalWords.has(w.toLowerCase()) || GATE_STOPWORDS.has(w.toLowerCase())) continue;
        seen.add(w);
        if (/[a-z0-9][A-Z]/.test(w)) {
          // Invented-name shape (PolyLoop, LatentForge): count the whole
          // name AND each component, so sibling clones share a counter.
          nameCounts.set(w, (nameCounts.get(w) || 0) + 1);
          for (const part of w.split(/(?<=[a-z0-9])(?=[A-Z])/)) {
            if (part.length < 4 || goalWords.has(part.toLowerCase()) || GATE_STOPWORDS.has(part.toLowerCase())) continue;
            if (!seen.has(`part:${part}`)) {
              seen.add(`part:${part}`);
              partCounts.set(part, (partCounts.get(part) || 0) + 1);
            }
          }
        } else {
          // Ordinary title-case words ban only at a much higher bar —
          // they're usually innocent, unless they're a stuck template
          // ("Hammering … into Art" nine rounds in a row).
          wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
        }
      }
    }
    const overused = (counts, threshold) => [...counts.entries()]
      .filter(([, n]) => n >= threshold)
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
    const bannedNames = [...new Set([
      ...overused(nameCounts, NAME_OVERUSE),
      ...overused(partCounts, NAME_OVERUSE),
      ...overused(wordCounts, NAME_OVERUSE * 2),
    ])].slice(0, 18);

    // Graveyard: most recently retired titles.
    const graveyard = memory
      .filter(h => h.status !== 'active')
      .slice(-18)
      .map(h => `- ${h.slug} "${h.title}" (${h.status})`);

    // Precomputed word + bigram sets for the novelty gate (goal words
    // removed — every hypothesis legitimately shares the goal's vocabulary).
    const rows = memory.map(h => {
      const text = `${h.title} ${h.statement}`;
      const words = gateWords(text);
      for (const w of goalWords) words.delete(w);
      return { id: h.id, slug: h.slug, title: h.title, words, bigrams: gateBigrams(text) };
    });

    return { total: memory.length, occupancy, bannedNames, graveyard, rows, goalWords };
  }

  /**
   * Hard enforcement of the banned-name list: prompt-level bans alone let
   * clone families through (LatentForge → LatentAnvil → LatentKiln…).
   * Returns the banned fragment a title reuses, or null if clean.
   */
  _bannedNameHit(mem, title) {
    if (!mem.bannedNames?.length) return null;
    const tokens = new Set(gateTokens(title)); // CamelCase already split
    for (const banned of mem.bannedNames) {
      for (const part of String(banned).split(/(?<=[a-z0-9])(?=[A-Z])/)) {
        if (part.length >= 4 && tokens.has(part.toLowerCase())) return banned;
      }
    }
    return null;
  }

  /**
   * Novelty gate: block a candidate that is lexically a near-duplicate of
   * anything the council has ever produced. Pure string math — no API call.
   * Returns null if novel, or the closest prior hypothesis if blocked.
   */
  _gateCheck(mem, candidate, origin, extraRows = [], skipIds = new Set()) {
    const text = `${candidate.title} ${candidate.statement}`;
    const words = gateWords(text);
    for (const w of mem.goalWords) words.delete(w);
    if (words.size < 4) return null; // too little signal to judge
    const bigrams = gateBigrams(text);
    const t = GATE_THRESHOLD[origin] || GATE_THRESHOLD.generation;
    let worst = null;
    for (const row of [...mem.rows, ...extraRows]) {
      if (skipIds.has(row.id) || row.words.size < 4) continue;
      const wordSim = gateOverlap(words, row.words);
      const bigramSim = row.bigrams && row.bigrams.size >= 4 ? gateOverlap(bigrams, row.bigrams) : 0;
      // Either signal fires: shared vocabulary OR shared distinctive phrases.
      const score = Math.max(wordSim / t.words, bigramSim / t.bigrams);
      if (score >= 1 && (!worst || score > worst.score)) {
        worst = { ...row, score, sim: Math.max(wordSim, bigramSim) };
      }
    }
    return worst;
  }

  // ── Ranking internals ──────────────────────────────────────

  /** Pick this round's pairings: newcomers debut first, then title matches. */
  _schedulePairs(councilId, newcomers, budget) {
    const actives = store.getHypotheses(councilId, { status: 'active', limit: 60 });
    if (actives.length < 2) return [];
    const byId = new Map(actives.map(h => [h.id, h]));
    const pairs = [];
    const seen = new Set();
    const pairKey = (a, b) => [a.id, b.id].sort().join('|');

    const pickOpponent = (h) => {
      const others = actives.filter(o => o.id !== h.id && !seen.has(pairKey(h, o)));
      if (!others.length) return null;
      const ranked = others.filter(o => o.matches > 0);
      const candidates = ranked.length ? ranked : others;
      // Prefer opponents of similar strength so matches are informative.
      candidates.sort((x, y) => Math.abs(x.elo - h.elo) - Math.abs(y.elo - h.elo));
      return candidates[Math.floor(Math.random() * Math.min(3, candidates.length))];
    };

    for (const raw of newcomers) {
      if (pairs.length >= budget) break;
      const h = byId.get(raw.id);
      if (!h) continue; // rejected or merged during reflection/proximity
      const opp = pickOpponent(h);
      if (!opp) continue;
      pairs.push([h, opp]);
      seen.add(pairKey(h, opp));
    }

    // Fill the rest of the budget with the most INFORMATIVE matches
    // (active learning): close Elo = uncertain outcome, few matches =
    // unsettled rating, cross-cluster = comparable on the criteria.
    // Blowout rematches between settled veterans carry no information
    // and are skipped — every judge call should move the standings.
    const recentKeys = new Set(store.getMatches(councilId, 40).map(m => [m.a_id, m.b_id].sort().join('|')));
    const cands = [];
    for (let i = 0; i < actives.length; i += 1) {
      for (let j = i + 1; j < actives.length; j += 1) {
        const x = actives[i], y = actives[j];
        const key = pairKey(x, y);
        if (seen.has(key)) continue;
        const gap = Math.abs(x.elo - y.elo);
        if (gap > 250 && x.matches > 0 && y.matches > 0) continue;
        let score = -gap / 60;
        score += 2.5 / (1 + Math.min(x.matches, y.matches));      // unsettled ratings first
        if (x.cluster && y.cluster && x.cluster !== y.cluster) score += 0.8; // cross-family comparisons
        if (recentKeys.has(key)) score -= 2;                       // don't re-litigate fresh verdicts
        if (i < 4) score += 0.5;                                   // clarity at the top matters most
        cands.push({ x, y, key, score });
      }
    }
    cands.sort((p, q) => q.score - p.score);
    for (const c of cands) {
      if (pairs.length >= budget) break;
      if (seen.has(c.key)) continue;
      pairs.push([c.x, c.y]);
      seen.add(c.key);
    }
    return pairs;
  }

  async _judgePair(council, iter, a, b, criteria = [], { calibrate = false } = {}) {
    const id = council.id;
    // Re-fetch both rows: a hypothesis can play twice in one round, and the
    // second match must start from its post-first-match Elo.
    a = store.getHypothesis(a.id) || a;
    b = store.getHypothesis(b.id) || b;
    // Randomize presentation order so the judge can't develop an A-bias.
    const flip = Math.random() < 0.5;
    const [first, second] = flip ? [b, a] : [a, b];

    const ask = (f, s, lane = '') => this._call(id, rankingPrompt({
      goal: council.goal, a: f, b: s, criteria,
      traits: this._agentProfile(id, 'ranking'),
      debate: calibrate,
    }), {
      timeoutMs: 120000, role: 'ranking', lane,
      task: `${calibrate ? '⚖ high-stakes double-judging' : 'judging'} ${a.slug} vs ${b.slug}`,
    });

    let result;
    let scoreOrder = [first, second]; // which hypothesis the scores' a/b keys refer to
    if (calibrate) {
      // Balanced-position calibration (Wang 2023) + panel-of-judges
      // (Verga 2024): the match is judged TWICE with the cards swapped —
      // in hybrid mode by two different model families. Disagreement
      // means the match is a genuine toss-up → honest draw, instead of
      // letting card position or one judge's bias crown a leader.
      const hybrid = this.brain.usesHybrid?.();
      const [o1, o2] = await Promise.allSettled([
        ask(first, second, hybrid ? 'gemini' : ''),
        ask(second, first, hybrid ? 'openrouter' : ''),
      ]);
      const quota = [o1, o2].find(o => o.status === 'rejected' && o.reason instanceof QuotaError);
      if (quota) throw quota.reason;
      const r1 = o1.status === 'fulfilled' ? o1.value : null;
      const r2 = o2.status === 'fulfilled' ? o2.value : null;
      const judged = (r, f, s) => (r && ['A', 'B'].includes(r.winner) ? (r.winner === 'A' ? f : s) : null);
      const w1 = judged(r1, first, second);
      const w2 = judged(r2, second, first);

      if (w1 && w2 && w1.id !== w2.id) {
        // Split decision → draw: no Elo moves, both gain a match.
        store.updateHypothesis(a.id, { matches: a.matches + 1 });
        store.updateHypothesis(b.id, { matches: b.matches + 1 });
        store.addMatch({
          councilId: id, iteration: iter, aId: a.id, bId: b.id, winnerId: null,
          rationale: `Split decision — two independent judges${hybrid ? ' from different model families' : ''} disagreed under order swap; scored a draw.`,
          scores: { calibration: 'split', presentedFirst: first.slug },
          eloABefore: a.elo, eloAAfter: a.elo, eloBBefore: b.elo, eloBAfter: b.elo,
        });
        this._bumpStats(id, { matchesPlayed: 1 });
        const splitReasoning = r1?.reasoning || r2?.reasoning || '';
        if (splitReasoning) {
          this._emitDebate(id, iter, {
            kind: 'ranking',
            title: `⚔ ${a.slug} vs ${b.slug} — high-stakes match`,
            turns: parseDebate(splitReasoning),
            summary: `Split decision → draw: two independent judges disagreed under order swap. No Elo change.`,
            refs: { a: a.slug, b: b.slug, winner: null, aTitle: a.title, bTitle: b.title },
          });
        }
        this._emit(id, iter, 'ranking',
          `⚖ ${a.slug} vs ${b.slug} — SPLIT DECISION (independent judges disagreed under order swap) → draw, no Elo change.`,
          { match: { a: a.slug, b: b.slug, draw: true } });
        return;
      }
      if (w1) { result = r1; scoreOrder = [first, second]; }
      else if (w2) { result = r2; scoreOrder = [second, first]; }
      else result = null;
    } else {
      result = await ask(first, second);
    }

    if (!result || !['A', 'B'].includes(result.winner)) {
      this._emit(id, iter, 'ranking', `⚠ Judge returned no verdict for ${a.slug} vs ${b.slug} — skipped.`);
      return;
    }
    const winner = result.winner === 'A' ? scoreOrder[0] : scoreOrder[1];
    const loser = winner.id === scoreOrder[0].id ? scoreOrder[1] : scoreOrder[0];

    // Elo update with uncertainty decay (Glicko-style): rookies move
    // fast (K≈48 on debut), proven veterans stabilize (K→16) — one
    // noisy judgment can no longer topple a 20-match leader.
    const expectedW = 1 / (1 + Math.pow(10, (loser.elo - winner.elo) / 400));
    const kOf = h => 16 + 32 / (1 + (h.matches || 0));
    const winnerAfter = winner.elo + kOf(winner) * (1 - expectedW);
    const loserAfter = loser.elo - kOf(loser) * (1 - expectedW);

    // Per-criterion judge scores ('a' = first card, 'b' = second card),
    // folded into each hypothesis as running averages.
    const perCriterion = (Array.isArray(result.perCriterion) ? result.perCriterion : [])
      .filter(row => row && row.criterion);
    const applyScores = (hyp, sideKey, won, eloAfter) => {
      const m = hyp.matches;
      const scores = { ...(hyp.scores || {}) };
      for (const row of perCriterion) {
        const name = String(row.criterion).trim().slice(0, 28);
        const val = clampInt(row[sideKey], 0, 1, 10);
        if (!name || !val) continue;
        const old = Number(scores[name]) || 0;
        scores[name] = round1(old > 0 ? (old * m + val) / (m + 1) : val);
      }
      // Legacy display columns mirror the first two criteria.
      const names = Object.keys(scores);
      store.updateHypothesis(hyp.id, {
        elo: eloAfter,
        matches: m + 1,
        wins: hyp.wins + (won ? 1 : 0),
        losses: hyp.losses + (won ? 0 : 1),
        scores,
        novelty: Number(scores[names[0]]) || hyp.novelty,
        plausibility: Number(scores[names[1]]) || hyp.plausibility,
      });
    };
    applyScores(scoreOrder[0], 'a', winner.id === scoreOrder[0].id, winner.id === scoreOrder[0].id ? winnerAfter : loserAfter);
    applyScores(scoreOrder[1], 'b', winner.id === scoreOrder[1].id, winner.id === scoreOrder[1].id ? winnerAfter : loserAfter);

    store.addMatch({
      councilId: id, iteration: iter, aId: a.id, bId: b.id, winnerId: winner.id,
      rationale: result.rationale || '',
      scores: { perCriterion, presentedFirst: scoreOrder[0].slug, ...(calibrate ? { calibration: 'agreed' } : {}) },
      eloABefore: a.elo, eloAAfter: a.id === winner.id ? winnerAfter : loserAfter,
      eloBBefore: b.elo, eloBAfter: b.id === winner.id ? winnerAfter : loserAfter,
    });
    this._bumpStats(id, { matchesPlayed: 1 });
    // A high-stakes match is argued out in a structured debate — stream it
    // to the Debate Chamber so the operator sees WHY the leader prevailed.
    if (calibrate && result?.reasoning) {
      this._emitDebate(id, iter, {
        kind: 'ranking',
        title: `⚔ ${a.slug} vs ${b.slug} — high-stakes match`,
        turns: parseDebate(result.reasoning),
        summary: `Ruling: ${winner.slug} "${String(winner.title).slice(0, 60)}" prevailed. ${String(result.rationale || '').slice(0, 160)}`,
        refs: { a: a.slug, b: b.slug, winner: winner.slug, aTitle: a.title, bTitle: b.title },
      });
    }
    this._emit(id, iter, 'ranking',
      `⚔ ${winner.slug} def. ${loser.slug} (${Math.round(winner.elo)}→${Math.round(winnerAfter)})${calibrate ? ' — double-judged, both agreed' : ''} — ${String(result.rationale || '').slice(0, 160)}`,
      { match: { winner: winner.slug, loser: loser.slug } });
  }

  /** Most recent rationale from a match this hypothesis lost — fed to evolution. */
  _lossFeedback(councilId, hypId) {
    const match = store.getMatches(councilId, 50)
      .find(m => (m.a_id === hypId || m.b_id === hypId) && m.winner_id && m.winner_id !== hypId);
    return match ? `Lost to ${match.winner_slug}: ${match.rationale}` : '';
  }

  // ── Closed loop: evidence interpretation ───────────────────

  async _processEvidence(council, evidence, iter, cfg) {
    const id = council.id;
    const n = clampInt(cfg.evidenceInstances, 3, 2, 5);
    store.updateEvidence(evidence.id, { status: 'analyzing' });
    this._emit(id, iter, 'interpret', `Analyzing evidence with ${n} independent instances…`);

    const top = store.getHypotheses(id, { status: 'active', limit: 8 });
    let analyses;
    try {
      const interpretProfile = this._agentProfile(id, 'interpret');
      analyses = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          this._call(id, interpretPrompt({
            goal: council.goal, evidence: evidence.content, topHypotheses: top, instance: i + 1,
            traits: interpretProfile,
          }), { timeoutMs: 150000, role: 'interpret', task: `analyzing evidence (instance ${i + 1}/${n})` })
        )
      );
    } catch (err) {
      // Quota died mid-analysis: requeue so it reruns cleanly after resume.
      store.updateEvidence(evidence.id, { status: 'queued' });
      throw err;
    }

    const valid = analyses.filter(a => a && Array.isArray(a.keyFindings));
    if (!valid.length) {
      store.updateEvidence(evidence.id, { status: 'failed' });
      this._emit(id, iter, 'interpret', '⚠ All analysis instances failed — evidence marked failed.');
      return;
    }

    const consensus = await this._call(id, consensusPrompt({
      goal: council.goal, analyses: valid,
      traits: this._agentProfile(id, 'interpret'),
    }), { timeoutMs: 150000, role: 'interpret', task: `merging ${valid.length} analyses into consensus` });
    store.updateEvidence(evidence.id, {
      status: 'done',
      analyses: valid,
      consensus: consensus || { summary: '(consensus pass failed — raw analyses retained)', agreedFindings: [] },
    });
    this._bumpStats(id, { evidenceProcessed: 1 });
    this._emit(id, iter, 'interpret',
      `Consensus from ${valid.length}/${n} instances: ${String(consensus?.summary || (consensus?.agreedFindings || []).join('; ') || 'recorded').slice(0, 220)}`,
      { evidenceId: evidence.id });
  }

  _latestConsensusSummary(councilId) {
    const done = store.getEvidence(councilId, 5).find(e => e.status === 'done');
    if (!done) return '';
    const c = done.consensus || {};
    return [
      c.summary || '',
      (c.agreedFindings || []).length ? `Agreed findings: ${c.agreedFindings.join('; ')}` : '',
    ].filter(Boolean).join('\n').slice(0, 1500);
  }

  // ── Quota pause / probe / resume ───────────────────────────

  _pause(councilId, reason, detail = '') {
    const council = store.getCouncil(councilId);
    if (!council || ['stopped', 'failed'].includes(council.status)) return;
    this._probeAttempts.set(councilId, 0);
    const delay = PROBE_DELAYS_MS[0];

    // Surface the real recovery window when the provider gave one, so the
    // operator isn't left guessing whether a 2-minute or a multi-hour wait.
    const reset = reason === 'quota_exhausted' ? parseQuotaReset(detail) : null;
    const resetNote = reset
      ? ` Provider says capacity returns in ~${humanizeMs(reset.ms)}.`
      : '';

    store.updateCouncil(councilId, {
      status: 'quota_paused',
      paused_reason: reason === 'quota_exhausted'
        ? `All AI brains out of capacity${reset ? ` — back in ~${humanizeMs(reset.ms)}` : ''}`
        : `repeated errors: ${detail.slice(0, 160)}`,
      next_probe_at: new Date(Date.now() + delay).toISOString(),
    });
    this._emit(councilId, council.iteration, 'system',
      reason === 'quota_exhausted'
        ? `⏸ Every available AI brain is out of quota right now (Antigravity / Gemini / OpenRouter all returned a usage limit).${resetNote} The council is holding — it probes every few minutes and auto-resumes the instant any brain frees up. To resume sooner: sign a brain with remaining quota into the topbar, or add OpenRouter credits.`
        : `⏸ Paused after repeated errors (${detail.slice(0, 120)}). Will probe and auto-resume.`);
    this._scheduleProbe(councilId, delay);
  }

  /**
   * Probe every quota-paused council right now. Called when the
   * operator switches brain model/provider so paused councils pick up
   * the new model immediately instead of waiting for the next backoff.
   */
  probePausedNow() {
    const paused = store.listCouncils(50).filter(c => c.status === 'quota_paused');
    for (const c of paused) {
      this._clearProbe(c.id);
      this._probe(c.id).catch(() => {});
    }
    return paused.length;
  }

  /**
   * The operator's big red button: re-engage everything that should be
   * live, RIGHT NOW. Running councils whose loop died get their loop
   * back, quota-paused councils are probed immediately. Idempotent and
   * safe to spam — live loops are never doubled (_loop guards itself).
   */
  revive() {
    let loops = 0;
    let probes = 0;
    for (const c of store.listCouncils(50)) {
      if (c.status === 'running' && !this._looping.has(c.id)) {
        this._emit(c.id, c.iteration, 'system', '⟳ Operator revive — re-engaging the council loop.');
        this._loop(c.id).catch(() => {});
        loops += 1;
      } else if (c.status === 'quota_paused') {
        this._clearProbe(c.id);
        this._probe(c.id).catch(() => {});
        probes += 1;
      }
    }
    return { loops, probes };
  }

  _scheduleProbe(councilId, delayMs) {
    this._clearProbe(councilId);
    store.updateCouncil(councilId, { next_probe_at: new Date(Date.now() + delayMs).toISOString() });
    const timer = setTimeout(() => this._probe(councilId).catch(() => {}), delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    this._probeTimers.set(councilId, timer);
  }

  async _probe(councilId) {
    const council = store.getCouncil(councilId);
    if (!council || council.status !== 'quota_paused') return;

    const r = await this.brain.complete({
      system: 'You are a connectivity probe. Reply with exactly one word.',
      prompt: 'Reply with the single word: READY',
      timeoutMs: 60000,
    });

    if (r.ok) {
      this._probeAttempts.delete(councilId);
      store.updateCouncil(councilId, { status: 'running', paused_reason: '', next_probe_at: null });
      this._emit(councilId, council.iteration, 'system', '▶ Quota restored — council resuming.');
      this._loop(councilId).catch(err => console.error('[Council] loop crashed:', err));
      return;
    }

    const attempt = (this._probeAttempts.get(councilId) || 0) + 1;
    this._probeAttempts.set(councilId, attempt);
    const delay = PROBE_DELAYS_MS[Math.min(attempt, PROBE_DELAYS_MS.length - 1)];
    this._scheduleProbe(councilId, delay);
  }

  _clearProbe(councilId) {
    const timer = this._probeTimers.get(councilId);
    if (timer) clearTimeout(timer);
    this._probeTimers.delete(councilId);
  }

  // ── Brain plumbing ─────────────────────────────────────────

  /**
   * One role invocation: Gemini CLI call → strict JSON.
   * Throws QuotaError on quota exhaustion (pauses the council);
   * returns null on any other failure (the step degrades gracefully).
   * With role/task set, the agent's live mind state streams to the UI:
   * thinking → (result thought | failure), per call.
   */
  async _call(councilId, { system, prompt }, { timeoutMs = 120000, webSearch = false, role = '', task = '', lane = '' } = {}) {
    if (role) this._mindStart(councilId, role, task, prompt);
    const started = Date.now();
    // Hybrid affinity: pin this role to its strongest lane (ignored
    // outside hybrid mode; 'alternate' ping-pongs to saturate both).
    // Web-grounded calls ALWAYS ride the Gemini lane — that is where the
    // search tools live; on OpenRouter the web plugin is a paid add-on
    // that silently falls back to ungrounded answers on free accounts.
    if (this.brain.usesHybrid?.()) {
      if (webSearch) lane = 'gemini';
      else if (!lane) {
        const pref = ROLE_LANES[role];
        if (pref === 'alternate') lane = (this._laneFlip = !this._laneFlip) ? 'openrouter' : 'gemini';
        else if (pref) lane = pref;
      }
    }
    const finish = (ok, parsed, reason = '') => {
      if (role) {
        this._mindEnd(councilId, role, {
          ok, ms: Date.now() - started, reason,
          thought: ok ? thoughtOf(role, parsed) : '',
        });
      }
      return parsed;
    };
    const telemetry = (r) => {
      // Brain-core telemetry: which physical brain served this call.
      try {
        this.broadcast({
          type: 'council_call',
          payload: {
            councilId, role, ok: r.ok, ms: r.ms,
            provider: r.provider || '', model: r.model || '', lane: r.lane || '',
          },
        });
      } catch { /* never let telemetry break the loop */ }
    };

    try {
      const first = await this.brain.complete({ system, prompt, timeoutMs, webSearch, lane });
      this._bumpStats(councilId, { callsUsed: 1 });
      telemetry(first);
      if (!first.ok) {
        if (first.reason === 'quota_exhausted') throw new QuotaError(first.detail || '');
        return finish(false, null, first.reason || 'brain_error');
      }
      const parsed = extractJson(first.text);
      if (parsed) return finish(true, parsed);

      // One repair pass for almost-JSON answers.
      const retry = await this.brain.complete({
        system: 'You convert text into the valid JSON it was supposed to be. Output ONLY the JSON.',
        prompt: `The following should have been a single valid JSON object. Re-emit it as valid JSON:\n\n${first.text.slice(0, 6000)}`,
        timeoutMs: 60000,
        lane,
      });
      this._bumpStats(councilId, { callsUsed: 1 });
      telemetry(retry);
      if (!retry.ok) {
        if (retry.reason === 'quota_exhausted') throw new QuotaError(retry.detail || '');
        return finish(false, null, retry.reason || 'brain_error');
      }
      const repaired = extractJson(retry.text);
      return finish(Boolean(repaired), repaired, repaired ? '' : 'unparseable');
    } catch (err) {
      finish(false, null, err instanceof QuotaError ? 'quota_exhausted' : err.message);
      throw err;
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  _mergeConfig(config = {}) {
    const cfg = { ...DEFAULT_CONFIG };
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (config[key] !== undefined && config[key] !== null && config[key] !== '') {
        cfg[key] = typeof DEFAULT_CONFIG[key] === 'boolean' ? Boolean(config[key]) : Number(config[key]);
      }
    }
    // The power dial is authoritative: when set, its preset overrides
    // the per-key numbers (the slider is the operator's single control).
    const preset = POWER_PRESETS[cfg.power];
    if (preset) {
      for (const [key, value] of Object.entries(preset)) {
        if (key in DEFAULT_CONFIG) cfg[key] = value;
      }
    }
    return cfg;
  }

  _isRunning(councilId) {
    const c = store.getCouncil(councilId);
    return Boolean(c && c.status === 'running');
  }

  _clusterSummaryList(hypotheses) {
    const groups = new Map();
    for (const h of hypotheses) {
      if (!h.cluster) continue;
      if (!groups.has(h.cluster)) groups.set(h.cluster, []);
      groups.get(h.cluster).push(h.slug);
    }
    return [...groups.entries()].map(([name, members]) => ({ name, members }));
  }

  _bumpStats(councilId, increments = {}) {
    const council = store.getCouncil(councilId);
    if (!council) return;
    const stats = { ...council.stats };
    for (const [key, amount] of Object.entries(increments)) {
      stats[key] = (Number(stats[key]) || 0) + amount;
    }
    store.updateCouncil(councilId, { stats });
  }

  /** Set/clear non-counter stats fields (null deletes the key). */
  _setStats(councilId, patch = {}) {
    const council = store.getCouncil(councilId);
    if (!council) return;
    const stats = { ...council.stats };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete stats[key];
      else stats[key] = value;
    }
    store.updateCouncil(councilId, { stats });
  }

  _emit(councilId, iteration, role, line, data = {}) {
    try { store.addEvent({ councilId, iteration, role, line, data }); } catch { /* ignore */ }
    const council = store.getCouncil(councilId);
    this.broadcast({
      type: 'council_update',
      payload: {
        councilId, iteration, role, line,
        status: council?.status || 'unknown',
        stats: council?.stats || {},
        ...data,
        timestamp: new Date().toISOString(),
      },
    });
  }

  /**
   * Emit a structured debate: stored as a role:'debate' event (so it
   * persists and the Debate Chamber can replay it) and broadcast live on a
   * dedicated channel so rival perspectives stream in as they're spoken.
   */
  _emitDebate(councilId, iteration, { kind, title, turns, summary = '', refs = null }) {
    if (!Array.isArray(turns) || !turns.length) return;
    const debate = { kind, title, turns, summary, refs, at: new Date().toISOString() };
    try { store.addEvent({ councilId, iteration, role: 'debate', line: title || 'debate', data: debate }); } catch { /* ignore */ }
    this._bumpStats(councilId, { debatesStaged: 1 });
    const council = store.getCouncil(councilId);
    this.broadcast({
      type: 'council_debate',
      payload: { councilId, iteration, status: council?.status || 'unknown', ...debate },
    });
  }

  async _interruptibleSleep(councilId, totalMs) {
    const step = 2000;
    let elapsed = 0;
    while (elapsed < totalMs) {
      if (!this._isRunning(councilId)) return;
      await sleep(Math.min(step, totalMs - elapsed));
      elapsed += step;
    }
  }
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** Compress one agent's JSON answer into the human-readable "thought" the UI streams. */
function thoughtOf(role, parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  try {
    if (Array.isArray(parsed.hypotheses) && parsed.hypotheses.length) {
      return `proposing: ${parsed.hypotheses.map(h => `"${String(h.title || '').slice(0, 48)}"`).join(' · ')}`;
    }
    if (Array.isArray(parsed.reviews) && parsed.reviews.length) {
      const counts = { keep: 0, revise: 0, reject: 0 };
      for (const r of parsed.reviews) if (counts[r.verdict] !== undefined) counts[r.verdict] += 1;
      const slops = parsed.reviews.map(r => Number(r.slopRisk)).filter(Number.isFinite);
      const maxSlop = slops.length ? Math.max(...slops) : 0;
      return `verdicts: ${counts.keep} keep · ${counts.revise} revise · ${counts.reject} reject${maxSlop ? ` · worst slopRisk ${maxSlop}/10` : ''}`;
    }
    if (parsed.winner && (parsed.winner === 'A' || parsed.winner === 'B')) {
      return `winner ${parsed.winner} — ${String(parsed.rationale || '').slice(0, 130)}`;
    }
    if (parsed.winner && parsed.winner.slug) {
      return `final verdict: ${parsed.winner.slug} — ${String(parsed.winner.verdict || '').slice(0, 110)}`;
    }
    if (Array.isArray(parsed.clusters)) {
      return `${parsed.clusters.length} clusters${(parsed.duplicates || []).length ? `, ${parsed.duplicates.length} duplicates flagged` : ''}`;
    }
    if (Array.isArray(parsed.refinements) && parsed.refinements.length) {
      return `evolving: ${parsed.refinements.map(r => `"${String(r.title || '').slice(0, 44)}"`).join(' · ')}`;
    }
    if (parsed.allocation) {
      return `plan: ${(parsed.focusAreas || []).slice(0, 3).join(' · ')} (gen ${parsed.allocation.generate ?? '?'} / evo ${parsed.allocation.evolve ?? '?'} / matches ${parsed.allocation.matches ?? '?'})`;
    }
    if (Array.isArray(parsed.criteria) && parsed.criteria.length) {
      return `judging axes: ${parsed.criteria.map(c => String(c.name || '').toUpperCase()).join(' · ')}`;
    }
    if (Array.isArray(parsed.keyFindings) && parsed.keyFindings.length) {
      return `findings: ${String(parsed.keyFindings[0]).slice(0, 130)}${parsed.keyFindings.length > 1 ? ` (+${parsed.keyFindings.length - 1} more)` : ''}`;
    }
    if (Array.isArray(parsed.agreedFindings)) {
      return `consensus: ${String(parsed.summary || parsed.agreedFindings[0] || '').slice(0, 140)}`;
    }
    const firstString = Object.values(parsed).find(v => typeof v === 'string' && v.trim());
    return String(firstString || '').slice(0, 140);
  } catch {
    return '';
  }
}

function round1(n) { return Math.round(Number(n) * 10) / 10; }

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ── Debate parsing ───────────────────────────────────────────
// The generation (self-play) and ranking (high-stakes) agents argue in
// labeled turns inside their JSON. We split that prose into structured
// turns so the Debate Chamber can render each speaker as its own voice
// in realtime, instead of one wall of text in the activity log.

const DEBATE_SPEAKERS = [
  { tag: 'mechanist',    label: 'Mechanist',    side: 'mechanist',  icon: '⚙' },
  { tag: 'empiricist',   label: 'Empiricist',   side: 'empiricist', icon: '📊' },
  { tag: 'contrarian',   label: 'Contrarian',   side: 'contrarian', icon: '⚡' },
  { tag: 'synthesis',    label: 'Synthesis',    side: 'synthesis',  icon: '🧩' },
  { tag: 'advocate a',   label: 'Advocate A',   side: 'a',          icon: '🅰' },
  { tag: 'advocate b',   label: 'Advocate B',   side: 'b',          icon: '🅱' },
  { tag: 'cross-examine', label: 'Cross-examination', side: 'cross', icon: '⚔' },
  { tag: 'cross-examination', label: 'Cross-examination', side: 'cross', icon: '⚔' },
  { tag: 'cross examine', label: 'Cross-examination', side: 'cross', icon: '⚔' },
  { tag: 'ruling',       label: 'Ruling',       side: 'ruling',     icon: '⚖' },
  { tag: 'verdict',      label: 'Ruling',       side: 'ruling',     icon: '⚖' },
];

/** Split a debate string into [{speaker, side, icon, text}] turns by labels. */
function parseDebate(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  // Build a matcher for "LABEL:" openers, whether they sit at the start of a
  // line, after a number ("1."), in bold ("**LABEL**"), or — the common case —
  // inlined mid-paragraph right after a sentence ("…fluff. EMPIRICIST: …").
  const alt = DEBATE_SPEAKERS.map(s => s.tag.replace(/[-\s]/g, '[-\\s]?')).join('|');
  const re = new RegExp(`(?:^|\\n|[.!?…)]\\s+|\\d\\.\\s*|\\*\\*\\s*)\\s*(${alt})\\s*\\**\\s*[:\\-—]`, 'gi');
  const hits = [...raw.matchAll(re)];
  if (!hits.length) {
    return [{ speaker: 'Debate', side: 'synthesis', icon: '🗣', text: raw.slice(0, 700) }];
  }
  const norm = (x) => String(x).toLowerCase().replace(/[-\s]+/g, ' ').trim();
  const turns = [];
  for (let i = 0; i < hits.length; i += 1) {
    const m = hits[i];
    const tag = norm(m[1]);
    const meta = DEBATE_SPEAKERS.find(s => norm(s.tag) === tag)
      || DEBATE_SPEAKERS.find(s => tag.startsWith(norm(s.tag).slice(0, 5)))
      || { label: m[1], side: 'synthesis', icon: '🗣' };
    const start = m.index + m[0].length;
    const end = i + 1 < hits.length ? hits[i + 1].index : raw.length;
    const body = raw.slice(start, end).trim().replace(/^\**\s*/, '').replace(/\s*\**$/, '');
    if (body) turns.push({ speaker: meta.label, side: meta.side, icon: meta.icon, text: body.slice(0, 600) });
  }
  return turns.length ? turns : [{ speaker: 'Debate', side: 'synthesis', icon: '🗣', text: raw.slice(0, 700) }];
}

const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif)(\?[^\s]*)?$/i;
const ANY_URL_RE = /https?:\/\/[^\s<>"'`\])]+/gi;

function isImageUrl(u) { return typeof u === 'string' && IMG_EXT_RE.test(u.replace(/[.,;:!?…)]+$/, '')); }

/** Pull http(s) URLs out of free text, trimming trailing punctuation. */
function extractUrls(text, limit = 6) {
  const out = [];
  for (const m of String(text || '').matchAll(ANY_URL_RE)) {
    const url = m[0].replace(/[.,;:!?…»”)]+$/, '');
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

export default CouncilEngine;
