// ─────────────────────────────────────────────────────────────
// Hermes OS — Research Council Store
// Self-contained SQLite schema + CRUD for the council:
// councils, hypotheses (with Elo), tournament matches, the live
// event feed, and external-evidence submissions. Everything is
// persisted so a council survives backend restarts and quota
// pauses mid-iteration.
// ─────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { getDb } from './database.js';

let initialized = false;

export function initCouncilStore() {
  if (initialized) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS councils (
      id            TEXT PRIMARY KEY,
      goal          TEXT NOT NULL,
      status        TEXT DEFAULT 'running',   -- running | quota_paused | stopped | failed
      paused_reason TEXT DEFAULT '',
      next_probe_at TEXT,
      iteration     INTEGER DEFAULT 0,
      hyp_counter   INTEGER DEFAULT 0,
      config        TEXT DEFAULT '{}',
      plan          TEXT DEFAULT '{}',
      stats         TEXT DEFAULT '{}',
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS council_hypotheses (
      id             TEXT PRIMARY KEY,
      council_id     TEXT NOT NULL,
      slug           TEXT NOT NULL,            -- short display id: H1, H2…
      title          TEXT NOT NULL,
      statement      TEXT NOT NULL,
      rationale      TEXT DEFAULT '',
      status         TEXT DEFAULT 'active',    -- active | rejected | merged | archived
      elo            REAL DEFAULT 1200,
      wins           INTEGER DEFAULT 0,
      losses         INTEGER DEFAULT 0,
      matches        INTEGER DEFAULT 0,
      novelty        REAL DEFAULT 0,
      plausibility   REAL DEFAULT 0,
      testability    REAL DEFAULT 0,
      cluster        TEXT DEFAULT '',
      critique       TEXT DEFAULT '',
      verdict        TEXT DEFAULT '',
      parent_id      TEXT,
      origin         TEXT DEFAULT 'generation', -- generation | evolution
      born_iteration INTEGER DEFAULT 0,
      created_at     TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS council_matches (
      id           TEXT PRIMARY KEY,
      council_id   TEXT NOT NULL,
      iteration    INTEGER DEFAULT 0,
      a_id         TEXT NOT NULL,
      b_id         TEXT NOT NULL,
      winner_id    TEXT,
      rationale    TEXT DEFAULT '',
      scores       TEXT DEFAULT '{}',          -- {noveltyA,plausibilityA,noveltyB,plausibilityB}
      elo_a_before REAL, elo_a_after REAL,
      elo_b_before REAL, elo_b_after REAL,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS council_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      council_id TEXT NOT NULL,
      iteration  INTEGER DEFAULT 0,
      role       TEXT DEFAULT 'system',
      line       TEXT NOT NULL,
      data       TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS council_evidence (
      id         TEXT PRIMARY KEY,
      council_id TEXT NOT NULL,
      content    TEXT NOT NULL,
      status     TEXT DEFAULT 'queued',        -- queued | analyzing | done | failed
      analyses   TEXT DEFAULT '[]',
      consensus  TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_council_hyp_council ON council_hypotheses(council_id, status);
    CREATE INDEX IF NOT EXISTS idx_council_hyp_elo     ON council_hypotheses(council_id, elo);
    CREATE INDEX IF NOT EXISTS idx_council_matches     ON council_matches(council_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_council_events      ON council_events(council_id, id);
    CREATE INDEX IF NOT EXISTS idx_council_evidence    ON council_evidence(council_id, status);
  `);

  // Columns added after the first release (ALTER is a no-op error if present).
  const migrations = [
    "ALTER TABLE councils ADD COLUMN criteria TEXT DEFAULT '[]'",          // goal-derived judging criteria
    "ALTER TABLE councils ADD COLUMN verdict TEXT DEFAULT '{}'",           // final report from the verdict agent
    "ALTER TABLE council_hypotheses ADD COLUMN scores TEXT DEFAULT '{}'",  // per-criterion running averages
    "ALTER TABLE councils ADD COLUMN agents TEXT DEFAULT '{}'",            // operator-tuned agent traits per role
    "ALTER TABLE council_hypotheses ADD COLUMN slop_risk REAL DEFAULT 0",  // reflection's AI-slop score (1-10)
    "ALTER TABLE councils ADD COLUMN guidance TEXT DEFAULT '[]'",          // operator vetoes — taste the council learns from
    "ALTER TABLE councils ADD COLUMN meta TEXT DEFAULT '{}'",              // meta-review lessons — the council's learned taste
    "ALTER TABLE councils ADD COLUMN deliverable TEXT DEFAULT ''",         // what each candidate must literally BE (artifact goals: a name, a title…)
    "ALTER TABLE council_evidence ADD COLUMN images TEXT DEFAULT '[]'",    // operator-attached photo URLs for an evidence drop
    "ALTER TABLE council_hypotheses ADD COLUMN sources TEXT DEFAULT '[]'", // citation URLs the agents grounded a hypothesis in
    "ALTER TABLE council_hypotheses ADD COLUMN images TEXT DEFAULT '[]'",  // image URLs an agent attached to a hypothesis
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  initialized = true;
  console.log('[CouncilStore] Schema ready');
}

const parseJson = (value, fallback) => {
  try { return JSON.parse(value || ''); } catch { return fallback; }
};

// ── Councils ─────────────────────────────────────────────────

function parseCouncilRow(row) {
  return row ? {
    ...row,
    config: parseJson(row.config, {}),
    plan: parseJson(row.plan, {}),
    stats: parseJson(row.stats, {}),
    criteria: parseJson(row.criteria, []),
    verdict: parseJson(row.verdict, {}),
    agents: parseJson(row.agents, {}),
    guidance: parseJson(row.guidance, []),
    meta: parseJson(row.meta, {}),
  } : null;
}

// ── Agent traits ─────────────────────────────────────────────
// Every council agent has a tunable personality. The operator can
// retune any trait at runtime (right-click the station in the UI);
// the engine re-reads traits on EVERY brain call, so changes apply
// immediately — even mid-iteration.
//
// Defaults are deliberately strict on the judging side (reflection,
// ranking, interpret): candidates are treated as AI slop until they
// prove otherwise.

export const TRAIT_KEYS = ['strictness', 'creativity', 'skepticism', 'thoroughness', 'riskAppetite'];

export const AGENT_DEFAULTS = {
  supervisor: { strictness: 5, creativity: 5, skepticism: 5, thoroughness: 6, riskAppetite: 5 },
  generation: { strictness: 4, creativity: 8, skepticism: 4, thoroughness: 6, riskAppetite: 7 },
  reflection: { strictness: 8, creativity: 3, skepticism: 9, thoroughness: 8, riskAppetite: 2 },
  ranking:    { strictness: 8, creativity: 3, skepticism: 8, thoroughness: 7, riskAppetite: 3 },
  proximity:  { strictness: 6, creativity: 4, skepticism: 6, thoroughness: 6, riskAppetite: 4 },
  evolution:  { strictness: 5, creativity: 7, skepticism: 5, thoroughness: 7, riskAppetite: 6 },
  interpret:  { strictness: 7, creativity: 3, skepticism: 8, thoroughness: 8, riskAppetite: 2 },
  verdict:    { strictness: 7, creativity: 4, skepticism: 7, thoroughness: 8, riskAppetite: 3 },
  meta:       { strictness: 7, creativity: 4, skepticism: 8, thoroughness: 9, riskAppetite: 3 },
  falsify:    { strictness: 9, creativity: 3, skepticism: 10, thoroughness: 9, riskAppetite: 2 },
};

const clampTrait = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(1, Math.min(10, Math.round(n))) : fallback;
};

/** Effective traits for one role: defaults overlaid with operator overrides. */
export function getAgentTraits(councilId, role) {
  const defaults = AGENT_DEFAULTS[role];
  if (!defaults) return null;
  const council = getCouncil(councilId);
  const saved = council?.agents?.[role] || {};
  const traits = {};
  for (const key of TRAIT_KEYS) traits[key] = clampTrait(saved[key], defaults[key]);
  return {
    role,
    traits,
    directive: String(saved.directive || '').slice(0, 400),
    pendingNote: String(saved.pendingNote || ''),
    updatedAt: saved.updatedAt || null,
    isDefault: !Object.keys(saved).length,
  };
}

/** All roles, merged — what the UI renders on the chamber stations. */
export function getAllAgentTraits(councilId) {
  return Object.keys(AGENT_DEFAULTS).map(role => getAgentTraits(councilId, role));
}

/**
 * Apply an operator change to one agent. Returns {agent, changes} where
 * changes is a human-readable "strictness 5→9" list for the event feed,
 * and pendingNote is set so the agent acknowledges the retune on its
 * very next call.
 */
export function updateAgentTraits(councilId, role, patch = {}) {
  if (!AGENT_DEFAULTS[role]) return { error: 'unknown_role' };
  const council = getCouncil(councilId);
  if (!council) return { error: 'not_found' };
  const before = getAgentTraits(councilId, role);
  const agents = { ...council.agents };
  const saved = { ...(agents[role] || {}) };

  const changes = [];
  for (const key of TRAIT_KEYS) {
    if (patch[key] === undefined) continue;
    const next = clampTrait(patch[key], before.traits[key]);
    if (next !== before.traits[key]) changes.push(`${key} ${before.traits[key]}→${next}`);
    saved[key] = next;
  }
  if (patch.directive !== undefined) {
    const next = String(patch.directive || '').slice(0, 400);
    if (next !== before.directive) changes.push(next ? 'new directive' : 'directive cleared');
    saved.directive = next;
  }

  if (changes.length) {
    saved.updatedAt = new Date().toISOString();
    saved.pendingNote = changes.join(', ');
  }
  agents[role] = saved;
  updateCouncil(councilId, { agents });
  return { agent: getAgentTraits(councilId, role), changes };
}

/** Consume the one-shot acknowledgment note (called when the agent next runs). */
export function consumePendingNote(councilId, role) {
  const council = getCouncil(councilId);
  const saved = council?.agents?.[role];
  if (!saved || !saved.pendingNote) return '';
  const note = saved.pendingNote;
  const agents = { ...council.agents, [role]: { ...saved, pendingNote: '' } };
  updateCouncil(councilId, { agents });
  return note;
}

function parseHypothesisRow(row) {
  return row ? {
    ...row,
    scores: parseJson(row.scores, {}),
    sources: parseJson(row.sources, []),
    images: parseJson(row.images, []),
  } : null;
}

export function createCouncil({ goal, config = {} }) {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO councils (id, goal, status, config) VALUES (?, ?, 'running', ?)
  `).run(id, goal, JSON.stringify(config));
  return getCouncil(id);
}

export function getCouncil(id) {
  return parseCouncilRow(getDb().prepare('SELECT * FROM councils WHERE id = ?').get(id));
}

export function listCouncils(limit = 20) {
  return getDb().prepare('SELECT * FROM councils ORDER BY created_at DESC LIMIT ?')
    .all(limit).map(parseCouncilRow);
}

/** The single council allowed to consume quota right now, if any. */
export function getActiveCouncil() {
  return parseCouncilRow(getDb().prepare(
    "SELECT * FROM councils WHERE status IN ('running','quota_paused') ORDER BY created_at DESC LIMIT 1"
  ).get());
}

export function updateCouncil(id, updates = {}) {
  const allowed = ['goal', 'status', 'paused_reason', 'next_probe_at', 'iteration', 'hyp_counter', 'config', 'plan', 'stats', 'criteria', 'verdict', 'agents', 'guidance', 'meta', 'deliverable'];
  const jsonKeys = ['config', 'plan', 'stats', 'criteria', 'verdict', 'agents', 'guidance', 'meta'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(jsonKeys.includes(key) ? JSON.stringify(updates[key]) : updates[key]);
    }
  }
  if (!sets.length) return getCouncil(id);
  sets.push("updated_at = datetime('now')");
  values.push(id);
  getDb().prepare(`UPDATE councils SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getCouncil(id);
}

/** Atomically reserve the next Hn slug for a council. */
export function nextHypothesisSlug(councilId) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('UPDATE councils SET hyp_counter = hyp_counter + 1 WHERE id = ?').run(councilId);
    return db.prepare('SELECT hyp_counter FROM councils WHERE id = ?').get(councilId).hyp_counter;
  });
  return `H${tx()}`;
}

// ── Hypotheses ───────────────────────────────────────────────

export function addHypothesis({ councilId, slug, title, statement, rationale = '', parentId = null, origin = 'generation', bornIteration = 0, elo = 1200 }) {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO council_hypotheses (id, council_id, slug, title, statement, rationale, parent_id, origin, born_iteration, elo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, councilId, slug, String(title).slice(0, 160), String(statement).slice(0, 2000),
    String(rationale).slice(0, 2000), parentId, origin, bornIteration, elo);
  return getHypothesis(id);
}

export function getHypothesis(id) {
  return parseHypothesisRow(getDb().prepare('SELECT * FROM council_hypotheses WHERE id = ?').get(id));
}

export function updateHypothesis(id, updates = {}) {
  const allowed = ['title', 'statement', 'rationale', 'status', 'elo', 'wins', 'losses', 'matches',
    'novelty', 'plausibility', 'testability', 'cluster', 'critique', 'verdict', 'scores', 'slop_risk',
    'sources', 'images'];
  const jsonKeys = ['scores', 'sources', 'images'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(jsonKeys.includes(key) ? JSON.stringify(updates[key]) : updates[key]);
    }
  }
  if (!sets.length) return getHypothesis(id);
  values.push(id);
  getDb().prepare(`UPDATE council_hypotheses SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getHypothesis(id);
}

/**
 * List hypotheses for a council.
 * status: 'active' | 'all' (default 'active'), ordered by Elo descending.
 */
export function getHypotheses(councilId, { status = 'active', limit = 100 } = {}) {
  const db = getDb();
  const rows = status === 'all'
    ? db.prepare(
      'SELECT * FROM council_hypotheses WHERE council_id = ? ORDER BY elo DESC, created_at DESC LIMIT ?'
    ).all(councilId, limit)
    : db.prepare(
      'SELECT * FROM council_hypotheses WHERE council_id = ? AND status = ? ORDER BY elo DESC, created_at DESC LIMIT ?'
    ).all(councilId, status, limit);
  return rows.map(parseHypothesisRow);
}

/**
 * Full-history projection for the diversity engine: every hypothesis the
 * council has EVER created (any status), oldest first. This is the council's
 * long-term memory — without it, generation only sees the live pool and
 * re-proposes ideas that were archived or merged long ago.
 */
export function getHypothesisMemory(councilId) {
  return getDb().prepare(`
    SELECT id, slug, title, statement, status, cluster, origin, elo, matches, parent_id
    FROM council_hypotheses WHERE council_id = ? ORDER BY created_at ASC
  `).all(councilId);
}

/**
 * Graph projection of one council: hypotheses as nodes, evolution lineage
 * and tournament matches as edges. Feeds the per-council force graph.
 */
export function getCouncilGraph(councilId, { nodeLimit = 70, matchLimit = 150 } = {}) {
  const db = getDb();
  const hyps = db.prepare(
    "SELECT * FROM council_hypotheses WHERE council_id = ? AND status != 'rejected' ORDER BY elo DESC LIMIT ?"
  ).all(councilId, nodeLimit).map(parseHypothesisRow);
  const byId = new Map(hyps.map(h => [h.id, h]));

  const nodes = hyps.map(h => ({
    id: h.slug, title: h.title, elo: Math.round(h.elo), status: h.status,
    cluster: h.cluster || '', origin: h.origin, matches: h.matches,
    wins: h.wins, losses: h.losses,
    // Detail payload for the expandable node popover (no second fetch).
    hypId: h.id,
    statement: String(h.statement || '').slice(0, 420),
    critique: String(h.critique || '').slice(0, 300),
    scores: h.scores || {},
    slopRisk: Number(h.slop_risk) || 0,
    sources: h.sources || [],
    images: h.images || [],
    bornIteration: h.born_iteration,
    parentSlug: h.parent_id && byId.has(h.parent_id) ? byId.get(h.parent_id).slug : null,
  }));

  const edges = [];
  for (const h of hyps) {
    if (h.parent_id && byId.has(h.parent_id)) {
      edges.push({ source: byId.get(h.parent_id).slug, target: h.slug, kind: 'lineage' });
    }
  }
  const matches = db.prepare(
    'SELECT a_id, b_id, winner_id FROM council_matches WHERE council_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(councilId, matchLimit);
  const seen = new Set();
  for (const m of matches) {
    const a = byId.get(m.a_id);
    const b = byId.get(m.b_id);
    if (!a || !b) continue;
    const key = [a.slug, b.slug].sort().join('|');
    if (seen.has(key)) continue; // one edge per pair, most recent outcome wins
    seen.add(key);
    edges.push({
      source: a.slug, target: b.slug, kind: 'match',
      winner: m.winner_id === a.id ? a.slug : m.winner_id === b.id ? b.slug : null,
    });
  }
  return { nodes, edges };
}

/**
 * Tree projection of one council: EVERY hypothesis (any status, oldest
 * first) with its parent link — the full evolutionary forest, including
 * withered branches (rejected/merged/archived). Feeds the Evolution Tree.
 */
export function getCouncilTree(councilId, { limit = 240 } = {}) {
  const rows = getDb().prepare(
    'SELECT * FROM council_hypotheses WHERE council_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?'
  ).all(councilId, limit).map(parseHypothesisRow);
  const byId = new Map(rows.map(h => [h.id, h]));
  return rows.map(h => ({
    id: h.slug, slug: h.slug, title: h.title,
    elo: Math.round(h.elo), status: h.status, cluster: h.cluster || '',
    origin: h.origin, matches: h.matches, wins: h.wins, losses: h.losses,
    hypId: h.id,
    statement: String(h.statement || '').slice(0, 420),
    critique: String(h.critique || '').slice(0, 300),
    scores: h.scores || {},
    slopRisk: Number(h.slop_risk) || 0,
    sources: h.sources || [],
    images: h.images || [],
    bornIteration: h.born_iteration,
    parentSlug: h.parent_id && byId.has(h.parent_id) ? byId.get(h.parent_id).slug : null,
  }));
}

// ── Matches ──────────────────────────────────────────────────

export function addMatch({ councilId, iteration, aId, bId, winnerId, rationale = '', scores = {}, eloABefore, eloAAfter, eloBBefore, eloBAfter }) {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO council_matches (id, council_id, iteration, a_id, b_id, winner_id, rationale, scores,
      elo_a_before, elo_a_after, elo_b_before, elo_b_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, councilId, iteration, aId, bId, winnerId, String(rationale).slice(0, 600),
    JSON.stringify(scores), eloABefore, eloAAfter, eloBBefore, eloBAfter);
  return id;
}

export function getMatches(councilId, limit = 30) {
  // Join in slugs/titles so the UI never needs a second lookup.
  return getDb().prepare(`
    SELECT m.*, a.slug AS a_slug, a.title AS a_title, b.slug AS b_slug, b.title AS b_title,
           w.slug AS winner_slug
    FROM council_matches m
    LEFT JOIN council_hypotheses a ON a.id = m.a_id
    LEFT JOIN council_hypotheses b ON b.id = m.b_id
    LEFT JOIN council_hypotheses w ON w.id = m.winner_id
    WHERE m.council_id = ?
    ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?
  `).all(councilId, limit).map(row => ({ ...row, scores: parseJson(row.scores, {}) }));
}

export function countMatches(councilId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM council_matches WHERE council_id = ?').get(councilId).n;
}

// ── Events (live activity feed) ──────────────────────────────

export function addEvent({ councilId, iteration = 0, role = 'system', line, data = {} }) {
  const info = getDb().prepare(`
    INSERT INTO council_events (council_id, iteration, role, line, data) VALUES (?, ?, ?, ?, ?)
  `).run(councilId, iteration, role, String(line).slice(0, 1000), JSON.stringify(data));
  return info.lastInsertRowid;
}

export function getEvents(councilId, limit = 60) {
  return getDb().prepare(
    'SELECT * FROM council_events WHERE council_id = ? ORDER BY id DESC LIMIT ?'
  ).all(councilId, limit).reverse().map(row => ({ ...row, data: parseJson(row.data, {}) }));
}

// ── Evidence (closed-loop external data) ─────────────────────

function parseEvidenceRow(row) {
  return row ? {
    ...row,
    analyses: parseJson(row.analyses, []),
    consensus: parseJson(row.consensus, {}),
    images: parseJson(row.images, []),
  } : null;
}

export function addEvidence({ councilId, content, images = [] }) {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO council_evidence (id, council_id, content, images) VALUES (?, ?, ?, ?)
  `).run(id, councilId, String(content).slice(0, 60000), JSON.stringify(Array.isArray(images) ? images.slice(0, 8) : []));
  return parseEvidenceRow(getDb().prepare('SELECT * FROM council_evidence WHERE id = ?').get(id));
}

export function updateEvidence(id, updates = {}) {
  const allowed = ['status', 'analyses', 'consensus', 'images'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(['analyses', 'consensus', 'images'].includes(key) ? JSON.stringify(updates[key]) : updates[key]);
    }
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  values.push(id);
  getDb().prepare(`UPDATE council_evidence SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function getEvidence(councilId, limit = 10) {
  return getDb().prepare(
    'SELECT * FROM council_evidence WHERE council_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(councilId, limit).map(parseEvidenceRow);
}

export function getQueuedEvidence(councilId) {
  return getDb().prepare(
    "SELECT * FROM council_evidence WHERE council_id = ? AND status = 'queued' ORDER BY created_at ASC"
  ).all(councilId).map(parseEvidenceRow);
}

export default {
  initCouncilStore,
  createCouncil, getCouncil, listCouncils, getActiveCouncil, updateCouncil, nextHypothesisSlug,
  addHypothesis, getHypothesis, updateHypothesis, getHypotheses, getHypothesisMemory, getCouncilGraph, getCouncilTree,
  addMatch, getMatches, countMatches,
  addEvent, getEvents,
  addEvidence, updateEvidence, getEvidence, getQueuedEvidence,
  getAgentTraits, getAllAgentTraits, updateAgentTraits, consumePendingNote,
};
