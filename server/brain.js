// ─────────────────────────────────────────────────────────────
// Hermes OS — Brain
// Provider-agnostic LLM access. Primary: Google Gemini CLI
// (free, personal-account OAuth). Fallback: Gemini REST API key.
// Designed to NEVER hang the backend and to report auth state clearly.
// ─────────────────────────────────────────────────────────────

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = os.homedir();
const GEMINI_HOME = path.join(HOME, '.gemini');
const WORKDIR = path.join(__dirname, '.brain-workdir');

// Newest flash verified working on this account (2026-06-09):
// gemini-3-flash-preview ✓, gemini-3-pro-preview ✓, gemini-2.5-flash ✓.
// "gemini-3.5-flash" does NOT exist (404) — we map it to the newest flash.
export const DEFAULT_MODEL = 'gemini-3-flash-preview';

const MODEL_ALIASES = {
  'gemini-3.5-flash': DEFAULT_MODEL,
  'gemini-flash-3.5': DEFAULT_MODEL,
  '3.5-flash': DEFAULT_MODEL,
  'gemini-flash': DEFAULT_MODEL,
  'flash': DEFAULT_MODEL,
  'gemini-3-flash': DEFAULT_MODEL,
  'gemini-pro': 'gemini-3-pro-preview',
  'gemini-3-pro': 'gemini-3-pro-preview',
  'pro': 'gemini-3-pro-preview',
  // "Best available" = strongest Gemini first; the fallback ladder
  // drops to flash automatically when pro quota is exhausted.
  'gemini-best': 'gemini-3-pro-preview',
  'best': 'gemini-3-pro-preview',
};

// If a model id is rejected by the API, walk down this ladder.
const FALLBACK_LADDER = [DEFAULT_MODEL, 'gemini-2.5-flash', 'gemini-2.5-pro'];

const AUTH_ERROR_RE = /(set an auth method|GEMINI_API_KEY|GOOGLE_GENAI_USE|not authenticated|please (log ?in|sign ?in)|oauth.*(required|expired)|credentials? (not|missing|expired)|reauthenticate)/i;
const MODEL_ERROR_RE = /(\b404\b|NOT_FOUND|model.{0,40}not (found|exist|available)|unknown model|invalid model)/i;
// Usage-limit exhaustion (CLI prints 429 / quota text; API returns 429 /
// RESOURCE_EXHAUSTED). Long-running loops use this to pause-and-resume.
const QUOTA_ERROR_RE = /(\b429\b|RESOURCE_EXHAUSTED|too many requests|rate.?limit|quota)/i;

// After agy reports quota exhaustion, skip it for this long so the council
// rides whatever provider still has capacity instead of wasting ~5s/call on
// a dead one. Short enough to re-probe and pick the subscription back up soon.
const AGY_COOLDOWN_MS = 15 * 60 * 1000;

// agy writes operational errors to its log file as glog lines
// ("E0614 18:48:19.799104 ... RESOURCE_EXHAUSTED (code 429): Individual quota
// reached ... Resets in 99h6m27s"). Pull the most informative one out so the
// quota reset window reaches the operator instead of a blank "empty output".
function extractAgyError(text = '') {
  const lines = String(text || '').split(/\r?\n/);
  const hit = lines.find(l => /RESOURCE_EXHAUSTED|Individual quota|Resets in|quota reached/i.test(l))
    || lines.find(l => /not logged into|token source|unauthenticated|permission/i.test(l))
    || lines.find(l => /\berror\b/i.test(l));
  return (hit || '').replace(/^[IWEF]\d{4}\s[\d:.]+\s+\d+\s+\S+\]\s*/, '').trim().slice(0, 300);
}

// The CLI prints harness chatter on stdout in some versions; strip it so
// replies stay clean and JSON extraction is reliable.
const NOISE_LINE_RE = /^(Loaded cached credentials\.?|Ripgrep is not available.*|Skill conflict detected:.*|Falling back to GrepTool.*|Hook .*registered.*|\[?(INFO|DEBUG|WARN)\]?\s.*|Data collection is .*|To get started.*|Tips for getting started.*|[IWEF]\d{4} .*)$/i;

// ── Antigravity CLI (`agy`) ──────────────────────────────────
// Google's successor to the Gemini CLI (Gemini CLI stops serving
// Google One / unpaid tiers on 2026-06-18). It runs on the user's
// Google sign-in (system keyring), honors Google AI Pro/Ultra
// subscription limits, and serves newer models. We use it as the
// PRIMARY provider for plain completions; web-search-grounded calls
// stay on the Gemini CLI while it lasts (agy's web tools are
// agentic and can block on permission prompts in print mode).
function resolveAgyBin() {
  const candidates = [
    process.env.HERMES_AGY_BIN,
    path.join(HOME, '.local', 'bin', 'agy'),
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
  ];
  for (const candidate of candidates) {
    try { if (candidate && fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return '';
}

// agy takes display names, not API model ids. Walk strongest-first;
// each entry has its own quota bucket under the subscription.
function agyLadderFor(requestedModel) {
  const wantsPro = /pro/i.test(String(requestedModel || ''));
  return wantsPro
    ? ['Gemini 3.1 Pro (Low)', 'Gemini 3.5 Flash (Medium)', 'Gemini 3.5 Flash (Low)']
    : ['Gemini 3.5 Flash (Medium)', 'Gemini 3.5 Flash (Low)', 'Gemini 3.1 Pro (Low)'];
}

// ── OpenRouter ───────────────────────────────────────────────
// Second brain provider, selected with config.provider = 'openrouter'.
// Free-tier models (":free") cost nothing; on per-model rate limits we
// walk to the next best free model, and if OpenRouter is fully out the
// complete() chain falls back to the Gemini providers below.
const OPENROUTER_API = 'https://openrouter.ai/api/v1';
export const OPENROUTER_DEFAULT_MODEL = 'nex-agi/nex-n2-pro:free';

// Selecting this sentinel as the OpenRouter model means "always ride the
// strongest free model currently being served" (quality-ranked below).
export const OPENROUTER_AUTO_MODEL = 'auto';

// Strongest-first preference order for free models. Anything in this
// list that the live /models endpoint no longer serves is skipped, and
// newer free models we don't know about yet are appended dynamically.
const OPENROUTER_PREFERRED_FREE = [
  OPENROUTER_DEFAULT_MODEL,
  'deepseek/deepseek-chat-v3.1:free',
  'deepseek/deepseek-r1-0528:free',
  'qwen/qwen3-235b-a22b:free',
  'moonshotai/kimi-k2:free',
  'z-ai/glm-4.5-air:free',
  'openai/gpt-oss-120b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'mistralai/mistral-small-3.2-24b-instruct:free',
];

// Quality prior for ranking the LIVE free list in "auto" mode. Higher =
// stronger reasoning. Families we don't recognize fall back to recency.
const OPENROUTER_QUALITY = [
  [/deepseek-r1/i, 95],
  [/deepseek-(chat-)?v3/i, 92],
  [/qwen3-(235|480)b/i, 91],
  [/kimi-k2/i, 90],
  [/nex-n2/i, 88],
  [/glm-4\.[5-9]/i, 86],
  [/gpt-oss-120b/i, 85],
  [/qwen3-(30|32)b/i, 78],
  [/llama-3\.3-70b/i, 75],
  [/mistral-small/i, 70],
  [/gemma-3-27b/i, 68],
];

function qualityScore(id) {
  for (const [re, score] of OPENROUTER_QUALITY) if (re.test(id)) return score;
  return 0;
}

/** Rank free model ids best-first: known-quality prior, then recency
 *  (the input list arrives newest-first from fetchOpenRouterFreeModels). */
function rankFreeModels(ids) {
  return [...ids].sort((a, b) => qualityScore(b) - qualityScore(a));
}

let _orFreeCache = { at: 0, ids: [] };

/** Live list of free OpenRouter model ids, newest first. Cached 1h. */
async function fetchOpenRouterFreeModels() {
  if (Date.now() - _orFreeCache.at < 3600000 && _orFreeCache.ids.length) {
    return _orFreeCache.ids;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(`${OPENROUTER_API}/models`, { signal: controller.signal });
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    const ids = (data?.data || [])
      .filter(m => String(m?.id || '').endsWith(':free'))
      // Skip guard/safety classifiers and tiny edge models — they can't
      // do council-grade reasoning even though they're free.
      .filter(m => !/safety|guard|moderation|-(0\.5|1|1\.2|2)b\b/i.test(String(m?.id || '')))
      .sort((a, b) => (b?.created || 0) - (a?.created || 0))
      .map(m => m.id);
    if (ids.length) _orFreeCache = { at: Date.now(), ids };
    return ids;
  } catch {
    return _orFreeCache.ids;
  }
}

function stripCliNoise(text) {
  return String(text || '')
    .split('\n')
    .filter(line => !NOISE_LINE_RE.test(line.trim()))
    .join('\n')
    .trim();
}

export function resolveModel(model) {
  const key = String(model || '').trim().toLowerCase();
  return MODEL_ALIASES[key] || model || DEFAULT_MODEL;
}

// Find a Node.js binary >= 18 so the gemini CLI shebang (`env node`)
// doesn't resolve to an ancient default node on this machine.
function findGoodNodeDir() {
  const candidates = [];
  // The node running THIS backend, if modern enough.
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) candidates.push(path.dirname(process.execPath));
  candidates.push('/opt/homebrew/bin', '/usr/local/bin');
  // nvm installs
  try {
    const nvmDir = path.join(HOME, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmDir)) {
      for (const v of fs.readdirSync(nvmDir).sort().reverse()) {
        const m = Number(String(v).replace(/^v/, '').split('.')[0]);
        if (m >= 18) candidates.push(path.join(nvmDir, v, 'bin'));
      }
    }
  } catch { /* ignore */ }

  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'node'))) return dir;
    } catch { /* ignore */ }
  }
  return path.dirname(process.execPath);
}

function resolveGeminiBin(configuredPath) {
  const explicit = configuredPath || process.env.HERMES_GEMINI_BIN;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const goodDir = findGoodNodeDir();
  const dirs = [
    goodDir,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...String(process.env.PATH || '').split(path.delimiter),
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, 'gemini');
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  return '';
}

function hasOAuthCreds() {
  // gemini-cli stores personal-account creds here after `Login with Google`.
  const files = ['oauth_creds.json', 'google_accounts.json'];
  return files.some(f => {
    try { return fs.existsSync(path.join(GEMINI_HOME, f)); } catch { return false; }
  });
}

function runProcess({ command, args = [], input = '', cwd, timeoutMs = 90000, env = {} }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message || error), spawnError: true });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      done({ code: -1, stdout, stderr, timedOut: true });
    }, timeoutMs);

    child.stdout.on('data', c => { stdout += c.toString(); });
    child.stderr.on('data', c => { stderr += c.toString(); });
    child.on('error', e => done({ code: -1, stdout, stderr: stderr + String(e?.message || e), spawnError: true }));
    child.on('close', code => done({ code, stdout, stderr }));

    if (input) { try { child.stdin.write(input); } catch { /* ignore */ } }
    try { child.stdin.end(); } catch { /* ignore */ }
  });
}

export class Brain {
  constructor(getConfig) {
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({});
    this._lastAuthOk = false;
    this._lastCheck = 0;
    this._lastReason = 'unknown';
    this._inflight = { gemini: 0, openrouter: 0 }; // live per-lane load (hybrid dispatch)
    // Optional hook: ({ provider, model, ms, ok, webSearch }) => void
    this.onMetric = null;
    try { fs.mkdirSync(WORKDIR, { recursive: true }); } catch { /* ignore */ }
  }

  config() { return this.getConfig() || {}; }

  apiKey() {
    const cfg = this.config();
    return cfg.geminiApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  }

  openrouterKey() {
    const cfg = this.config();
    return cfg.openrouterApiKey || process.env.OPENROUTER_API_KEY || '';
  }

  /** True when the operator has selected OpenRouter as the brain. */
  usesOpenRouter() {
    return String(this.config().provider || '').toLowerCase() === 'openrouter' && Boolean(this.openrouterKey());
  }

  /**
   * True when the operator selected the HYBRID brain: Gemini and
   * OpenRouter working as parallel lanes. Callers can pin a call to a
   * lane ({lane:'gemini'|'openrouter'}); unpinned calls go to the
   * least-busy lane. Twice the rate-limit headroom, real parallelism.
   */
  usesHybrid() {
    const cfg = this.config();
    if (String(cfg.provider || '').toLowerCase() !== 'hybrid') return false;
    if (!this.openrouterKey()) return false;
    const geminiReady = Boolean(resolveAgyBin() || this.apiKey()
      || (resolveGeminiBin(cfg.geminiCliPath) && hasOAuthCreds()));
    return geminiReady;
  }

  /** Lightweight, synchronous-ish status. Does NOT call the model. */
  status() {
    const cfg = this.config();
    const bin = resolveGeminiBin(cfg.geminiCliPath);
    const agyBin = resolveAgyBin();
    const key = this.apiKey();
    const oauth = hasOAuthCreds();
    const orKey = this.openrouterKey();
    const onOpenRouter = this.usesOpenRouter();
    const onHybrid = this.usesHybrid();
    const orModelLabel = String(cfg.openrouterModel || '').toLowerCase() === OPENROUTER_AUTO_MODEL
      ? 'auto (best free)'
      : (cfg.openrouterModel || OPENROUTER_DEFAULT_MODEL);
    let provider = 'local';
    if (onHybrid) provider = 'hybrid';
    else if (onOpenRouter) provider = 'openrouter';
    else if (agyBin) provider = 'antigravity-cli';
    else if (bin && oauth) provider = 'gemini-cli';
    else if (key) provider = 'gemini-api';

    const ready = Boolean(agyBin || key || (bin && oauth) || orKey);
    return {
      provider,
      openrouterKeyPresent: Boolean(orKey),
      openrouterModel: onOpenRouter ? orModelLabel : (cfg.openrouterModel || ''),
      openrouterAutoFallback: cfg.openrouterAutoFallback !== false,
      agyInstalled: Boolean(agyBin),
      agyPath: agyBin,
      model: onHybrid
        ? `${resolveModel(cfg.model)} + ${orModelLabel}`
        : onOpenRouter ? orModelLabel : resolveModel(cfg.model),
      requestedModel: onOpenRouter ? orModelLabel : (cfg.model || DEFAULT_MODEL),
      lanesInflight: { ...this._inflight },
      account: cfg.account || '',
      cliInstalled: Boolean(bin),
      cliPath: bin,
      oauthReady: oauth,
      apiKeyPresent: Boolean(key),
      ready,
      nodeForCli: path.join(findGoodNodeDir(), 'node'),
      reason: ready ? 'ready' : (bin ? 'needs_login' : 'cli_missing'),
      lastRoundTripOk: this._lastAuthOk,
      lastReason: this._lastReason,
    };
  }

  /**
   * Complete a prompt. Returns { ok, text, provider, model, reason, ms }.
   * Options: { system, prompt, timeoutMs, model (override), webSearch }.
   * webSearch:true lets the CLI use Google Search + web fetch grounding —
   * this is what powers deep research with live data.
   */
  async complete({ system = '', prompt = '', timeoutMs, model: modelOverride, webSearch = false, lane = '' } = {}) {
    const cfg = this.config();
    const requested = resolveModel(modelOverride || cfg.model);
    const full = system ? `${system}\n\n${prompt}` : prompt;
    const started = Date.now();

    // Hybrid: resolve which lane this call rides. Pinned lanes are
    // honored; everything else goes to the lane with less in-flight work.
    const hybrid = this.usesHybrid();
    let laneSel = '';
    if (hybrid) {
      laneSel = lane === 'gemini' || lane === 'openrouter'
        ? lane
        : (this._inflight.openrouter <= this._inflight.gemini ? 'openrouter' : 'gemini');
    } else if (this.usesOpenRouter()) {
      laneSel = 'openrouter';
    } else {
      laneSel = 'gemini';
    }
    this._inflight[laneSel] = (this._inflight[laneSel] || 0) + 1;

    const finish = (r) => {
      r.ms = Date.now() - started;
      r.lane = laneSel;
      this._inflight[laneSel] = Math.max(0, (this._inflight[laneSel] || 1) - 1);
      try { this.onMetric?.({ provider: r.provider, model: r.model, ms: r.ms, ok: r.ok, webSearch }); } catch { /* ignore */ }
      return r;
    };

    // Build the model ladder: requested first, then fallbacks (deduped).
    const ladder = [requested, ...FALLBACK_LADDER.filter(m => m !== requested)];

    // OpenRouter is the cross-provider safety net. We try it FIRST when it's
    // the elected lane, and as a LAST RESORT from the Gemini lane — so a call
    // never fails with "quota_exhausted" while OpenRouter still has capacity.
    const hasOR = Boolean(this.openrouterKey());
    let triedOR = false;
    let last = null;
    const runOpenRouter = async () => {
      triedOR = true;
      const or = await this._completeOpenRouterLadder({ system, prompt, timeoutMs, webSearch });
      if (!or.ok) { last = or; this._lastReason = or.reason || 'openrouter_error'; }
      return or;
    };

    // Provider -1: OpenRouter — when selected outright, or when this is
    // the hybrid OpenRouter lane. Walks the free-model ladder on rate
    // limits; if OpenRouter is fully exhausted we fall through to the
    // Gemini chain so work never stalls.
    if (this.usesOpenRouter() || (hybrid && laneSel === 'openrouter')) {
      const or = await runOpenRouter();
      if (or.ok) { this._mark(true, 'ready'); return finish(or); }
    }

    // Provider 0: Antigravity CLI — the subscription-backed primary for
    // plain completions (webSearch stays on the Gemini CLI's grounded tools).
    // When its quota is spent, agy reports the 429 only to its log file and
    // exits with empty stdout; _completeAgy now folds that log in so it's
    // classified as quota_exhausted instead of empty_output. A quota hit arms
    // a short cooldown so we don't burn ~5s/call probing a dead provider for
    // hours — we ride whatever lane still has capacity and re-probe agy later.
    // Disable entirely with HERMES_USE_AGY=0.
    const agyBin = process.env.HERMES_USE_AGY === '0' ? '' : resolveAgyBin();
    const agyCooling = (this._agyCooldownUntil || 0) > Date.now();
    if (agyBin && !webSearch && !agyCooling) {
      const agy = await this._completeAgyLadder({ requested, prompt: full, timeoutMs });
      if (agy.ok) { this._mark(true, 'ready'); return finish(agy); }
      last = agy;
      this._lastReason = agy.reason || 'agy_error';
      if (agy.reason === 'quota_exhausted') this._agyCooldownUntil = Date.now() + AGY_COOLDOWN_MS;
      // Fall through to the Gemini CLI / API key / OpenRouter paths.
    }

    // Provider 1: Gemini CLI (free, personal OAuth) — the chosen path.
    // IMPORTANT: only invoke the CLI once OAuth creds exist. Calling it
    // before login (with GCA forced) makes it try an interactive browser
    // flow and hang. Gating here keeps local fallback instant.
    const bin = resolveGeminiBin(cfg.geminiCliPath);
    if (bin && hasOAuthCreds()) {
      for (const model of ladder) {
        const cli = await this._completeCli({ model, prompt: full, timeoutMs, webSearch });
        if (cli.ok) { this._mark(true, 'ready'); return finish(cli); }
        last = cli;
        // Walk the ladder for bad-model errors AND per-model quota exhaustion
        // (each model has its own free quota — 2.5-flash often still has
        // headroom when 3-flash is spent). Anything else is final.
        if (cli.reason !== 'model_not_found' && cli.reason !== 'quota_exhausted') break;
      }
      // Web-search calls that failed on the Gemini CLI: answer ungrounded
      // via Antigravity rather than failing the whole step (skip if cooling).
      if (webSearch && agyBin && !agyCooling) {
        const agy = await this._completeAgyLadder({ requested, prompt: full, timeoutMs });
        if (agy.ok) { this._mark(true, 'ready'); return finish(agy); }
        if (agy.reason === 'quota_exhausted') this._agyCooldownUntil = Date.now() + AGY_COOLDOWN_MS;
      }
      this._lastReason = last?.reason || 'cli_error';
    }

    // Provider 2: REST API key (fallback, or primary when no CLI/OAuth).
    const key = this.apiKey();
    if (key) {
      for (const model of ladder) {
        const api = await this._completeApi({ key, model, system, prompt, timeoutMs });
        if (api.ok) { this._mark(true, 'ready'); return finish(api); }
        last = api;
        if (api.reason !== 'model_not_found' && api.reason !== 'quota_exhausted') break;
      }
      this._lastReason = last?.reason || 'api_error';
    }

    // LAST RESORT: cross-lane fallback to OpenRouter. In hybrid mode a call
    // elected to the Gemini lane skips OpenRouter above; if every Gemini path
    // is exhausted, ride OpenRouter rather than pausing the whole council.
    // This is the symmetric twin of the OpenRouter-lane → Gemini fallback.
    if (hasOR && !triedOR) {
      const or = await runOpenRouter();
      if (or.ok) { this._mark(true, 'ready'); return finish(or); }
    }

    // Nothing served the request — report the most informative failure.
    if (last) { this._mark(false, last.reason || 'cli_error'); return finish(last); }
    if (!bin && !key && !hasOR) { this._mark(false, 'cli_missing'); return finish({ ok: false, provider: 'gemini-cli', model: requested, reason: 'cli_missing' }); }
    this._mark(false, 'needs_login');
    return finish({ ok: false, provider: 'gemini-cli', model: requested, reason: 'needs_login' });
  }

  async _completeApi({ key, model, system, prompt, timeoutMs = 60000 }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reason = data?.error?.status === 'UNAUTHENTICATED' || res.status === 401 || res.status === 403
          ? 'auth_required'
          : res.status === 429 || data?.error?.status === 'RESOURCE_EXHAUSTED'
            ? 'quota_exhausted'
            : res.status === 404 ? 'model_not_found' : `api_error_${res.status}`;
        return { ok: false, provider: 'gemini-api', model, reason, detail: data?.error?.message };
      }
      const text = (data?.candidates?.[0]?.content?.parts || [])
        .map(p => p.text || '').join('').trim();
      if (!text) return { ok: false, provider: 'gemini-api', model, reason: 'empty_output' };
      return { ok: true, text, provider: 'gemini-api', model };
    } catch (e) {
      const reason = e?.name === 'AbortError' ? 'timeout' : 'network_error';
      return { ok: false, provider: 'gemini-api', model, reason, detail: String(e?.message || e) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Walk the OpenRouter free-model ladder. The selected model goes
   * first; on rate-limit/unavailability we move to the next best free
   * model (live list, newest first) when auto-fallback is on.
   * Recently rate-limited models are skipped for 5 minutes.
   */
  async _completeOpenRouterLadder({ system, prompt, timeoutMs, webSearch }) {
    const cfg = this.config();
    const requestedRaw = cfg.openrouterModel || OPENROUTER_DEFAULT_MODEL;
    // 'auto' = no pinned model: always start from the strongest free
    // model currently served (quality-ranked), walking down on limits.
    const isAuto = String(requestedRaw).toLowerCase() === OPENROUTER_AUTO_MODEL
      || String(requestedRaw).toLowerCase() === 'best';
    const autoFallback = isAuto || cfg.openrouterAutoFallback !== false;

    const live = autoFallback ? await fetchOpenRouterFreeModels() : [];
    const liveSet = new Set(live);
    const preferred = OPENROUTER_PREFERRED_FREE.filter(m => !live.length || liveSet.has(m));
    let ladder;
    if (isAuto) {
      ladder = rankFreeModels([...new Set([...preferred, ...live])]).slice(0, 8);
    } else if (autoFallback) {
      ladder = [...new Set([requestedRaw, ...preferred, ...live])].slice(0, 8);
    } else {
      ladder = [requestedRaw];
    }
    const requested = ladder[0] || OPENROUTER_DEFAULT_MODEL;

    if (!this._orCooldown) this._orCooldown = new Map();
    const now = Date.now();
    const usable = ladder.filter(m => (this._orCooldown.get(m) || 0) < now);
    // If everything is cooling down, still try the requested model.
    const candidates = usable.length ? usable : [requested];

    let last = null;
    for (const model of candidates) {
      const r = await this._completeOpenRouter({ model, system, prompt, timeoutMs, webSearch });
      if (r.ok) return r;
      last = r;
      if (r.reason === 'quota_exhausted') {
        this._orCooldown.set(model, Date.now() + 300000);
        if (r.accountLimited || !autoFallback) break; // daily account cap — no model will help
        continue;
      }
      if (r.reason === 'model_not_found' && autoFallback) continue;
      break; // auth/network errors are final for this provider
    }
    return last || { ok: false, provider: 'openrouter', model: requested, reason: 'openrouter_error' };
  }

  async _completeOpenRouter({ model, system, prompt, timeoutMs = 120000, webSearch = false, allowPlugins = true }) {
    const key = this.openrouterKey();
    if (!key) return { ok: false, provider: 'openrouter', model, reason: 'auth_required' };

    const body = {
      model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 4096,
    };
    // Web grounding is a paid OpenRouter plugin; try it when asked, and
    // on failure (e.g. no credits on a free account) retry ungrounded.
    if (webSearch && allowPlugins) body.plugins = [{ id: 'web', max_results: 5 }];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${OPENROUTER_API}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:5210',
          'X-Title': 'Hermes OS',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || data?.error) {
        const status = data?.error?.code || res.status;
        const message = String(data?.error?.message || '');
        if ((status === 402 || status === 404 || status === 400) && webSearch && allowPlugins) {
          // Plugin not available on this account/model — retry plain.
          clearTimeout(timer);
          return this._completeOpenRouter({ model, system, prompt, timeoutMs, webSearch: false, allowPlugins: false });
        }
        const badModel = status === 404
          || (status === 400 && /not a valid model|model.{0,30}not (found|exist|available)/i.test(message));
        const reason = status === 401 || status === 403 ? 'auth_required'
          : status === 429 ? 'quota_exhausted'
          : badModel ? 'model_not_found'
          : status === 402 ? 'quota_exhausted'
          : `api_error_${status}`;
        // Free-tier daily caps are account-wide; switching models won't help.
        const accountLimited = status === 429 && /free.*(day|daily)|daily.*limit|account/i.test(message);
        return { ok: false, provider: 'openrouter', model, reason, accountLimited, detail: message.slice(0, 300) };
      }

      const text = String(data?.choices?.[0]?.message?.content || '').trim();
      if (!text) return { ok: false, provider: 'openrouter', model, reason: 'empty_output' };
      // Report the model that actually served (router may differ).
      return { ok: true, text, provider: 'openrouter', model: data?.model || model };
    } catch (e) {
      const reason = e?.name === 'AbortError' ? 'timeout' : 'network_error';
      return { ok: false, provider: 'openrouter', model, reason, detail: String(e?.message || e) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Walk the Antigravity model ladder. The 429 ("Individual quota reached")
   *  is account-wide, so once it fires we stop — walking other models just
   *  wastes ~5s each. Only a bad model id is worth a second try. */
  async _completeAgyLadder({ requested, prompt, timeoutMs }) {
    let last = null;
    for (const agyModel of agyLadderFor(requested)) {
      const r = await this._completeAgy({ model: agyModel, prompt, timeoutMs });
      if (r.ok) return r;
      last = r;
      if (r.reason !== 'model_not_found') break;
    }
    return last || { ok: false, provider: 'antigravity-cli', model: requested, reason: 'agy_error' };
  }

  async _completeAgy({ model, prompt, timeoutMs = 120000 }) {
    const bin = resolveAgyBin();
    if (!bin) return { ok: false, provider: 'antigravity-cli', model, reason: 'cli_missing' };

    // Pin agy's log to a known file so we can read the real failure: agy
    // sends quota/auth errors to its log, NOT stdout/stderr (a quota hit
    // leaves stdout empty), so without this they'd all look like empty_output.
    const logPath = path.join(os.tmpdir(), `hermes-agy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`);
    const result = await runProcess({
      command: bin,
      args: ['-p', prompt, '--model', model, '--dangerously-skip-permissions', '--log-file', logPath],
      cwd: WORKDIR,
      timeoutMs,
      env: {
        PATH: `${path.dirname(bin)}${path.delimiter}${process.env.PATH || ''}`,
        NO_COLOR: '1',
        TERM: 'dumb',
      },
    });

    const out = stripCliNoise(result.stdout);
    // Only fold the log in when there's no usable answer — on success agy's
    // log still contains transient "not logged into" lines we must ignore.
    let logText = '';
    if (!out) { try { logText = fs.readFileSync(logPath, 'utf8'); } catch { /* ignore */ } }
    try { fs.unlinkSync(logPath); } catch { /* ignore */ }
    const combined = `${result.stdout || ''}\n${result.stderr || ''}\n${logText}`;
    const QUOTA_AGY_RE = /RESOURCE_EXHAUSTED|individual quota|quota reached|\b429\b|resets? in/i;

    if (result.timedOut) return { ok: false, provider: 'antigravity-cli', model, reason: 'timeout' };
    if (result.spawnError) return { ok: false, provider: 'antigravity-cli', model, reason: 'spawn_error', detail: result.stderr };
    if (out) return { ok: true, text: out, provider: 'antigravity-cli', model };
    // Quota first: its log also carries transient "not logged into" auth noise.
    if (QUOTA_ERROR_RE.test(combined) || QUOTA_AGY_RE.test(combined)) {
      return { ok: false, provider: 'antigravity-cli', model, reason: 'quota_exhausted', detail: extractAgyError(combined) };
    }
    if (MODEL_ERROR_RE.test(combined)) {
      return { ok: false, provider: 'antigravity-cli', model, reason: 'model_not_found', detail: extractAgyError(combined) };
    }
    if (AUTH_ERROR_RE.test(combined) || /not logged into antigravity|token source/i.test(combined)) {
      return { ok: false, provider: 'antigravity-cli', model, reason: 'auth_required', detail: extractAgyError(combined) };
    }
    return { ok: false, provider: 'antigravity-cli', model, reason: 'empty_output', detail: extractAgyError(combined) };
  }

  async _completeCli({ model, prompt, timeoutMs = 90000, webSearch = false }) {
    const cfg = this.config();
    const bin = resolveGeminiBin(cfg.geminiCliPath);
    if (!bin) {
      return { ok: false, provider: 'gemini-cli', model, reason: 'cli_missing' };
    }

    const goodDir = findGoodNodeDir();
    const env = {
      PATH: `${goodDir}${path.delimiter}${process.env.PATH || ''}`,
      // Personal-account (Code Assist) OAuth is the free path.
      GOOGLE_GENAI_USE_GCA: 'true',
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
      NO_COLOR: '1',
      TERM: 'dumb',
    };

    // -e none: skip extensions/skills for faster, cleaner startup.
    const args = ['-m', model, '-o', 'text', '--skip-trust', '-e', 'none'];
    if (webSearch) {
      // Allow ONLY the read-only web tools so research runs are grounded in
      // live search results but the model can never touch shell or files.
      args.push('--allowed-tools', 'google_web_search,web_fetch,GoogleSearch,WebFetchTool');
    }
    args.push('-p', prompt);

    const result = await runProcess({
      command: bin,
      args,
      cwd: WORKDIR,
      timeoutMs: webSearch ? Math.max(timeoutMs, 150000) : timeoutMs,
      env,
    });

    const out = stripCliNoise(result.stdout);
    const combined = `${result.stdout || ''}\n${result.stderr || ''}`;

    if (result.timedOut) return { ok: false, provider: 'gemini-cli', model, reason: 'timeout' };
    if (result.spawnError) return { ok: false, provider: 'gemini-cli', model, reason: 'spawn_error', detail: result.stderr };
    if (!out && MODEL_ERROR_RE.test(combined)) {
      return { ok: false, provider: 'gemini-cli', model, reason: 'model_not_found', detail: combined.slice(0, 300) };
    }
    if (!out && QUOTA_ERROR_RE.test(combined)) {
      return { ok: false, provider: 'gemini-cli', model, reason: 'quota_exhausted', detail: combined.slice(0, 300) };
    }
    if (AUTH_ERROR_RE.test(combined) && !out) {
      return { ok: false, provider: 'gemini-cli', model, reason: 'auth_required', detail: result.stderr?.slice(0, 300) };
    }
    if (!out) {
      // Auth banners sometimes land on stdout; double-check.
      if (AUTH_ERROR_RE.test(combined)) {
        return { ok: false, provider: 'gemini-cli', model, reason: 'auth_required', detail: combined.slice(0, 300) };
      }
      return { ok: false, provider: 'gemini-cli', model, reason: 'empty_output', detail: result.stderr?.slice(0, 300) };
    }
    return { ok: true, text: out, provider: 'gemini-cli', model };
  }

  _mark(ok, reason) {
    this._lastAuthOk = ok;
    this._lastReason = reason;
    this._lastCheck = Date.now();
  }

  /** Active round-trip test (used by the dashboard "test brain" button). */
  async test() {
    const r = await this.complete({
      system: 'You are a connectivity probe. Reply with exactly one word.',
      prompt: 'Reply with the single word: PONG',
      timeoutMs: 60000,
    });
    return {
      ok: r.ok,
      provider: r.provider,
      model: r.model,
      ms: r.ms,
      reason: r.reason || (r.ok ? 'ready' : 'unknown'),
      sample: r.ok ? r.text.slice(0, 80) : (r.detail || ''),
    };
  }
}

// Robustly pull a JSON object/array out of an LLM response that may be
// wrapped in prose or ```json fences.
export function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  try { return JSON.parse(s); } catch { /* keep going */ }

  // Find the first balanced {...} or [...] block.
  const start = s.search(/[{[]/);
  if (start === -1) return null;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const block = s.slice(start, i + 1);
        try { return JSON.parse(block); } catch { return null; }
      }
    }
  }
  return null;
}

export default Brain;
