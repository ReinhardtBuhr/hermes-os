// ─────────────────────────────────────────────────────────────
// Hermes OS — Main Server
// Express + WebSocket on port 3001
// ─────────────────────────────────────────────────────────────

import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import multer from 'multer';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Local modules
import db from './database.js';
import graphEngine from './graph-engine.js';
import fileProcessor from './file-processor.js';
import { HermesAgent } from './hermes.js';
import { AnalyticsEngine } from './analytics.js';
import { CouncilEngine } from './council.js';

// ── __dirname polyfill ───────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Last-resort crash guards ─────────────────────────────────
// An unhandled rejection inside a long research/dream/council loop must
// never take the whole backend down overnight. Log it loudly, keep serving.
// (Real crashes still get restarted by the launcher + launchd service.)
process.on('uncaughtException', (err) => {
  console.error('[FATAL-GUARD] uncaughtException (continuing):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL-GUARD] unhandledRejection (continuing):', reason);
});

// ── Config ───────────────────────────────────────────────────
// Hermes OS owns port 3210. (3001 belongs to the user's other
// project "Research Model", which kills whatever holds that port.)
const PORT = Number(process.env.HERMES_PORT) || 3210;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DIST_DIR = path.join(__dirname, '..', 'dist'); // built frontend (vite build)
// When dist/ exists, this backend serves the whole app on its own — no
// Vite dev server, no proxy, no file-watcher. That is the overnight-safe
// way to run Hermes; Vite is only for live development.
const HAS_DIST = fs.existsSync(path.join(DIST_DIR, 'index.html'));

// Ensure uploads directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  console.log('[Server] Created uploads directory');
}

// ── Initialize core systems ──────────────────────────────────
const database = db.initDatabase();
const hermes = new HermesAgent();
const analytics = new AnalyticsEngine(db);

// ── Express app ──────────────────────────────────────────────
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files statically
app.use('/uploads', express.static(UPLOAD_DIR));

// Serve the built frontend (vite build → dist/). Static assets are matched
// first; requests that don't map to a file fall through to the API routes
// below, and finally to the SPA fallback at the bottom of this file.
if (HAS_DIST) {
  app.use(express.static(DIST_DIR));
  console.log('[Server] Serving built UI from dist/ — open http://localhost:' + PORT);
} else {
  console.warn('[Server] dist/ not built yet — run `npm run build` to serve the UI from here. API is still up.');
}

// ── Multer setup ─────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueSuffix}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

// ── HTTP server + WebSocket ──────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Track connected clients
const clients = new Set();

function wsBroadcast(message) {
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(payload);
    }
  }
}

function broadcastSystemStatus() {
  wsBroadcast({
    type: 'system_status',
    payload: hermes.getSystemStatus(),
  });
}

function broadcastGraphUpdate(reason = 'graph_update') {
  const graphData = graphEngine.getGraphData(db);
  wsBroadcast({
    type: 'graph_update',
    payload: graphData,
    reason,
  });
  return graphData;
}

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WebSocket] Client connected (${clients.size} total)`);

  // Send Hermes greeting on connect (never let this crash the handler)
  try {
    const greeting = hermes.getGreeting();
    ws.send(JSON.stringify({ type: 'hermes_greeting', payload: greeting }));
    ws.send(JSON.stringify({ type: 'system_status', payload: hermes.getSystemStatus() }));
  } catch (err) {
    console.error('[WebSocket] greeting error:', err);
    ws.send(JSON.stringify({ type: 'hermes_greeting', payload: { greeting: 'Hermes OS online.' } }));
  }

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WebSocket] Client disconnected (${clients.size} total)`);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      // Handle incoming messages from clients
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      }
    } catch {
      // Ignore malformed messages
    }
  });
});

// Initialize Hermes with broadcast and graph refresh hooks
hermes.init(db, wsBroadcast, {
  broadcastGraphUpdate,
});

// Research Council: multi-agent hypothesis tournament over the same brain.
const council = new CouncilEngine({
  brain: hermes.brain,
  broadcast: wsBroadcast,
  getConfig: () => hermes.getConfig(),
});
council.resumeOnBoot();

setInterval(() => {
  if (clients.size > 0) broadcastSystemStatus();
}, 15000);

// ─────────────────────────────────────────────────────────────
// REST API Routes
// ─────────────────────────────────────────────────────────────

// ── Graph ────────────────────────────────────────────────────

app.get('/api/graph', (_req, res) => {
  try {
    const data = graphEngine.getGraphData(db);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[API] GET /api/graph error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/graph/nodes', async (req, res) => {
  try {
    const { label, type, x, y, size, color, metadata } = req.body;
    if (!label) {
      return res.status(400).json({ success: false, error: 'Label is required' });
    }

    const node = db.addNode({ label, type, x, y, size, color, metadata });

    // Let Hermes know
    await hermes.processEvent({ type: 'node_added', data: { nodeId: node.id, label } });
    broadcastGraphUpdate('node_added');
    broadcastSystemStatus();

    res.status(201).json({ success: true, data: node });
  } catch (err) {
    console.error('[API] POST /api/graph/nodes error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/graph/nodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const node = db.getNodeById(id);
    const deleted = db.deleteNode(id);

    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Node not found' });
    }

    // Hermes event
    await hermes.processEvent({ type: 'node_deleted', data: { nodeId: id, label: node?.label } });
    broadcastGraphUpdate('node_deleted');
    broadcastSystemStatus();

    res.json({ success: true, message: 'Node deleted' });
  } catch (err) {
    console.error('[API] DELETE /api/graph/nodes/:id error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Files ────────────────────────────────────────────────────

app.get('/api/files', (_req, res) => {
  try {
    const files = db.getFiles();
    res.json({ success: true, data: files });
  } catch (err) {
    console.error('[API] GET /api/files error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/files/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file provided' });
    }

    // 1. Process the file metadata
    const fileMeta = fileProcessor.processUploadedFile(req.file, UPLOAD_DIR);

    // 2. Add to graph (creates node + edges)
    const graphResult = graphEngine.addFileToGraph(fileMeta, db);

    // 3. Save file record in DB
    const fileRecord = db.addFile({
      nodeId: graphResult.node.id,
      filename: fileMeta.filename,
      originalName: fileMeta.originalName,
      mimeType: fileMeta.mimeType,
      size: fileMeta.size,
      filePath: fileMeta.filePath,
      metadata: {
        category: fileMeta.category,
        keywords: fileMeta.keywords,
        extension: fileMeta.extension,
      },
    });

    // 4. Hermes event
    await hermes.processEvent({
      type: 'file_uploaded',
      data: {
        fileId: fileRecord.id,
        nodeId: graphResult.node.id,
        filename: fileMeta.originalName,
        category: fileMeta.category,
        edgesCreated: graphResult.edges.length,
      },
    });

    wsBroadcast({
      type: 'file_added',
      payload: {
        file: fileRecord,
        node: graphResult.node,
        edgesCreated: graphResult.edges.length,
      },
    });
    broadcastGraphUpdate('file_uploaded');
    broadcastSystemStatus();

    res.status(201).json({
      success: true,
      data: {
        file: fileRecord,
        node: graphResult.node,
        edgesCreated: graphResult.edges.length,
      },
    });
  } catch (err) {
    console.error('[API] POST /api/files/upload error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Analytics ────────────────────────────────────────────────

app.get('/api/analytics/summary', (_req, res) => {
  try {
    const summary = analytics.getSummary();
    res.json({ success: true, data: summary });
  } catch (err) {
    console.error('[API] GET /api/analytics/summary error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/analytics/traffic', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const data = analytics.getTrafficData(days);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[API] GET /api/analytics/traffic error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/analytics/social', (_req, res) => {
  try {
    const data = analytics.getSocialMetrics();
    res.json({ success: true, data });
  } catch (err) {
    console.error('[API] GET /api/analytics/social error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/analytics/revenue', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const data = analytics.getRevenueData(days);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[API] GET /api/analytics/revenue error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/analytics/sources', (_req, res) => {
  try {
    const data = analytics.getAnalyticsNodes();
    res.json({ success: true, data });
  } catch (err) {
    console.error('[API] GET /api/analytics/sources error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/analytics/widgets', (_req, res) => {
  try {
    const data = analytics.getWidgets();
    res.json({ success: true, data });
  } catch (err) {
    console.error('[API] GET /api/analytics/widgets error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/analytics/widgets', (req, res) => {
  try {
    const widget = analytics.upsertWidget(req.body || {});
    wsBroadcast({
      type: 'analytics_update',
      payload: {
        widgets: analytics.getWidgets(),
        timestamp: new Date().toISOString(),
      },
    });
    res.status(201).json({ success: true, data: widget });
  } catch (err) {
    console.error('[API] POST /api/analytics/widgets error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/analytics/widgets/:id', (req, res) => {
  try {
    const ok = db.deleteAnalyticsWidget(req.params.id);
    wsBroadcast({
      type: 'analytics_update',
      payload: { widgets: analytics.getWidgets(), timestamp: new Date().toISOString() },
    });
    broadcastGraphUpdate('widget_removed');
    res.json({ success: ok });
  } catch (err) {
    console.error('[API] DELETE /api/analytics/widgets/:id error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Hermes Agent ─────────────────────────────────────────────

app.get('/api/hermes/status', (_req, res) => {
  try {
    const status = hermes.getSystemStatus();
    res.json({ success: true, data: status });
  } catch (err) {
    console.error('[API] GET /api/hermes/status error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/hermes/activity', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const feed = hermes.getActivityFeed(limit);
    res.json({ success: true, data: feed });
  } catch (err) {
    console.error('[API] GET /api/hermes/activity error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/hermes/config', (_req, res) => {
  try {
    res.json({ success: true, data: hermes.getConfig() });
  } catch (err) {
    console.error('[API] GET /api/hermes/config error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/hermes/config', (req, res) => {
  try {
    const body = req.body || {};
    const config = hermes.updateConfig(body);
    // A brain switch should take effect everywhere instantly — wake any
    // quota-paused councils so they probe the new model right away.
    const brainKeys = ['provider', 'model', 'openrouterModel', 'openrouterApiKey', 'openrouterAutoFallback'];
    if (brainKeys.some(k => k in body)) {
      const resumed = council.probePausedNow();
      if (resumed) console.log(`[API] Brain switched — probing ${resumed} paused council(s) now.`);
    }
    res.json({ success: true, data: config });
  } catch (err) {
    console.error('[API] PATCH /api/hermes/config error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Model chooser ────────────────────────────────────────────
// The selectable brains. Picking one PATCHes config; the Brain re-reads
// config on every call, so the switch applies to the very next LLM call
// (chat, research, dreams AND a mid-run council) with no restart.
app.get('/api/hermes/models', async (_req, res) => {
  try {
    const cfg = hermes.getConfig();
    const brain = await hermes.getBrainStatus();
    const onOpenRouter = String(cfg.provider || '').toLowerCase() === 'openrouter';
    const options = [
      {
        id: 'gemini-flash',
        label: 'Gemini 3 Flash',
        sub: 'Google · the proven default',
        config: { provider: 'google-gemini-cli', model: 'gemini-3-flash-preview' },
      },
      {
        id: 'gemini-best',
        label: 'Gemini Best',
        sub: 'Pro first · auto-drops to Flash at limit',
        config: { provider: 'google-gemini-cli', model: 'gemini-best' },
      },
      {
        id: 'openrouter-nex',
        label: 'NEX N2 Pro',
        sub: 'OpenRouter · free',
        config: { provider: 'openrouter', openrouterModel: 'nex-agi/nex-n2-pro:free', openrouterAutoFallback: false },
      },
      {
        id: 'openrouter-auto',
        label: 'OpenRouter Auto',
        sub: 'NEX first · next best free model at limit',
        config: { provider: 'openrouter', openrouterModel: 'nex-agi/nex-n2-pro:free', openrouterAutoFallback: true },
      },
      {
        id: 'openrouter-best',
        label: 'Best Free (Auto)',
        sub: 'Always the strongest free model live on OpenRouter',
        config: { provider: 'openrouter', openrouterModel: 'auto', openrouterAutoFallback: true },
      },
      {
        id: 'hybrid',
        label: 'Hybrid Duo',
        sub: 'Gemini + NEX in parallel · 2× throughput',
        config: { provider: 'hybrid', openrouterModel: 'nex-agi/nex-n2-pro:free', openrouterAutoFallback: true },
      },
      {
        id: 'hybrid-best',
        label: 'Hybrid Best',
        sub: 'Gemini untouched + best free OpenRouter model in parallel',
        config: { provider: 'hybrid', openrouterModel: 'auto', openrouterAutoFallback: true },
      },
    ];
    const onHybrid = String(cfg.provider || '').toLowerCase() === 'hybrid';
    const orAuto = String(cfg.openrouterModel || '').toLowerCase() === 'auto';
    let active = 'gemini-flash';
    if (onHybrid) {
      active = orAuto ? 'hybrid-best' : 'hybrid';
    } else if (onOpenRouter) {
      active = orAuto ? 'openrouter-best'
        : cfg.openrouterAutoFallback === false ? 'openrouter-nex' : 'openrouter-auto';
    } else if (/pro|best/i.test(String(cfg.model || ''))) {
      active = 'gemini-best';
    }
    res.json({
      success: true,
      data: {
        options,
        active,
        openrouterKeyPresent: Boolean(brain.openrouterKeyPresent),
        brain,
      },
    });
  } catch (err) {
    console.error('[API] GET /api/hermes/models error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/hermes/memory', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    res.json({ success: true, data: hermes.getMemory(limit) });
  } catch (err) {
    console.error('[API] GET /api/hermes/memory error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/hermes/tasks', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    res.json({ success: true, data: hermes.getTasks(limit) });
  } catch (err) {
    console.error('[API] GET /api/hermes/tasks error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/hermes/chat', async (req, res) => {
  try {
    const result = await hermes.chat({
      message: req.body?.message,
      clientMessageId: req.body?.clientMessageId,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[API] POST /api/hermes/chat error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/hermes/brain', async (_req, res) => {
  try {
    const status = await hermes.getBrainStatus();
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/hermes/brain/test', async (_req, res) => {
  try {
    const result = await hermes.testBrain();
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[API] POST /api/hermes/brain/test error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/hermes/insight', (_req, res) => {
  try {
    const insight = hermes.generateInsight();
    res.json({ success: true, data: insight });
  } catch (err) {
    console.error('[API] GET /api/hermes/insight error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Cognition: deep research, dream loops, ideas, artifacts ──

app.post('/api/hermes/research', (req, res) => {
  try {
    const { question, depth } = req.body || {};
    const result = hermes.cognition.startResearch(question, { depth, origin: 'api' });
    if (result.error) {
      return res.status(409).json({ success: false, error: result.message || result.error });
    }
    res.status(202).json({ success: true, data: result.run });
  } catch (err) {
    console.error('[API] POST /api/hermes/research error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/hermes/dream/cycle', (_req, res) => {
  try {
    if (hermes.cognition.dreamActive) {
      return res.status(409).json({ success: false, error: 'A dream cycle is already running.' });
    }
    // Fire and forget — progress streams over the WebSocket.
    hermes.cognition.dreamCycle({ trigger: 'manual' }).catch(() => {});
    res.status(202).json({ success: true, data: { started: true } });
  } catch (err) {
    console.error('[API] POST /api/hermes/dream/cycle error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/hermes/runs', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const kind = req.query.kind || null;
    res.json({ success: true, data: db.getHermesRuns(limit, kind) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/hermes/runs/:id', (req, res) => {
  try {
    const run = db.getHermesRunById(req.params.id);
    if (!run) return res.status(404).json({ success: false, error: 'Run not found' });
    res.json({ success: true, data: run });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/hermes/ideas', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const order = req.query.order === 'recent' ? 'recent' : 'total';
    res.json({ success: true, data: db.getHermesIdeas(limit, order) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/hermes/artifacts', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    res.json({ success: true, data: db.getHermesArtifacts(limit) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/hermes/artifacts/:id', (req, res) => {
  try {
    const artifact = db.getHermesArtifactById(req.params.id);
    if (!artifact) return res.status(404).json({ success: false, error: 'Artifact not found' });
    res.json({ success: true, data: artifact });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Research Council: multi-agent hypothesis tournament ──────

app.post('/api/council', (req, res) => {
  try {
    const { goal, config } = req.body || {};
    const result = council.start(goal, config || {});
    if (result.error) {
      return res.status(result.error === 'council_busy' ? 409 : 400)
        .json({ success: false, error: result.message || result.error });
    }
    res.status(202).json({ success: true, data: result.council });
  } catch (err) {
    console.error('[API] POST /api/council error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/council', (_req, res) => {
  try {
    res.json({ success: true, data: council.list() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/council/:id', (req, res) => {
  try {
    const detail = council.detail(req.params.id);
    if (!detail) return res.status(404).json({ success: false, error: 'Council not found' });
    res.json({ success: true, data: detail });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/council/:id/stop', (req, res) => {
  try {
    const result = council.stop(req.params.id);
    if (result.error) return res.status(404).json({ success: false, error: result.error });
    res.json({ success: true, data: result.council });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/council/:id/resume', (req, res) => {
  try {
    const result = council.resume(req.params.id);
    if (result.error) {
      return res.status(result.error === 'council_busy' ? 409 : 400)
        .json({ success: false, error: result.message || result.error });
    }
    res.json({ success: true, data: result.council });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Operator veto: strike a hypothesis, refund its stolen Elo, and teach
// every agent the operator's taste — all live, mid-session.
app.post('/api/council/:id/veto', (req, res) => {
  try {
    const result = council.veto(req.params.id, req.body?.hypothesisId, req.body?.reason || '');
    if (result.error) {
      return res.status(result.error === 'not_found' || result.error === 'hypothesis_not_found' ? 404 : 400)
        .json({ success: false, error: result.error });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Operator purge: clear the proposed leaderboard in one stroke. Everything
// except the check-marked "keep" hypotheses is struck; the council pivots,
// favoring the kept directions — all live, mid-session.
app.post('/api/council/:id/purge', (req, res) => {
  try {
    const result = council.clearProposals(req.params.id, {
      keepIds: req.body?.keepIds || [],
      reason: req.body?.reason || '',
    });
    if (result.error) {
      const code = result.error === 'not_found' ? 404 : 400;
      return res.status(code).json({ success: false, error: result.error });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Power dial: token burn ↔ speed/parallelism. Applies next iteration.
app.post('/api/council/:id/power', (req, res) => {
  try {
    const result = council.setPower(req.params.id, req.body?.power);
    if (result.error) {
      return res.status(result.error === 'not_found' ? 404 : 400)
        .json({ success: false, error: result.error });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/council/:id/graph', (req, res) => {
  try {
    const graph = council.graph(req.params.id);
    if (!graph) return res.status(404).json({ success: false, error: 'Council not found' });
    res.json({ success: true, data: graph });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// The operator's revive button: one POST re-tests the brain, re-engages
// any idle council loops and probes paused ones — the in-app fix for
// "the agents went offline" (no terminal needed).
app.post('/api/system/revive', async (_req, res) => {
  try {
    const revived = council.revive();
    const brainTest = await hermes.brain.test();
    res.json({
      success: true,
      data: { brain: brainTest, ...revived, uptime: Math.round(process.uptime()) },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Evolution forest: every hypothesis ever born (any status) + lineage,
// for the animated Evolution Tree view.
app.get('/api/council/:id/tree', (req, res) => {
  try {
    const tree = council.tree(req.params.id);
    if (!tree) return res.status(404).json({ success: false, error: 'Council not found' });
    res.json({ success: true, data: tree });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Agent attributes: read every station's live traits + mind, retune any of
// them at runtime. Changes apply on the agent's very next brain call.
app.get('/api/council/:id/agents', (req, res) => {
  try {
    const agents = council.agents(req.params.id);
    if (!agents) return res.status(404).json({ success: false, error: 'Council not found' });
    res.json({ success: true, data: agents });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/council/:id/agents/:role', (req, res) => {
  try {
    const result = council.updateAgent(req.params.id, req.params.role, req.body || {});
    if (result.error) {
      return res.status(result.error === 'not_found' ? 404 : 400)
        .json({ success: false, error: result.error });
    }
    res.json({ success: true, data: result.agent });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/council/:id/conclude', async (req, res) => {
  try {
    const result = await council.conclude(req.params.id);
    if (result.error) {
      const code = result.error === 'not_found' ? 404 : result.error === 'busy' ? 409 : 400;
      return res.status(code).json({ success: false, error: result.message || result.error });
    }
    res.json({ success: true, data: result.council });
  } catch (err) {
    console.error('[API] POST /api/council/:id/conclude error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Evidence may arrive as JSON (text only) or multipart (text + photos).
// Multer ignores non-multipart requests, so both content types pass through.
app.post('/api/council/:id/evidence', upload.array('images', 8), (req, res) => {
  try {
    const images = (req.files || []).map(f => `/uploads/${f.filename}`);
    const result = council.submitEvidence(req.params.id, req.body?.content, images);
    if (result.error) {
      return res.status(result.error === 'not_found' ? 404 : 400)
        .json({ success: false, error: result.error });
    }
    res.status(202).json({ success: true, data: result.evidence });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Health check ─────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ── SPA fallback + 404 ───────────────────────────────────────
// Any non-API GET serves the built index.html so the single-page app boots
// straight from this backend. Unknown /api and /uploads paths still get a
// JSON 404. WebSocket upgrades on /ws are handled by the server above.
app.use((req, res) => {
  if (req.method === 'GET' && HAS_DIST
      && !req.path.startsWith('/api') && !req.path.startsWith('/uploads')) {
    return res.sendFile(path.join(DIST_DIR, 'index.html'));
  }
  res.status(404).json({
    success: false,
    error: 'Endpoint not found. The matrix does not recognize this path.',
  });
});

// ── Start server ─────────────────────────────────────────────

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║          ⚡ HERMES OS — BACKEND ⚡           ║');
  console.log('  ╠══════════════════════════════════════════════╣');
  console.log(`  ║  HTTP  → http://localhost:${PORT}              ║`);
  console.log(`  ║  WS    → ws://localhost:${PORT}/ws              ║`);
  console.log('  ║  Status: All subsystems ONLINE               ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
});

export default app;
