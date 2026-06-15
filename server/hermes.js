// Hermes OS agent service.
// LLM-driven chat + an action protocol the model uses to mutate the
// dashboard in real time (analytics, graph, memory, config, theme,
// self-improvement loops). The brain is Google Gemini (see brain.js).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Brain, extractJson, resolveModel } from './brain.js';
import { CognitionEngine } from './cognition.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BOOT_TIME = Date.now();

const EVENT_RESPONSES = {
  file_uploaded: 'File indexed and linked into the knowledge graph.',
  node_added: 'Node added to the graph.',
  node_deleted: 'Node removed; linked edges cleaned up.',
  analytics_update: 'Analytics refreshed.',
  system_init: 'Hermes agent core online. Memory, brain, graph and dashboard tools ready.',
};

const SAFE_CONFIG_KEYS = new Set([
  'provider', 'model', 'account', 'geminiApiKey', 'geminiCliPath',
  'openrouterApiKey', 'openrouterModel', 'openrouterAutoFallback',
  'autonomyMode', 'memoryEnabled', 'dreamLoopEnabled', 'dreamIntervalMs',
  'dashboardMutationEnabled', 'accent', 'themeMode',
  'selfDirectives', 'researchDepth', 'dreamFocus',
]);

const WIDGET_COLORS = ['#00f0ff', '#00ff88', '#3b82f6', '#ff9f1c', '#ff3366', '#7b2fff'];

export class HermesAgent {
  constructor() {
    this.db = null;
    this.wsBroadcast = () => {};
    this.actions = {};
    this.messageCounter = 0;
    this.brain = null;
    this.dreamTimer = null;
    this.dreaming = false;
    this.thinking = false;
  }

  init(db, wsBroadcast, actions = {}) {
    this.db = db;
    this.wsBroadcast = wsBroadcast || (() => {});
    this.actions = actions || {};
    this.brain = new Brain(() => this.getConfig());
    this.brain.onMetric = (m) => this._recordBrainMetric(m);

    this.cognition = new CognitionEngine({
      db,
      brain: this.brain,
      broadcast: this.wsBroadcast,
      applyActions: (acts, meta) => this._applyActions(acts, meta),
      getConfig: () => this.getConfig(),
      ensureNode: (...a) => this._ensureNode(...a),
      ensureEdge: (...a) => this._ensureEdge(...a),
    });

    this._ensureAgentGraph();
    this.db.addHermesLog({
      eventType: 'system_init',
      message: EVENT_RESPONSES.system_init,
      data: { bootTime: new Date().toISOString() },
    });

    // Probe the brain once (non-blocking) so the UI shows real state.
    this._refreshBrainStatus();
    this._scheduleDreamLoop();

    console.log('[Hermes] Agent service initialized.');
  }

  // ── Greeting (called by index.js on every WS connect) ──────────
  getGreeting() {
    const status = this.getSystemStatus();
    const b = status.agent.brain;
    const hour = new Date().getHours();
    const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    let greeting;
    if (b.ready) {
      greeting = `Good ${part}. Hermes online — Gemini brain connected (${b.model}). ${status.nodeCount} graph nodes, ${status.agent.memoryCount} memories, ${status.agent.ideaCount} ideas in the ledger. Ask me anything, tell me to research a topic, or say "dream" and I'll generate novel ideas.`;
    } else if (b.reason === 'needs_login') {
      greeting = `Good ${part}. Hermes is online in local mode. The Gemini CLI is installed but not logged in yet — run "npm run connect-brain" (one-time Google sign-in) and I'll think with Gemini ${b.model}. I can still control the dashboard meanwhile.`;
    } else {
      greeting = `Good ${part}. Hermes online in local control mode. Connect a Gemini brain to unlock reasoning, dreaming and self-improvement.`;
    }
    return { greeting, status };
  }

  // ── Chat ───────────────────────────────────────────────────────
  async chat({ message, clientMessageId } = {}) {
    const text = String(message || '').trim();
    if (!text) {
      return { type: 'hermes', text: 'Send me a directive and I will route it through the agent core.', actions: [] };
    }

    const messageId = `hm-${Date.now()}-${++this.messageCounter}`;
    this._setThinking(true);
    this._trace('directive_received', { messageId, preview: text.slice(0, 160) });
    this.db.addHermesLog({ eventType: 'user_chat', message: text, data: { messageId, clientMessageId, type: 'user' } });

    let reply = '';
    let applied = [];
    let brainMode = 'local';
    let usedModel = resolveModel(this.getConfig().model);
    let provider = 'local';

    try {
      const context = this._buildContext(text);
      const brain = await this.brain.complete({
        system: this._buildSystemPrompt(context),
        prompt: this._buildUserPrompt(text, context),
        timeoutMs: 90000,
      });

      if (brain.ok) {
        provider = brain.provider;
        usedModel = brain.model;
        brainMode = 'model';
        const parsed = extractJson(brain.text);
        if (parsed && typeof parsed === 'object') {
          reply = String(parsed.reply || parsed.message || '').trim();
          const proposed = Array.isArray(parsed.actions) ? parsed.actions : [];
          applied = this._applyActions(proposed, { messageId, origin: 'chat' });
          if (!reply) reply = applied.length ? this._summarize(applied) : 'Done.';
        } else {
          // Model answered in prose — still useful.
          reply = brain.text.trim();
        }
      } else {
        // Brain unavailable → local control layer still acts on the request.
        applied = this._localInterpret(text, messageId);
        reply = this._composeLocalReply(text, applied, brain);
      }
    } catch (error) {
      console.error('[Hermes] chat error:', error);
      reply = 'I hit an internal error processing that. The dashboard core is still online.';
    } finally {
      this._setThinking(false);
    }

    const logEntry = this.db.addHermesLog({
      eventType: 'assistant_chat',
      message: reply,
      data: { messageId, type: 'hermes', model: usedModel, provider, brainMode, actions: applied },
    });

    const payload = {
      id: messageId,
      type: 'hermes',
      text: reply,
      message: reply,
      timestamp: new Date().toISOString(),
      model: usedModel,
      provider,
      brainMode,
      actions: applied,
      logId: logEntry.id,
    };

    this.wsBroadcast({ type: 'hermes_message', payload });
    this.wsBroadcast({ type: 'system_status', payload: this.getSystemStatus() });
    return payload;
  }

  // ── System prompt: who Hermes is + the action protocol ─────────
  _buildSystemPrompt(context) {
    const cfg = this.getConfig();
    const directives = Array.isArray(cfg.selfDirectives) && cfg.selfDirectives.length
      ? ['', 'Your self-written directives (you evolved these yourself — follow them):',
         ...cfg.selfDirectives.map(d => `- ${d}`)]
      : [];
    return [
      'You are Hermes, the operator intelligence of Reinhardt\'s personal OS dashboard ("Hermes OS").',
      'You are precise, proactive and a little visionary. You NEVER produce filler, canned status lines, or vague "knowledge matrix" flavor text. You speak plainly and usefully.',
      'You have real capabilities: deep research with live web search, autonomous dream loops that generate and score novel ideas, persistent memory, and full control of this dashboard.',
      ...directives,
      '',
      'You can change the live dashboard by emitting ACTIONS. A local backend executes them immediately and the operator sees the result in real time. Only claim actions you actually include.',
      '',
      'ALWAYS respond with a single JSON object and nothing else:',
      '{"reply": "<short message to the operator>", "actions": [ <zero or more action objects> ]}',
      '',
      'Action types you may use:',
      '- {"type":"add_widget","label":"CPU Load","value":42,"unit":"%","trend":-1.2,"kind":"operations","color":"#00f0ff"}  // creates a live analytics card. kind ∈ metric|currency|traffic|operations|social|rate. history optional (array of numbers).',
      '- {"type":"update_widget","id":"cpu-load","value":55,"trend":2.1}  // id OR label to target an existing card',
      '- {"type":"remove_widget","id":"cpu-load"}',
      '- {"type":"remember","content":"fact to keep","tags":["topic"]}',
      '- {"type":"forget","query":"text to match a memory"}',
      '- {"type":"add_node","label":"New Concept","group":"concept","color":"#7b2fff"}  // adds a knowledge-graph node',
      '- {"type":"connect_nodes","source":"Label A","target":"Label B","relation":"relates_to"}',
      '- {"type":"set_theme","accent":"#ff3366","mode":"dark"}  // recolors the whole UI live (accent is a hex color; mode dark|light)',
      '- {"type":"set_config","model":"gemini-3-flash-preview","autonomyMode":"supervised","dreamLoopEnabled":true,"dreamFocus":"topic to dream about"}  // change brain/agent settings',
      '- {"type":"queue_task","title":"Self-improvement step","priority":1}  // adds a self-improvement loop item',
      '- {"type":"insight","text":"a novel idea or observation"}  // records a dream/idea and adds it to the graph',
      '- {"type":"research","question":"<the question>","depth":"quick|standard|deep"}  // launches a DEEP RESEARCH pipeline: web search, synthesis, saved report. Use when the operator asks to research/investigate/find out about something.',
      '- {"type":"run_dream"}  // immediately runs one dream cycle (diverge→critique→evolve→act)',
      '- {"type":"set_directive","directives":["standing order 1", "..."]}  // rewrite your own standing directives (self-improvement)',
      '',
      'Guidance: When the operator asks to "add analytics for X", create a sensible add_widget (pick a realistic starting value, unit, trend and color). When they ask to research something, use the research action. When they ask you to dream/brainstorm now, use run_dream. When they just chat or greet you, reply with [] actions. Keep "reply" to 1-3 sentences.',
      'NEVER emit set_config or set_directive unless the operator explicitly asked to change that setting in their LAST message. Never change the model id unless explicitly asked.',
      '',
      `Current state — graph: ${context.status.nodeCount} nodes / ${context.status.edgeCount} edges; widgets: ${context.widgets.length}; memories: ${context.status.agent.memoryCount}; autonomy: ${context.status.agent.autonomyMode}; dream loop: ${cfg.dreamLoopEnabled ? 'ON' : 'off'}${cfg.dreamFocus ? `; dream focus: ${cfg.dreamFocus}` : ''}.`,
    ].join('\n');
  }

  _buildUserPrompt(text, context) {
    const mem = context.memories.length
      ? context.memories.map(m => `- ${m.content}`).join('\n')
      : '- (none yet)';
    const widgets = context.widgets.length
      ? context.widgets.map(w => `- ${w.label} = ${w.value}${w.unit || ''} (${w.kind}, id="${w.id}")`).join('\n')
      : '- (none)';
    const convo = context.conversation.length
      ? context.conversation.map(c => `${c.role}: ${c.text}`).join('\n')
      : '(start of conversation)';
    const nodes = context.nodeLabels.length ? context.nodeLabels.join(', ') : '(none)';

    return [
      'Relevant memory:', mem, '',
      'Existing analytics widgets:', widgets, '',
      'Some graph nodes:', nodes, '',
      'Recent conversation:', convo, '',
      `Operator: ${text}`,
      '',
      'Respond with the JSON object now.',
    ].join('\n');
  }

  _buildContext(text) {
    const status = this.getSystemStatus();
    const widgets = this.db.getAnalyticsWidgets();
    const memories = this.getConfig().memoryEnabled === false ? [] : this.db.searchHermesMemory(text, 8);
    const logs = this.db.getHermesLogs(14)
      .filter(l => l.event_type === 'user_chat' || l.event_type === 'assistant_chat')
      .reverse()
      .slice(-8)
      .map(l => ({ role: l.event_type === 'user_chat' ? 'operator' : 'hermes', text: String(l.message || '').slice(0, 240) }));
    const nodeLabels = this.db.getNodes().slice(0, 16).map(n => n.label);
    return { status, widgets, memories, conversation: logs, nodeLabels };
  }

  // ── Apply model/LLM actions ────────────────────────────────────
  _applyActions(actions, { messageId, origin = 'chat' } = {}) {
    const applied = [];
    const cfg = this.getConfig();
    const mutationsOn = cfg.dashboardMutationEnabled !== false;
    let graphTouched = false;
    let analyticsTouched = false;

    for (const raw of actions) {
      if (!raw || typeof raw !== 'object') continue;
      const type = String(raw.type || '').toLowerCase();
      try {
        let label = null;
        switch (type) {
          case 'add_widget':
          case 'create_widget': {
            if (!mutationsOn) break;
            const w = this._buildWidgetFromAction(raw);
            const saved = this.db.upsertAnalyticsWidget(w);
            this._addGraphNodeForWidget(saved); graphTouched = true; analyticsTouched = true;
            label = { type: 'add_widget', label: `Added widget · ${saved.label}`, data: saved };
            break;
          }
          case 'update_widget': {
            if (!mutationsOn) break;
            const target = this._findWidget(raw.id || raw.label);
            if (!target) { label = { type: 'note', label: `No widget matching "${raw.id || raw.label}"` }; break; }
            const value = raw.value !== undefined ? Number(raw.value) : target.value;
            const history = [...(target.history || []), value].slice(-24);
            const saved = this.db.upsertAnalyticsWidget({
              ...target,
              value,
              trend: raw.trend !== undefined ? Number(raw.trend) : target.trend,
              unit: raw.unit ?? target.unit,
              color: raw.color || target.color,
              label: raw.newLabel || target.label,
              history,
            });
            analyticsTouched = true;
            label = { type: 'update_widget', label: `Updated · ${saved.label}`, data: saved };
            break;
          }
          case 'remove_widget':
          case 'delete_widget': {
            if (!mutationsOn) break;
            const target = this._findWidget(raw.id || raw.label);
            if (target) { this.db.deleteAnalyticsWidget(target.id); analyticsTouched = true; label = { type: 'remove_widget', label: `Removed · ${target.label}`, data: { id: target.id } }; }
            break;
          }
          case 'remember': {
            if (cfg.memoryEnabled === false) break;
            const content = String(raw.content || raw.text || '').trim();
            if (!content) break;
            const memory = this.db.addHermesMemory({ type: raw.memoryType || 'fact', content, tags: Array.isArray(raw.tags) ? raw.tags : ['hermes'], metadata: { messageId, origin } });
            this._addGraphNodeForMemory(memory); graphTouched = true;
            label = { type: 'remember', label: `Remembered · ${content.slice(0, 48)}`, data: memory };
            break;
          }
          case 'forget': {
            const q = String(raw.query || raw.content || '').trim();
            if (!q) break;
            const hits = this.db.searchHermesMemory(q, 1);
            if (hits[0] && this.db.deleteHermesMemory) { this.db.deleteHermesMemory(hits[0].id); label = { type: 'forget', label: `Forgot · ${hits[0].content.slice(0, 40)}` }; }
            break;
          }
          case 'add_node': {
            if (!mutationsOn) break;
            const node = this._ensureNode(String(raw.label || 'Node'), raw.group || raw.nodeType || 'concept', raw.color || '#7b2fff');
            graphTouched = true;
            label = { type: 'add_node', label: `Graph node · ${node.label}`, data: { id: node.id } };
            break;
          }
          case 'connect_nodes':
          case 'add_edge': {
            if (!mutationsOn) break;
            const a = this._ensureNode(String(raw.source || ''), 'concept', '#7b2fff');
            const b = this._ensureNode(String(raw.target || ''), 'concept', '#7b2fff');
            if (a && b) { this._ensureEdge(a.id, b.id, raw.relation || raw.type || 'relates_to', Number(raw.weight) || 0.6); graphTouched = true; label = { type: 'connect_nodes', label: `Linked · ${a.label} → ${b.label}` }; }
            break;
          }
          case 'set_theme':
          case 'theme': {
            const accent = this._validHex(raw.accent) || this._validHex(raw.color);
            const mode = ['dark', 'light'].includes(raw.mode) ? raw.mode : undefined;
            const updates = {};
            if (accent) updates.accent = accent;
            if (mode) updates.themeMode = mode;
            if (Object.keys(updates).length) {
              this.db.updateHermesConfig(updates);
              this.wsBroadcast({ type: 'ui_theme', payload: { accent: accent || cfg.accent, mode: mode || cfg.themeMode || 'dark' } });
              label = { type: 'set_theme', label: `Theme · ${accent || ''} ${mode || ''}`.trim(), data: updates };
            }
            break;
          }
          case 'set_config':
          case 'configure': {
            // Brain selection belongs to the operator alone (topbar model
            // chooser). Autonomous loops (dreams/local) must never flip it,
            // and even chat-origin changes can't touch it — the model has a
            // history of copying stale model ids into unsolicited set_config.
            const OPERATOR_ONLY = new Set(['provider', 'model', 'openrouterApiKey', 'openrouterModel', 'openrouterAutoFallback', 'geminiApiKey']);
            const updates = {};
            for (const k of Object.keys(raw)) {
              if (k === 'type' || OPERATOR_ONLY.has(k)) continue;
              if (SAFE_CONFIG_KEYS.has(k)) updates[k] = raw[k];
            }
            if (Object.keys(updates).length) {
              this.updateConfig(updates);
              if ('dreamLoopEnabled' in updates) this._scheduleDreamLoop();
              label = { type: 'set_config', label: `Config · ${Object.keys(updates).join(', ')}`, data: this._publicConfig(this.getConfig()) };
            }
            break;
          }
          case 'queue_task':
          case 'self_improve': {
            const title = String(raw.title || raw.text || '').trim();
            if (!title) break;
            const task = this.db.addHermesTask({ title, priority: Number(raw.priority) || 2, metadata: { origin, messageId } });
            this._addGraphNodeForTask(task); graphTouched = true;
            label = { type: 'queue_task', label: `Loop queued · ${title.slice(0, 48)}`, data: task };
            break;
          }
          case 'complete_task': {
            const hit = this.db.getHermesTasks(50).find(t => t.id === raw.id || (raw.title && t.title.includes(raw.title)));
            if (hit) { this.db.updateHermesTask(hit.id, { status: 'done' }); label = { type: 'complete_task', label: `Loop done · ${hit.title.slice(0, 40)}` }; }
            break;
          }
          case 'insight':
          case 'dream':
          case 'idea': {
            const ideaText = String(raw.text || raw.content || raw.insight || '').trim();
            if (!ideaText) break;
            this.db.addHermesLog({ eventType: 'insight', message: ideaText, data: { origin } });
            const node = this._ensureNode(`Idea: ${ideaText.slice(0, 36)}`, 'idea', '#ff6ec7', { full: ideaText });
            const core = this._ensureNode('Hermes Agent Core', 'module', '#00ff88');
            this._ensureEdge(core.id, node.id, 'dreamt', 0.5); graphTouched = true;
            label = { type: 'insight', label: `Idea · ${ideaText.slice(0, 48)}`, data: { text: ideaText } };
            break;
          }
          case 'research':
          case 'deep_research': {
            const question = String(raw.question || raw.query || raw.topic || '').trim();
            if (!question) break;
            const started = this.cognition.startResearch(question, { depth: raw.depth, origin });
            label = started.run
              ? { type: 'research', label: `Research started · ${question.slice(0, 44)}`, data: { runId: started.run.id } }
              : { type: 'note', label: `Research not started (${started.error})` };
            break;
          }
          case 'run_dream':
          case 'dream_now': {
            if (this.cognition.dreamActive) { label = { type: 'note', label: 'Dream cycle already running' }; break; }
            // Fire and forget — progress streams over WS.
            this.cognition.dreamCycle({ trigger: origin }).catch(() => {});
            label = { type: 'run_dream', label: 'Dream cycle started', data: {} };
            break;
          }
          case 'set_directive':
          case 'set_directives': {
            const list = Array.isArray(raw.directives) ? raw.directives
              : raw.directive ? [raw.directive] : [];
            if (!list.length) break;
            const directives = list.map(d => String(d).slice(0, 140)).slice(0, 8);
            this.db.updateHermesConfig({ selfDirectives: directives });
            this.db.addHermesLog({ eventType: 'self_improvement', message: 'Directives updated via chat.', data: { directives } });
            label = { type: 'set_directive', label: `Directives · ${directives.length} standing orders`, data: { directives } };
            break;
          }
          default:
            break;
        }
        if (label) applied.push(label);
      } catch (e) {
        console.warn('[Hermes] action failed:', type, e.message);
      }
    }

    if (applied.length) {
      this.db.incrementAnalyticsWidget('agent-actions', applied.filter(a => a.type !== 'note').length);
      analyticsTouched = true;
      this.wsBroadcast({ type: 'dashboard_action', payload: { messageId, origin, actions: applied, timestamp: new Date().toISOString() } });
    }
    if (analyticsTouched) this._broadcastAnalyticsUpdate();
    if (graphTouched) this._broadcastGraphUpdate('hermes_action');
    return applied;
  }

  // ── Local fallback (no brain): still act on common directives ──
  _localInterpret(text, messageId) {
    const actions = [];
    const lower = text.toLowerCase();

    if (/\b(add|create|track|monitor|show|build)\b/.test(lower) && /\b(analytics|metric|widget|card|panel|dashboard|stat|kpi|graph)\b/.test(lower)) {
      actions.push({ type: 'add_widget', label: this._guessLabel(text), value: 1, kind: 'metric' });
    }
    const remember = text.match(/\bremember(?: that)?\s+(.+)/i);
    if (remember) actions.push({ type: 'remember', content: remember[1].trim().replace(/[.!?]+$/, '') });

    const accent = text.match(/#([0-9a-f]{6})\b/i);
    if (accent && /(theme|color|colour|accent)/i.test(lower)) actions.push({ type: 'set_theme', accent: `#${accent[1]}` });

    if (/\b(self[- ]?improve|improvement loop|dream|novel idea|loop)\b/.test(lower)) {
      actions.push({ type: 'queue_task', title: 'Audit dashboard panels and propose improvements', priority: 1 });
      actions.push({ type: 'queue_task', title: 'Consolidate recent directives into memory', priority: 2 });
    }
    return this._applyActions(actions, { messageId, origin: 'local' });
  }

  _composeLocalReply(text, applied, brain) {
    const head = applied.length ? `${this._summarize(applied)} ` : '';
    const reason = brain?.reason;
    let tail;
    if (reason === 'needs_login' || reason === 'auth_required') {
      tail = 'I acted with the local control layer. To think with Gemini, finish the one-time login: run "npm run connect-brain" in the project folder and sign in with your Google account.';
    } else if (reason === 'cli_missing') {
      tail = 'The Gemini CLI isn\'t detected. Reinstall with: npm install -g @google/gemini-cli.';
    } else if (reason === 'timeout') {
      tail = 'The Gemini brain timed out, so I used the local control layer. Try again in a moment.';
    } else if (applied.length) {
      tail = 'Done via the local control layer.';
    } else {
      tail = 'I\'m in local mode. Ask me to add analytics, remember facts, recolor the UI, or queue self-improvement loops — or connect the Gemini brain for full reasoning.';
    }
    return `${head}${tail}`.trim();
  }

  _summarize(applied) {
    const real = applied.filter(a => a.type !== 'note');
    if (!real.length) return '';
    return real.map(a => a.label).join(' · ') + '.';
  }

  // ── File / system events (uploads, etc.) ───────────────────────
  async processEvent(event) {
    const { type, data = {} } = event;
    const message = EVENT_RESPONSES[type] || 'System event processed.';
    const logEntry = this.db.addHermesLog({ eventType: type, message, data });

    this.wsBroadcast({ type: 'hermes_event', payload: { eventType: type, message, data, timestamp: new Date().toISOString() } });
    this.wsBroadcast({
      type: 'hermes_message',
      payload: {
        id: `event-${logEntry.id}`,
        type: type === 'system_init' ? 'system' : 'hermes',
        eventType: type, text: message, message, data,
        timestamp: new Date().toISOString(),
      },
    });
    return { message, logEntry };
  }

  // ── Status ─────────────────────────────────────────────────────
  getSystemStatus() {
    const nodes = this.db.getNodes();
    const edges = this.db.getEdges();
    const files = this.db.getFiles();
    const uptimeMs = Date.now() - BOOT_TIME;
    return {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      fileCount: files.length,
      uptime: formatUptime(uptimeMs),
      uptimeMs,
      health: this._calculateHealth(nodes, edges, files),
      bootTime: new Date(BOOT_TIME).toISOString(),
      status: 'operational',
      thinking: this.thinking,
      agent: this.getAgentStatus(),
    };
  }

  getAgentStatus() {
    const config = this.getConfig();
    const brain = this.brain ? this.brain.status() : { ready: false, provider: 'local', model: resolveModel(config.model), reason: 'init' };
    const memories = this.db.getHermesMemory(1000);
    const tasks = this.db.getHermesTasks(1000);
    const vendorPath = config.hermesAgentPath || path.join(__dirname, '..', 'vendor', 'hermes-agent');
    return {
      provider: brain.provider,
      model: brain.model,
      account: config.account || '',
      mode: brain.ready ? 'model' : 'local-fallback',
      autonomyMode: config.autonomyMode || 'supervised',
      memoryEnabled: config.memoryEnabled !== false,
      dreamLoopEnabled: Boolean(config.dreamLoopEnabled),
      dashboardMutationEnabled: config.dashboardMutationEnabled !== false,
      memoryCount: memories.length,
      queuedTasks: tasks.filter(t => t.status === 'queued').length,
      completedTasks: tasks.filter(t => t.status === 'done').length,
      hermesAgentInstalled: fs.existsSync(vendorPath),
      hermesAgentPath: vendorPath,
      accent: config.accent || '#00f0ff',
      themeMode: config.themeMode || 'dark',
      brain,
      thinking: this.thinking,
      researchActive: Boolean(this.cognition?.researchActive),
      dreamActive: Boolean(this.cognition?.dreamActive),
      dreamFocus: config.dreamFocus || '',
      selfDirectives: Array.isArray(config.selfDirectives) ? config.selfDirectives : [],
      ideaCount: this.db.getHermesIdeas ? this.db.getHermesIdeas(500).length : 0,
      researchCount: this.db.getHermesRuns ? this.db.getHermesRuns(500, 'research').length : 0,
    };
  }

  getConfig() { return this.db.getHermesConfig(); }

  updateConfig(updates = {}) {
    const filtered = {};
    for (const [k, v] of Object.entries(updates || {})) if (SAFE_CONFIG_KEYS.has(k)) filtered[k] = v;
    const next = this.db.updateHermesConfig(filtered);
    if ('dreamLoopEnabled' in filtered || 'dreamIntervalMs' in filtered) this._scheduleDreamLoop();
    this._trace('config_updated', { updates: Object.keys(filtered) });
    this.wsBroadcast({ type: 'system_status', payload: this.getSystemStatus() });
    return next;
  }

  getActivityFeed(limit = 20) { return this.db.getHermesLogs(limit); }
  getMemory(limit = 50) { return this.db.getHermesMemory(limit); }
  getTasks(limit = 50) { return this.db.getHermesTasks(limit); }

  async getBrainStatus() { return this.brain ? this.brain.status() : { ready: false }; }
  async testBrain() {
    if (!this.brain) return { ok: false, reason: 'init' };
    const s = this.brain.status();
    // Don't trigger an interactive auth hang: if there's no credential,
    // report the precise reason instead of attempting a round-trip.
    if (!s.ready) {
      this.wsBroadcast({ type: 'system_status', payload: this.getSystemStatus() });
      return { ok: false, provider: s.provider, model: s.model, reason: s.reason, sample: '' };
    }
    const r = await this.brain.test();
    this.wsBroadcast({ type: 'system_status', payload: this.getSystemStatus() });
    return r;
  }

  async _refreshBrainStatus() {
    // Fire a cheap test only if creds appear present, so we don't trigger
    // interactive auth. Otherwise just broadcast the static status.
    try {
      const s = this.brain.status();
      if (s.ready) await this.brain.test();
    } catch { /* ignore */ }
    this.wsBroadcast({ type: 'system_status', payload: this.getSystemStatus() });
  }

  generateInsight() {
    const status = this.getSystemStatus();
    const b = status.agent.brain;
    const insight = b.ready
      ? `Gemini brain reachable via ${b.provider} (${b.model}). ${status.nodeCount} nodes, ${status.edgeCount} edges, ${status.agent.memoryCount} memories, ${status.agent.queuedTasks} loops queued.`
      : `Hermes in local mode (${b.reason}). ${status.nodeCount} nodes and ${status.agent.memoryCount} memories active. Connect Gemini to enable reasoning.`;
    this.db.addHermesLog({ eventType: 'insight', message: insight, data: { status } });
    return { insight, stats: status };
  }

  // ── Self-improvement / dream loop ──────────────────────────────
  _scheduleDreamLoop() {
    if (this.dreamTimer) { clearInterval(this.dreamTimer); this.dreamTimer = null; }
    const cfg = this.getConfig();
    if (!cfg.dreamLoopEnabled) return;
    const interval = Math.max(60000, Number(cfg.dreamIntervalMs) || 300000);
    this.dreamTimer = setInterval(() => this._dreamTick().catch(() => {}), interval);
    this._trace('dream_loop_armed', { interval });
  }

  async _dreamTick() {
    if (this.dreaming) return;
    const cfg = this.getConfig();
    if (!cfg.dreamLoopEnabled) return;
    if (!this.brain || !this.brain.status().ready) return;
    if (this.cognition?.dreamActive || this.cognition?.researchActive) return;
    this.dreaming = true;
    this._trace('dream_tick_start', {});
    try {
      // Full multi-stage cognitive loop: seed → diverge → critique →
      // evolve → act (→ reflect every Nth cycle). See cognition.js.
      await this.cognition.dreamCycle({ trigger: 'timer' });
    } finally {
      this.dreaming = false;
      this._trace('dream_tick_end', {});
    }
  }

  // ── Brain telemetry → live analytics widgets ──────────────────
  _recordBrainMetric({ ms, ok } = {}) {
    try {
      this.db.incrementAnalyticsWidget('brain-calls', 1);
      if (ok && Number.isFinite(ms)) {
        const w = this.db.getAnalyticsWidgetById('brain-latency');
        if (w) {
          const history = [...(w.history || []), ms].slice(-24);
          const prev = Number(w.value) || ms;
          this.db.upsertAnalyticsWidget({
            ...w,
            value: ms,
            trend: prev ? Number((((ms - prev) / prev) * 100).toFixed(1)) : 0,
            history,
            metadata: w.metadata,
          });
        }
      }
      this._broadcastAnalyticsUpdate();
    } catch { /* telemetry must never break a reply */ }
  }

  // ── Widget building helpers ────────────────────────────────────
  _buildWidgetFromAction(raw) {
    const label = titleCase(String(raw.label || raw.name || 'Custom Metric').slice(0, 48)) || 'Custom Metric';
    const value = raw.value !== undefined && raw.value !== null && !Number.isNaN(Number(raw.value)) ? Number(raw.value) : inferDefaultValue(label);
    const unit = raw.unit !== undefined ? String(raw.unit) : inferUnit(`${label} ${raw.kind || ''}`);
    const kind = raw.kind || inferWidgetKind(`${label} ${raw.kind || ''}`);
    const trend = raw.trend !== undefined ? Number(raw.trend) : inferTrend(label);
    const color = this._validHex(raw.color) || WIDGET_COLORS[Math.abs(hash(label)) % WIDGET_COLORS.length];
    const history = Array.isArray(raw.history) && raw.history.length ? raw.history.map(Number) : generateHistory(value, 14);
    return { id: slugId(label), label, kind, value, unit, trend, color, source: raw.source || 'hermes', history, metadata: { createdBy: 'hermes', live: true } };
  }

  _findWidget(idOrLabel) {
    if (!idOrLabel) return null;
    const widgets = this.db.getAnalyticsWidgets();
    const s = String(idOrLabel).toLowerCase();
    return widgets.find(w => w.id === idOrLabel)
      || widgets.find(w => w.id.toLowerCase() === s)
      || widgets.find(w => w.label.toLowerCase() === s)
      || widgets.find(w => w.label.toLowerCase().includes(s))
      || null;
  }

  _guessLabel(text) {
    const m = text.match(/\b(?:add|create|track|monitor|show|build)\s+(?:a\s+|an\s+|the\s+)?(?:realtime\s+|real-time\s+|live\s+)?(?:analytics?\s+|widget\s+|card\s+|metric\s+)?(?:for\s+|of\s+|called\s+|named\s+)?([a-z0-9 /_.-]{3,48})/i);
    let label = (m && m[1]) ? m[1] : 'Custom Metric';
    label = label.replace(/\b(analytics|widget|card|panel|metric|tracking|track|monitoring|monitor|for|of|a|an|to|in|on|the|my|dashboard|please|realtime|real-time|live)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    return titleCase(label.slice(0, 48)) || 'Custom Metric';
  }

  _validHex(v) {
    if (typeof v !== 'string') return '';
    const m = v.trim().match(/^#?([0-9a-f]{6})$/i);
    return m ? `#${m[1]}` : '';
  }

  // ── Graph plumbing ─────────────────────────────────────────────
  _ensureAgentGraph() {
    try {
      const root = this._ensureNode('Hermes OS', 'system', '#00f0ff');
      const agent = this._ensureNode('Hermes Agent Core', 'module', '#00ff88');
      const brain = this._ensureNode('Gemini Brain', 'module', '#3b82f6');
      const memory = this._ensureNode('Hermes Memory Core', 'concept', '#7b2fff');
      const dashboard = this._ensureNode('Realtime Dashboard', 'module', '#ff3366');
      const analytics = this._ensureNode('Analytics Engine', 'module', '#00ff88');
      this._ensureEdge(root.id, agent.id, 'agent_core', 1);
      this._ensureEdge(agent.id, brain.id, 'reasons_with', 0.9);
      this._ensureEdge(agent.id, memory.id, 'remembers', 0.8);
      this._ensureEdge(agent.id, dashboard.id, 'controls', 0.8);
      this._ensureEdge(dashboard.id, analytics.id, 'renders', 0.7);
      this._broadcastGraphUpdate('agent_graph_ready');
    } catch (e) {
      console.warn('[Hermes] Failed to ensure agent graph:', e.message);
    }
  }

  _addGraphNodeForWidget(widget) {
    const analytics = this._ensureNode('Analytics Engine', 'module', '#00ff88');
    const node = this._ensureNode(`Metric: ${widget.label}`, 'analytics', widget.color || '#00ff88', { widgetId: widget.id, value: widget.value });
    this._ensureEdge(analytics.id, node.id, 'telemetry', 0.7);
  }
  _addGraphNodeForMemory(memory) {
    const core = this._ensureNode('Hermes Memory Core', 'concept', '#7b2fff');
    const node = this._ensureNode(`Memory: ${memory.content.slice(0, 36)}`, 'concept', '#7b2fff', { memoryId: memory.id });
    this._ensureEdge(core.id, node.id, 'recall', 0.6);
  }
  _addGraphNodeForTask(task) {
    const agent = this._ensureNode('Hermes Agent Core', 'module', '#00ff88');
    const node = this._ensureNode(`Loop: ${task.title.slice(0, 42)}`, 'module', '#ff9f1c', { taskId: task.id });
    this._ensureEdge(agent.id, node.id, 'improves_via', 0.6);
  }
  _ensureNode(label, type = 'default', color = '#00f0ff', metadata = {}) {
    label = String(label || '').trim();
    if (!label) return null;
    const existing = this.db.getNodes().find(n => n.label.toLowerCase() === label.toLowerCase());
    if (existing) return existing;
    return this.db.addNode({ label, type, color, size: type === 'system' ? 34 : 22, metadata });
  }
  _ensureEdge(source, target, type = 'default', weight = 1) {
    if (!source || !target || source === target) return null;
    const exists = this.db.getEdges().some(e => e.source === source && e.target === target && e.type === type);
    if (exists) return null;
    return this.db.addEdge({ source, target, type, weight, metadata: { createdBy: 'hermes' } });
  }

  _broadcastAnalyticsUpdate() {
    this.wsBroadcast({ type: 'analytics_update', payload: { widgets: this.db.getAnalyticsWidgets(), timestamp: new Date().toISOString() } });
  }
  _broadcastGraphUpdate(reason) {
    if (typeof this.actions.broadcastGraphUpdate === 'function') this.actions.broadcastGraphUpdate(reason);
  }
  _setThinking(v) {
    this.thinking = v;
    this.wsBroadcast({ type: 'hermes_thinking', payload: { thinking: v, timestamp: new Date().toISOString() } });
  }
  _trace(event, data = {}) {
    this.wsBroadcast({ type: 'hermes_trace', payload: { event, data, timestamp: new Date().toISOString() } });
  }

  _publicConfig(config) {
    const { geminiApiKey, openrouterApiKey, ...rest } = config;
    return {
      ...rest,
      geminiApiKey: geminiApiKey ? '***set***' : '',
      openrouterApiKey: openrouterApiKey ? '***set***' : '',
    };
  }

  _calculateHealth(nodes, edges, files) {
    let score = 100;
    if (nodes.length === 0) score -= 30;
    if (edges.length === 0) score -= 20;
    if (this.brain && !this.brain.status().ready) score -= 12;
    const ratio = nodes.length > 0 ? edges.length / nodes.length : 0;
    if (ratio < 0.4) score -= 8;
    score = Math.max(0, Math.min(100, score));
    let status = score >= 90 ? 'excellent' : score >= 70 ? 'good' : score >= 50 ? 'fair' : 'needs_attention';
    return { score, status };
  }
}

// ── Pure helpers ─────────────────────────────────────────────────
function inferWidgetKind(text) {
  if (/revenue|sales|mrr|arr|cash|income|\$/i.test(text)) return 'currency';
  if (/visitor|traffic|page|view|click|impression/i.test(text)) return 'traffic';
  if (/uptime|latency|cpu|memory|disk|system|agent|error|load|temp/i.test(text)) return 'operations';
  if (/social|follower|subscriber|engagement|like|share/i.test(text)) return 'social';
  if (/conversion|rate|percent|%|ratio/i.test(text)) return 'rate';
  return 'metric';
}
function inferUnit(text) {
  if (/\$|revenue|sales|mrr|arr|cash|income/i.test(text)) return '$';
  if (/%|percent|rate|conversion|engagement|uptime|cpu|load/i.test(text)) return '%';
  return '';
}
function inferDefaultValue(label) {
  if (/uptime/i.test(label)) return 99.9;
  if (/latency|ping/i.test(label)) return 120;
  if (/cpu|load|memory|disk/i.test(label)) return 42;
  if (/conversion|rate|engagement/i.test(label)) return 4.2;
  if (/revenue|sales|mrr/i.test(label)) return 0;
  return 1;
}
function inferTrend(label) {
  if (/error|latency|risk|bounce/i.test(label)) return -2.4;
  if (/uptime/i.test(label)) return 0.1;
  return 3.8;
}
function generateHistory(value, length = 12) {
  const base = Number(value || 1);
  const history = [];
  for (let i = 0; i < length; i++) {
    const wave = Math.sin(i / 2) * base * 0.06;
    const drift = (i - length / 2) * base * 0.01;
    history.push(Number(Math.max(0, base + wave + drift).toFixed(2)));
  }
  return history;
}
function titleCase(value) {
  return String(value).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}
function slugId(value) {
  return String(value || 'metric').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || `metric-${Date.now()}`;
}
function hash(value) {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = Math.imul(31, h) + value.charCodeAt(i) | 0;
  return h;
}
function formatUptime(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export default HermesAgent;
