// ─────────────────────────────────────────────────────────────
// Hermes OS — Database Layer (better-sqlite3)
// ─────────────────────────────────────────────────────────────

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, 'hermes.db');

// ── Neon palette for seed nodes ──────────────────────────────
const NEON_PALETTE = [
  '#00fff7', // cyan
  '#ff00ff', // magenta
  '#39ff14', // neon green
  '#ff3131', // neon red
  '#ffff00', // neon yellow
  '#ff6ec7', // hot pink
  '#7b68ee', // medium slate blue
  '#00bfff', // deep sky blue
  '#ff4500', // orange-red
  '#adff2f', // green-yellow
  '#da70d6', // orchid
  '#1e90ff', // dodger blue
  '#ff1493', // deep pink
  '#00fa9a', // medium spring green
  '#ffd700', // gold
];

// ── Seed data ────────────────────────────────────────────────
const SEED_NODES = [
  { label: 'Hermes OS',            type: 'system',  size: 40 },
  { label: 'Knowledge Graph',      type: 'module',  size: 32 },
  { label: 'File System',          type: 'module',  size: 28 },
  { label: 'Analytics Engine',     type: 'module',  size: 30 },
  { label: 'Mission Control',      type: 'system',  size: 34 },
  { label: 'Neural Network',       type: 'concept', size: 26 },
  { label: 'Data Pipeline',        type: 'module',  size: 24 },
  { label: 'Security Module',      type: 'module',  size: 22 },
  { label: 'Memory Core',          type: 'concept', size: 28 },
  { label: 'Task Scheduler',       type: 'module',  size: 20 },
  { label: 'Communication Hub',    type: 'module',  size: 26 },
  { label: 'Visualization Engine', type: 'module',  size: 30 },
  { label: 'Pattern Recognition',  type: 'concept', size: 24 },
  { label: 'System Monitor',       type: 'module',  size: 22 },
  { label: 'User Interface',       type: 'module',  size: 28 },
  { label: 'Google Analytics',      type: 'analytics', size: 24 },
  { label: 'Social Signals',        type: 'analytics', size: 22 },
  { label: 'Revenue Monitor',       type: 'analytics', size: 24 },
  { label: 'Content Analytics',     type: 'analytics', size: 22 },
  { label: 'Automation Feed',       type: 'analytics', size: 20 },
];

// Edges as [sourceIndex, targetIndex, weight, type]
const SEED_EDGES = [
  [0, 1,  1.0, 'core'],       // Hermes OS → Knowledge Graph
  [0, 2,  1.0, 'core'],       // Hermes OS → File System
  [0, 3,  1.0, 'core'],       // Hermes OS → Analytics Engine
  [0, 4,  1.0, 'core'],       // Hermes OS → Mission Control
  [1, 5,  0.8, 'dependency'], // Knowledge Graph → Neural Network
  [1, 11, 0.9, 'dependency'], // Knowledge Graph → Visualization Engine
  [1, 12, 0.7, 'dependency'], // Knowledge Graph → Pattern Recognition
  [2, 6,  0.8, 'dependency'], // File System → Data Pipeline
  [2, 8,  0.6, 'dependency'], // File System → Memory Core
  [3, 6,  0.9, 'dependency'], // Analytics Engine → Data Pipeline
  [3, 12, 0.8, 'dependency'], // Analytics Engine → Pattern Recognition
  [4, 13, 0.9, 'dependency'], // Mission Control → System Monitor
  [4, 9,  0.7, 'dependency'], // Mission Control → Task Scheduler
  [4, 14, 0.8, 'dependency'], // Mission Control → User Interface
  [5, 12, 0.9, 'synergy'],    // Neural Network → Pattern Recognition
  [6, 8,  0.6, 'data_flow'],  // Data Pipeline → Memory Core
  [7, 13, 0.7, 'dependency'], // Security Module → System Monitor
  [7, 10, 0.5, 'dependency'], // Security Module → Communication Hub
  [9, 13, 0.6, 'dependency'], // Task Scheduler → System Monitor
  [10, 14, 0.7, 'synergy'],   // Communication Hub → User Interface
  [11, 14, 0.9, 'synergy'],   // Visualization Engine → User Interface
  [8, 5,  0.7, 'data_flow'],  // Memory Core → Neural Network
  [3, 15, 0.9, 'telemetry'],   // Analytics Engine → Google Analytics
  [3, 16, 0.8, 'telemetry'],   // Analytics Engine → Social Signals
  [3, 17, 0.9, 'telemetry'],   // Analytics Engine → Revenue Monitor
  [3, 18, 0.8, 'telemetry'],   // Analytics Engine → Content Analytics
  [9, 19, 0.7, 'automation'],  // Task Scheduler → Automation Feed
  [6, 15, 0.7, 'data_flow'],   // Data Pipeline → Google Analytics
  [6, 17, 0.7, 'data_flow'],   // Data Pipeline → Revenue Monitor
  [12, 16, 0.7, 'pattern'],    // Pattern Recognition → Social Signals
  [1, 18, 0.7, 'knowledge'],   // Knowledge Graph → Content Analytics
  [10, 19, 0.6, 'signal'],     // Communication Hub → Automation Feed
];

// ── Initialize database ──────────────────────────────────────
let db;

export function initDatabase() {
  db = new Database(DB_PATH);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // ── Create tables ────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id         TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      type       TEXT DEFAULT 'default',
      x          REAL,
      y          REAL,
      size       REAL DEFAULT 10,
      color      TEXT DEFAULT '#00fff7',
      metadata   TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edges (
      id         TEXT PRIMARY KEY,
      source     TEXT NOT NULL,
      target     TEXT NOT NULL,
      weight     REAL DEFAULT 1.0,
      type       TEXT DEFAULT 'default',
      metadata   TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (source) REFERENCES nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (target) REFERENCES nodes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS files (
      id            TEXT PRIMARY KEY,
      node_id       TEXT,
      filename      TEXT NOT NULL,
      original_name TEXT,
      mime_type     TEXT,
      size          INTEGER,
      path          TEXT,
      metadata      TEXT DEFAULT '{}',
      created_at    TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS analytics_sources (
      id         TEXT PRIMARY KEY,
      node_id    TEXT,
      name       TEXT NOT NULL,
      type       TEXT,
      config     TEXT DEFAULT '{}',
      last_sync  TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS analytics_widgets (
      id         TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      kind       TEXT DEFAULT 'metric',
      value      REAL DEFAULT 0,
      unit       TEXT DEFAULT '',
      trend      REAL DEFAULT 0,
      color      TEXT DEFAULT '#00f0ff',
      source     TEXT DEFAULT 'manual',
      history    TEXT DEFAULT '[]',
      metadata   TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hermes_config (
      key        TEXT PRIMARY KEY,
      value      TEXT DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hermes_memory (
      id         TEXT PRIMARY KEY,
      type       TEXT DEFAULT 'note',
      content    TEXT NOT NULL,
      tags       TEXT DEFAULT '[]',
      metadata   TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hermes_tasks (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      status     TEXT DEFAULT 'queued',
      priority   INTEGER DEFAULT 2,
      metadata   TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hermes_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      message    TEXT,
      data       TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Cognition runs: deep-research pipelines and dream cycles.
    CREATE TABLE IF NOT EXISTS hermes_runs (
      id         TEXT PRIMARY KEY,
      kind       TEXT DEFAULT 'research',
      title      TEXT NOT NULL,
      status     TEXT DEFAULT 'running',
      phase      TEXT DEFAULT 'queued',
      progress   REAL DEFAULT 0,
      log        TEXT DEFAULT '[]',
      result     TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Idea ledger: every dream-loop idea with judge scores and lineage.
    CREATE TABLE IF NOT EXISTS hermes_ideas (
      id          TEXT PRIMARY KEY,
      run_id      TEXT,
      title       TEXT NOT NULL,
      content     TEXT NOT NULL,
      novelty     REAL DEFAULT 0,
      feasibility REAL DEFAULT 0,
      value       REAL DEFAULT 0,
      total       REAL DEFAULT 0,
      status      TEXT DEFAULT 'candidate',
      parent_id   TEXT,
      critique    TEXT DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now'))
    );

    -- Artifacts: research reports, refined plans — full markdown documents.
    CREATE TABLE IF NOT EXISTS hermes_artifacts (
      id         TEXT PRIMARY KEY,
      run_id     TEXT,
      title      TEXT NOT NULL,
      kind       TEXT DEFAULT 'report',
      content    TEXT NOT NULL,
      metadata   TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
    CREATE INDEX IF NOT EXISTS idx_files_node   ON files(node_id);
    CREATE INDEX IF NOT EXISTS idx_hermes_log_type ON hermes_log(event_type);
    CREATE INDEX IF NOT EXISTS idx_hermes_memory_type ON hermes_memory(type);
    CREATE INDEX IF NOT EXISTS idx_hermes_tasks_status ON hermes_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_hermes_runs_kind ON hermes_runs(kind);
    CREATE INDEX IF NOT EXISTS idx_hermes_ideas_total ON hermes_ideas(total);
    CREATE INDEX IF NOT EXISTS idx_hermes_artifacts_run ON hermes_artifacts(run_id);
  `);

  // ── Seed data (only if nodes table is empty) ─────────────
  const count = db.prepare('SELECT COUNT(*) AS cnt FROM nodes').get();
  if (count.cnt === 0) {
    seedDatabase();
  }

  seedHermesConfig();
  seedAnalyticsWidgets();

  console.log('[Database] Initialized at', DB_PATH);
  return db;
}

// ── Seed ─────────────────────────────────────────────────────
function seedDatabase() {
  const insertNode = db.prepare(`
    INSERT INTO nodes (id, label, type, x, y, size, color, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEdge = db.prepare(`
    INSERT INTO edges (id, source, target, weight, type)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertLog = db.prepare(`
    INSERT INTO hermes_log (event_type, message, data)
    VALUES (?, ?, ?)
  `);

  const nodeIds = [];

  const seedTx = db.transaction(() => {
    // Create nodes in a loose circular layout so the frontend has starting positions
    SEED_NODES.forEach((node, i) => {
      const id = randomUUID();
      const angle = (2 * Math.PI * i) / SEED_NODES.length;
      const radius = 300;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      const color = NEON_PALETTE[i % NEON_PALETTE.length];
      const metadata = JSON.stringify({ seedNode: true, description: `${node.label} subsystem` });

      insertNode.run(id, node.label, node.type, x, y, node.size, color, metadata);
      nodeIds.push(id);
    });

    // Create edges
    SEED_EDGES.forEach(([si, ti, weight, type]) => {
      const edgeId = randomUUID();
      insertEdge.run(edgeId, nodeIds[si], nodeIds[ti], weight, type);
    });

    // Log the genesis event
    insertLog.run(
      'system_init',
      'Hermes OS knowledge matrix initialized. All subsystems online.',
      JSON.stringify({ nodeCount: SEED_NODES.length, edgeCount: SEED_EDGES.length })
    );
  });

  seedTx();
  console.log(`[Database] Seeded ${SEED_NODES.length} nodes and ${SEED_EDGES.length} edges`);
}

function seedHermesConfig() {
  const defaults = {
    provider: 'google-gemini-cli',
    model: 'gemini-3-flash-preview',
    account: process.env.HERMES_ACCOUNT || '',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiCliPath: process.env.HERMES_GEMINI_BIN || '',
    hermesAgentPath: path.join(__dirname, '..', 'vendor', 'hermes-agent'),
    autonomyMode: 'supervised',
    memoryEnabled: true,
    dreamLoopEnabled: false,
    // 10 min keeps an always-on dream loop well inside the free Gemini
    // daily quota while leaving room for chat + research.
    dreamIntervalMs: 600000,
    dashboardMutationEnabled: true,
    accent: '#00f0ff',
    themeMode: 'dark',
    selfDirectives: [],
    researchDepth: 'standard',
  };

  const insert = db.prepare(`
    INSERT OR IGNORE INTO hermes_config (key, value)
    VALUES (?, ?)
  `);

  for (const [key, value] of Object.entries(defaults)) {
    insert.run(key, JSON.stringify(value));
  }

  migrateHermesConfig();
}

// Bring an existing config (from older builds) up to date without
// clobbering the operator's own choices.
function migrateHermesConfig() {
  const current = getHermesConfig();
  const updates = {};

  // Older builds pointed at model ids that either don't exist
  // (gemini-3.5-flash) or are no longer the newest flash. Verified live:
  // gemini-3-flash-preview works on this account — upgrade to it.
  const staleModels = ['', 'gemini-3.5-flash', 'gemini-flash-3.5', 'gemini-2.5-flash'];
  if (current.model === undefined || staleModels.includes(String(current.model))) {
    updates.model = 'gemini-3-flash-preview';
  }
  // Ensure newer keys exist.
  if (current.geminiApiKey === undefined) updates.geminiApiKey = process.env.GEMINI_API_KEY || '';
  if (current.geminiCliPath === undefined) updates.geminiCliPath = process.env.HERMES_GEMINI_BIN || '';
  if (current.dreamIntervalMs === undefined) updates.dreamIntervalMs = 180000;
  if (current.accent === undefined) updates.accent = '#00f0ff';
  if (current.themeMode === undefined) updates.themeMode = 'dark';
  if (current.provider === undefined) updates.provider = 'google-gemini-cli';
  if (current.selfDirectives === undefined) updates.selfDirectives = [];
  if (current.researchDepth === undefined) updates.researchDepth = 'standard';
  // OpenRouter second-brain provider (selected via the model chooser).
  if (current.openrouterApiKey === undefined) updates.openrouterApiKey = process.env.OPENROUTER_API_KEY || '';
  if (current.openrouterModel === undefined) updates.openrouterModel = 'nex-agi/nex-n2-pro:free';
  if (current.openrouterAutoFallback === undefined) updates.openrouterAutoFallback = true;

  if (Object.keys(updates).length) {
    const stmt = db.prepare(`
      INSERT INTO hermes_config (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `);
    for (const [k, v] of Object.entries(updates)) stmt.run(k, JSON.stringify(v));
    console.log('[Database] Migrated hermes_config keys:', Object.keys(updates).join(', '));
  }
}

// Real system telemetry widgets — every one of these is driven by actual
// events in the OS (brain calls, agent actions, loops), never faked.
const SYSTEM_WIDGETS = [
  { id: 'agent-actions',   label: 'Agent Actions',   kind: 'operations', unit: '',   color: '#ff9f1c', description: 'Dashboard changes made by Hermes.' },
  { id: 'brain-calls',     label: 'Brain Calls',     kind: 'operations', unit: '',   color: '#00f0ff', description: 'Gemini completions made this session.' },
  { id: 'brain-latency',   label: 'Brain Latency',   kind: 'operations', unit: 'ms', color: '#3b82f6', description: 'Latest Gemini round-trip time.' },
  { id: 'ideas-generated', label: 'Ideas Generated', kind: 'metric',     unit: '',   color: '#ff6ec7', description: 'Ideas produced by dream loops.' },
  { id: 'research-runs',   label: 'Research Runs',   kind: 'metric',     unit: '',   color: '#00ff88', description: 'Deep research pipelines completed.' },
];

function seedAnalyticsWidgets() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO analytics_widgets (id, label, kind, value, unit, trend, color, source, history, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const seedTx = db.transaction(() => {
    // Drop the old fake demo metrics (Visitors 46k etc.) if still untouched.
    db.prepare("DELETE FROM analytics_widgets WHERE source = 'seed'").run();
    for (const w of SYSTEM_WIDGETS) {
      insert.run(w.id, w.label, w.kind, 0, w.unit, 0, w.color, 'system',
        JSON.stringify([]), JSON.stringify({ description: w.description, system: true }));
    }
  });
  seedTx();
}

// ── CRUD: Nodes ──────────────────────────────────────────────

export function addNode({ label, type = 'default', x, y, size = 10, color = '#00fff7', metadata = {} }) {
  const id = randomUUID();
  const stmt = db.prepare(`
    INSERT INTO nodes (id, label, type, x, y, size, color, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, label, type, x ?? (Math.random() * 600 - 300), y ?? (Math.random() * 600 - 300), size, color, JSON.stringify(metadata));
  return getNodeById(id);
}

export function getNodes() {
  return db.prepare('SELECT * FROM nodes ORDER BY created_at DESC').all().map(parseNodeRow);
}

export function getNodeById(id) {
  const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
  return row ? parseNodeRow(row) : null;
}

export function updateNode(id, updates) {
  const allowed = ['label', 'type', 'x', 'y', 'size', 'color', 'metadata'];
  const sets = [];
  const values = [];

  for (const key of allowed) {
    if (updates[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(key === 'metadata' ? JSON.stringify(updates[key]) : updates[key]);
    }
  }

  if (sets.length === 0) return getNodeById(id);

  sets.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getNodeById(id);
}

export function deleteNode(id) {
  // Edges cascade-delete via FK, but let's be explicit
  db.prepare('DELETE FROM edges WHERE source = ? OR target = ?').run(id, id);
  const info = db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
  return info.changes > 0;
}

// ── CRUD: Edges ──────────────────────────────────────────────

export function addEdge({ source, target, weight = 1.0, type = 'default', metadata = {} }) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO edges (id, source, target, weight, type, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, source, target, weight, type, JSON.stringify(metadata));
  return getEdgeById(id);
}

export function getEdges() {
  return db.prepare('SELECT * FROM edges ORDER BY created_at DESC').all().map(parseEdgeRow);
}

export function getEdgeById(id) {
  const row = db.prepare('SELECT * FROM edges WHERE id = ?').get(id);
  return row ? parseEdgeRow(row) : null;
}

export function deleteEdge(id) {
  const info = db.prepare('DELETE FROM edges WHERE id = ?').run(id);
  return info.changes > 0;
}

// ── CRUD: Files ──────────────────────────────────────────────

export function addFile({ nodeId, filename, originalName, mimeType, size, filePath, metadata = {} }) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO files (id, node_id, filename, original_name, mime_type, size, path, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, nodeId, filename, originalName, mimeType, size, filePath, JSON.stringify(metadata));
  return getFileById(id);
}

export function getFiles() {
  return db.prepare('SELECT * FROM files ORDER BY created_at DESC').all().map(parseFileRow);
}

export function getFileById(id) {
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id);
  return row ? parseFileRow(row) : null;
}

// ── CRUD: Analytics Sources ──────────────────────────────────

export function addAnalyticsSource({ nodeId, name, type, config = {}, lastSync }) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO analytics_sources (id, node_id, name, type, config, last_sync)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, nodeId, name, type, JSON.stringify(config), lastSync ?? null);
  return { id, nodeId, name, type, config, lastSync };
}

export function getAnalyticsSources() {
  return db.prepare('SELECT * FROM analytics_sources ORDER BY created_at DESC').all().map(row => ({
    ...row,
    config: JSON.parse(row.config || '{}'),
  }));
}

// ── CRUD: Analytics Widgets ──────────────────────────────────

export function upsertAnalyticsWidget({
  id,
  label,
  kind = 'metric',
  value = 0,
  unit = '',
  trend = 0,
  color = '#00f0ff',
  source = 'manual',
  history = [],
  metadata = {},
}) {
  const widgetId = id || slugId(label || 'metric');
  db.prepare(`
    INSERT INTO analytics_widgets (id, label, kind, value, unit, trend, color, source, history, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      kind = excluded.kind,
      value = excluded.value,
      unit = excluded.unit,
      trend = excluded.trend,
      color = excluded.color,
      source = excluded.source,
      history = excluded.history,
      metadata = excluded.metadata,
      updated_at = datetime('now')
  `).run(
    widgetId,
    label || widgetId,
    kind,
    Number(value) || 0,
    unit || '',
    Number(trend) || 0,
    color || '#00f0ff',
    source || 'manual',
    JSON.stringify(Array.isArray(history) ? history : []),
    JSON.stringify(metadata || {})
  );
  return getAnalyticsWidgetById(widgetId);
}

export function getAnalyticsWidgets() {
  return db.prepare('SELECT * FROM analytics_widgets ORDER BY updated_at DESC, created_at DESC').all().map(parseAnalyticsWidgetRow);
}

export function getAnalyticsWidgetById(id) {
  const row = db.prepare('SELECT * FROM analytics_widgets WHERE id = ?').get(id);
  return row ? parseAnalyticsWidgetRow(row) : null;
}

export function deleteAnalyticsWidget(id) {
  const info = db.prepare('DELETE FROM analytics_widgets WHERE id = ?').run(id);
  return info.changes > 0;
}

export function incrementAnalyticsWidget(id, amount = 1) {
  const row = getAnalyticsWidgetById(id);
  if (!row) return null;
  const history = [...(row.history || []), Number(row.value) + amount].slice(-24);
  return upsertAnalyticsWidget({
    ...row,
    value: Number(row.value || 0) + amount,
    history,
    metadata: row.metadata,
  });
}

// ── CRUD: Hermes Config ──────────────────────────────────────

export function getHermesConfig() {
  const rows = db.prepare('SELECT key, value FROM hermes_config').all();
  const config = {};
  for (const row of rows) {
    config[row.key] = parseJson(row.value, row.value);
  }
  return config;
}

export function setHermesConfig(key, value) {
  db.prepare(`
    INSERT INTO hermes_config (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now')
  `).run(key, JSON.stringify(value));
  return getHermesConfig();
}

export function updateHermesConfig(updates = {}) {
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) {
      setHermesConfig(key, value);
    }
  });
  tx(Object.entries(updates));
  return getHermesConfig();
}

// ── CRUD: Hermes Memory ──────────────────────────────────────

export function addHermesMemory({ type = 'note', content, tags = [], metadata = {} }) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO hermes_memory (id, type, content, tags, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, type, content, JSON.stringify(tags || []), JSON.stringify(metadata || {}));
  return getHermesMemoryById(id);
}

export function getHermesMemory(limit = 50) {
  return db.prepare('SELECT * FROM hermes_memory ORDER BY created_at DESC LIMIT ?').all(limit).map(parseHermesMemoryRow);
}

export function getHermesMemoryById(id) {
  const row = db.prepare('SELECT * FROM hermes_memory WHERE id = ?').get(id);
  return row ? parseHermesMemoryRow(row) : null;
}

export function deleteHermesMemory(id) {
  const info = db.prepare('DELETE FROM hermes_memory WHERE id = ?').run(id);
  return info.changes > 0;
}

export function searchHermesMemory(query = '', limit = 8) {
  const terms = String(query).toLowerCase().split(/\W+/).filter(Boolean).slice(0, 12);
  const rows = getHermesMemory(200);
  if (!terms.length) return rows.slice(0, limit);

  return rows
    .map(row => {
      const haystack = `${row.content} ${(row.tags || []).join(' ')}`.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      return { row, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.row);
}

// ── CRUD: Hermes Tasks ───────────────────────────────────────

export function addHermesTask({ title, status = 'queued', priority = 2, metadata = {} }) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO hermes_tasks (id, title, status, priority, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, title, status, priority, JSON.stringify(metadata || {}));
  return getHermesTaskById(id);
}

export function getHermesTasks(limit = 50) {
  return db.prepare('SELECT * FROM hermes_tasks ORDER BY created_at DESC LIMIT ?').all(limit).map(parseHermesTaskRow);
}

export function getHermesTaskById(id) {
  const row = db.prepare('SELECT * FROM hermes_tasks WHERE id = ?').get(id);
  return row ? parseHermesTaskRow(row) : null;
}

export function updateHermesTask(id, updates = {}) {
  const allowed = ['title', 'status', 'priority', 'metadata'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(key === 'metadata' ? JSON.stringify(updates[key]) : updates[key]);
    }
  }
  if (!sets.length) return getHermesTaskById(id);
  sets.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE hermes_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getHermesTaskById(id);
}

// ── CRUD: Hermes Log ─────────────────────────────────────────

export function addHermesLog({ eventType, message, data = {} }) {
  const stmt = db.prepare(`
    INSERT INTO hermes_log (event_type, message, data) VALUES (?, ?, ?)
  `);
  const info = stmt.run(eventType, message, JSON.stringify(data));
  return { id: info.lastInsertRowid, eventType, message, data };
}

export function getHermesLogs(limit = 50) {
  return db.prepare('SELECT * FROM hermes_log ORDER BY created_at DESC LIMIT ?').all(limit).map(row => ({
    ...row,
    data: JSON.parse(row.data || '{}'),
  }));
}

// ── CRUD: Cognition Runs (research pipelines / dream cycles) ──

export function addHermesRun({ kind = 'research', title, status = 'running', phase = 'queued' }) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO hermes_runs (id, kind, title, status, phase)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, kind, title, status, phase);
  return getHermesRunById(id);
}

export function updateHermesRun(id, updates = {}) {
  const allowed = ['title', 'status', 'phase', 'progress', 'log', 'result'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(['log', 'result'].includes(key) ? JSON.stringify(updates[key]) : updates[key]);
    }
  }
  if (!sets.length) return getHermesRunById(id);
  sets.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE hermes_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getHermesRunById(id);
}

export function getHermesRunById(id) {
  const row = db.prepare('SELECT * FROM hermes_runs WHERE id = ?').get(id);
  return row ? parseRunRow(row) : null;
}

export function getHermesRuns(limit = 20, kind = null) {
  const rows = kind
    ? db.prepare('SELECT * FROM hermes_runs WHERE kind = ? ORDER BY created_at DESC LIMIT ?').all(kind, limit)
    : db.prepare('SELECT * FROM hermes_runs ORDER BY created_at DESC LIMIT ?').all(limit);
  return rows.map(parseRunRow);
}

// ── CRUD: Idea Ledger ────────────────────────────────────────

export function addHermesIdea({ runId, title, content, novelty = 0, feasibility = 0, value = 0, status = 'candidate', parentId = null, critique = '' }) {
  const id = randomUUID();
  const total = Number(novelty) + Number(feasibility) + Number(value);
  db.prepare(`
    INSERT INTO hermes_ideas (id, run_id, title, content, novelty, feasibility, value, total, status, parent_id, critique)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, runId || null, title, content, novelty, feasibility, value, total, status, parentId, critique);
  return getHermesIdeaById(id);
}

export function updateHermesIdea(id, updates = {}) {
  const allowed = ['title', 'content', 'novelty', 'feasibility', 'value', 'status', 'critique'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (updates[key] !== undefined) { sets.push(`${key} = ?`); values.push(updates[key]); }
  }
  if (sets.length) {
    values.push(id);
    db.prepare(`UPDATE hermes_ideas SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    const row = getHermesIdeaById(id);
    if (row) {
      db.prepare('UPDATE hermes_ideas SET total = ? WHERE id = ?')
        .run(Number(row.novelty) + Number(row.feasibility) + Number(row.value), id);
    }
  }
  return getHermesIdeaById(id);
}

export function getHermesIdeaById(id) {
  return db.prepare('SELECT * FROM hermes_ideas WHERE id = ?').get(id) || null;
}

export function getHermesIdeas(limit = 30, orderBy = 'total') {
  const order = orderBy === 'recent' ? 'created_at DESC' : 'total DESC, created_at DESC';
  return db.prepare(`SELECT * FROM hermes_ideas ORDER BY ${order} LIMIT ?`).all(limit);
}

// ── CRUD: Artifacts (reports, plans) ─────────────────────────

export function addHermesArtifact({ runId, title, kind = 'report', content, metadata = {} }) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO hermes_artifacts (id, run_id, title, kind, content, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, runId || null, title, kind, content, JSON.stringify(metadata || {}));
  return getHermesArtifactById(id);
}

export function getHermesArtifactById(id) {
  const row = db.prepare('SELECT * FROM hermes_artifacts WHERE id = ?').get(id);
  return row ? { ...row, metadata: parseJson(row.metadata, {}) } : null;
}

export function getHermesArtifacts(limit = 20) {
  // List view omits full content to stay light.
  return db.prepare(`
    SELECT id, run_id, title, kind, substr(content, 1, 240) AS preview, metadata, created_at
    FROM hermes_artifacts ORDER BY created_at DESC LIMIT ?
  `).all(limit).map(row => ({ ...row, metadata: parseJson(row.metadata, {}) }));
}

function parseRunRow(row) {
  return {
    ...row,
    log: parseJson(row.log, []),
    result: parseJson(row.result, {}),
  };
}

// ── Row parsers (JSON fields) ────────────────────────────────

function parseNodeRow(row) {
  return { ...row, metadata: JSON.parse(row.metadata || '{}') };
}

function parseEdgeRow(row) {
  return { ...row, metadata: JSON.parse(row.metadata || '{}') };
}

function parseFileRow(row) {
  return { ...row, metadata: JSON.parse(row.metadata || '{}') };
}

function parseAnalyticsWidgetRow(row) {
  return {
    ...row,
    history: parseJson(row.history, []),
    metadata: parseJson(row.metadata, {}),
  };
}

function parseHermesMemoryRow(row) {
  return {
    ...row,
    tags: parseJson(row.tags, []),
    metadata: parseJson(row.metadata, {}),
  };
}

function parseHermesTaskRow(row) {
  return {
    ...row,
    metadata: parseJson(row.metadata, {}),
  };
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

function slugId(value) {
  const slug = String(value || 'metric')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || randomUUID();
}

// ── Raw db accessor (for other modules) ──────────────────────
export function getDb() {
  return db;
}

export default {
  initDatabase,
  addNode, getNodes, getNodeById, updateNode, deleteNode,
  addEdge, getEdges, getEdgeById, deleteEdge,
  addFile, getFiles, getFileById,
  addAnalyticsSource, getAnalyticsSources,
  upsertAnalyticsWidget, getAnalyticsWidgets, getAnalyticsWidgetById, deleteAnalyticsWidget, incrementAnalyticsWidget,
  getHermesConfig, setHermesConfig, updateHermesConfig,
  addHermesMemory, getHermesMemory, getHermesMemoryById, searchHermesMemory, deleteHermesMemory,
  addHermesTask, getHermesTasks, getHermesTaskById, updateHermesTask,
  addHermesLog, getHermesLogs,
  addHermesRun, updateHermesRun, getHermesRunById, getHermesRuns,
  addHermesIdea, updateHermesIdea, getHermesIdeaById, getHermesIdeas,
  addHermesArtifact, getHermesArtifactById, getHermesArtifacts,
  getDb,
};
