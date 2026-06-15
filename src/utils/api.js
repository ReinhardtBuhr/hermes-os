/* ═══════════════════════════════════════════════════════════════════
   HERMES OS — REST API Client
   Clean interface to the Hermes backend
   ═══════════════════════════════════════════════════════════════════ */

const API_BASE = '/api';

/**
 * Generic fetch wrapper with error handling.
 * @param {string} endpoint
 * @param {RequestInit} options
 * @returns {Promise<any>}
 */
async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;

  const config = {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  };

  // Don't set Content-Type for FormData (browser sets boundary)
  if (options.body instanceof FormData) {
    delete config.headers['Content-Type'];
  }

  try {
    const response = await fetch(url, config);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      let errorData;
      try {
        errorData = JSON.parse(errorBody);
      } catch {
        errorData = { message: errorBody || response.statusText };
      }

      const error = new Error(errorData.message || errorData.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.data = errorData;
      throw error;
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return null;
    }

    const json = await response.json();
    if (json && typeof json === 'object' && Object.prototype.hasOwnProperty.call(json, 'success')) {
      if (json.success === false) {
        throw new Error(json.error || json.message || `Request failed: ${endpoint}`);
      }
      return json.data ?? null;
    }
    return json;
  } catch (err) {
    if (err.status) {
      // Already formatted error from above
      throw err;
    }
    // Network error or other failure
    console.error(`[API] Request failed: ${options.method || 'GET'} ${url}`, err);
    throw new Error(`Network error: ${err.message}`);
  }
}


// ═══════════════════════════════════════════════════════════════════
//  GRAPH
// ═══════════════════════════════════════════════════════════════════

/**
 * Fetch the full knowledge graph (nodes + edges).
 * @returns {Promise<{nodes: Array, edges: Array}>}
 */
export async function getGraphData() {
  return request('/graph');
}

/**
 * Add a new node to the knowledge graph.
 * @param {Object} nodeData — { label, type, properties, ... }
 * @returns {Promise<Object>} The created node
 */
export async function addNode(nodeData) {
  return request('/graph/nodes', {
    method: 'POST',
    body: JSON.stringify(nodeData),
  });
}

/**
 * Delete a node from the knowledge graph.
 * @param {string|number} id — Node ID
 * @returns {Promise<null>}
 */
export async function deleteNode(id) {
  return request(`/graph/nodes/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}


// ═══════════════════════════════════════════════════════════════════
//  FILES
// ═══════════════════════════════════════════════════════════════════

/**
 * Get all uploaded files.
 * @returns {Promise<Array>}
 */
export async function getFiles() {
  return request('/files');
}

/**
 * Upload a file with progress tracking.
 * Uses XMLHttpRequest for onprogress support.
 * @param {File} file — File object
 * @param {Function} [onProgress] — Callback(percent: number)
 * @returns {Promise<Object>} Upload result
 */
export function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const formData = new FormData();
    formData.append('file', file);

    xhr.open('POST', `${API_BASE}/files/upload`);

    // Track upload progress
    if (onProgress && xhr.upload) {
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100);
          onProgress(percent);
        }
      });
    }

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const json = JSON.parse(xhr.responseText);
          resolve(json?.data ?? json);
        } catch {
          resolve({ success: true });
        }
      } else {
        let errorMsg = `Upload failed (${xhr.status})`;
        try {
          const errorData = JSON.parse(xhr.responseText);
          errorMsg = errorData.message || errorData.error || errorMsg;
        } catch { /* ignore */ }
        reject(new Error(errorMsg));
      }
    });

    xhr.addEventListener('error', () => {
      reject(new Error('Upload failed — network error'));
    });

    xhr.addEventListener('abort', () => {
      reject(new Error('Upload aborted'));
    });

    xhr.send(formData);
  });
}


// ═══════════════════════════════════════════════════════════════════
//  ANALYTICS
// ═══════════════════════════════════════════════════════════════════

/**
 * Get analytics summary (overview stats).
 * @returns {Promise<Object>}
 */
export async function getAnalyticsSummary() {
  return request('/analytics/summary');
}

/**
 * Get traffic data for charts.
 * @returns {Promise<Object>}
 */
export async function getTrafficData() {
  return request('/analytics/traffic');
}

/**
 * Get social media metrics.
 * @returns {Promise<Object>}
 */
export async function getSocialMetrics() {
  return request('/analytics/social');
}

/**
 * Get revenue data.
 * @returns {Promise<Object>}
 */
export async function getRevenueData() {
  return request('/analytics/revenue');
}

/**
 * Get modular analytics widgets.
 * @returns {Promise<Array>}
 */
export async function getAnalyticsWidgets() {
  return request('/analytics/widgets');
}

/**
 * Create or update a modular analytics widget.
 * @param {Object} widget
 * @returns {Promise<Object>}
 */
export async function upsertAnalyticsWidget(widget) {
  return request('/analytics/widgets', {
    method: 'POST',
    body: JSON.stringify(widget),
  });
}


// ═══════════════════════════════════════════════════════════════════
//  HERMES AI
// ═══════════════════════════════════════════════════════════════════

/**
 * Get Hermes AI status.
 * @returns {Promise<Object>}
 */
export async function getHermesStatus() {
  return request('/hermes/status');
}

/**
 * Get recent Hermes activity/messages.
 * @returns {Promise<Array>}
 */
export async function getHermesActivity() {
  return request('/hermes/activity');
}

/**
 * Get Hermes model/configuration state.
 * @returns {Promise<Object>}
 */
export async function getHermesConfig() {
  return request('/hermes/config');
}

/**
 * Update Hermes model/configuration state.
 * @param {Object} updates
 * @returns {Promise<Object>}
 */
export async function updateHermesConfig(updates) {
  return request('/hermes/config', {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

/**
 * Get the selectable brain models and which one is active.
 * @returns {Promise<{options: Array, active: string, brain: Object}>}
 */
export async function getHermesModels() {
  return request('/hermes/models');
}

/**
 * Send a chat directive to Hermes.
 * @param {string} message
 * @param {string} [clientMessageId]
 * @returns {Promise<Object>}
 */
export async function sendHermesMessage(message, clientMessageId) {
  return request('/hermes/chat', {
    method: 'POST',
    body: JSON.stringify({ message, clientMessageId }),
  });
}

/**
 * Get a fresh insight from Hermes.
 * @returns {Promise<Object>}
 */
export async function getHermesInsight() {
  return request('/hermes/insight');
}

/**
 * Delete an analytics widget by id.
 * @param {string} id
 * @returns {Promise<any>}
 */
export async function deleteAnalyticsWidget(id) {
  return request(`/analytics/widgets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Get the Gemini brain status.
 * @returns {Promise<Object>}
 */
export async function getBrainStatus() {
  return request('/hermes/brain');
}

/**
 * Run a live round-trip test against the Gemini brain.
 * @returns {Promise<Object>}
 */
export async function testBrain() {
  return request('/hermes/brain/test', { method: 'POST' });
}


// ═══════════════════════════════════════════════════════════════════
//  COGNITION — deep research, dream loops, ideas, artifacts
// ═══════════════════════════════════════════════════════════════════

/** Launch a deep-research pipeline. Progress streams over the WebSocket. */
export async function startResearch(question, depth = 'standard') {
  return request('/hermes/research', {
    method: 'POST',
    body: JSON.stringify({ question, depth }),
  });
}

/** Trigger one dream cycle right now. */
export async function runDreamCycle() {
  return request('/hermes/dream/cycle', { method: 'POST' });
}

/** List cognition runs (kind: 'research' | 'dream' | null for all). */
export async function getRuns(kind = null, limit = 20) {
  const params = new URLSearchParams();
  if (kind) params.set('kind', kind);
  params.set('limit', limit);
  return request(`/hermes/runs?${params}`);
}

/** Get one run with its full log + result. */
export async function getRun(id) {
  return request(`/hermes/runs/${encodeURIComponent(id)}`);
}

/** Idea ledger (order: 'total' | 'recent'). */
export async function getIdeas(order = 'total', limit = 30) {
  return request(`/hermes/ideas?order=${order}&limit=${limit}`);
}

/** List artifacts (reports/plans) without full content. */
export async function getArtifacts(limit = 20) {
  return request(`/hermes/artifacts?limit=${limit}`);
}

/** Get one artifact with full markdown content. */
export async function getArtifact(id) {
  return request(`/hermes/artifacts/${encodeURIComponent(id)}`);
}


// ═══════════════════════════════════════════════════════════════════
//  RESEARCH COUNCIL — multi-agent hypothesis tournament
// ═══════════════════════════════════════════════════════════════════

/** Convene a council on a research goal. Progress streams over the WebSocket. */
export async function startCouncil(goal, config = {}) {
  return request('/council', {
    method: 'POST',
    body: JSON.stringify({ goal, config }),
  });
}

/** List all councils, newest first. */
export async function listCouncils() {
  return request('/council');
}

/** Full council detail: leaderboard, matches, events, evidence. */
export async function getCouncilDetail(id) {
  return request(`/council/${encodeURIComponent(id)}`);
}

/** Stop a running council. */
export async function stopCouncil(id) {
  return request(`/council/${encodeURIComponent(id)}/stop`, { method: 'POST' });
}

/** Resume a stopped or paused council. */
export async function resumeCouncil(id) {
  return request(`/council/${encodeURIComponent(id)}/resume`, { method: 'POST' });
}

/**
 * Submit external results/data for the closed-loop interpretation agents.
 * Optionally attach photos — when present, the drop is sent as multipart.
 * @param {string} id
 * @param {string} content
 * @param {File[]} [images]
 */
export async function submitCouncilEvidence(id, content, images = []) {
  if (images && images.length) {
    const form = new FormData();
    form.append('content', content || '');
    for (const file of images) form.append('images', file);
    return request(`/council/${encodeURIComponent(id)}/evidence`, { method: 'POST', body: form });
  }
  return request(`/council/${encodeURIComponent(id)}/evidence`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

/**
 * Operator purge: clear the proposed leaderboard, keeping the check-marked
 * hypotheses as the pivot direction. The council adapts instantly.
 * @param {string} id
 * @param {string[]} keepIds — hypothesis ids to KEEP (favored)
 * @param {string} [reason]
 */
export async function purgeCouncilProposals(id, keepIds = [], reason = '') {
  return request(`/council/${encodeURIComponent(id)}/purge`, {
    method: 'POST',
    body: JSON.stringify({ keepIds, reason }),
  });
}

/** End the tournament: the verdict agent writes the final report. */
export async function concludeCouncil(id) {
  return request(`/council/${encodeURIComponent(id)}/conclude`, { method: 'POST' });
}

/** Hypothesis graph for one council (nodes + lineage/match edges). */
export async function getCouncilGraph(id) {
  return request(`/council/${encodeURIComponent(id)}/graph`);
}

/** Evolution forest: every hypothesis ever born (any status) + lineage. */
export async function getCouncilTree(id) {
  return request(`/council/${encodeURIComponent(id)}/tree`);
}

/** Operator revive: re-test the brain + re-engage idle council loops. */
export async function reviveAgents() {
  return request('/system/revive', { method: 'POST' });
}

/** Every council agent's live traits + mind (what it is thinking right now). */
export async function getCouncilAgents(id) {
  return request(`/council/${encodeURIComponent(id)}/agents`);
}

/** Retune one agent's attributes — applies on its very next action. */
export async function updateCouncilAgent(id, role, patch) {
  return request(`/council/${encodeURIComponent(id)}/agents/${encodeURIComponent(role)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

/** Operator veto: strike a hypothesis; the council learns from it instantly. */
export async function vetoCouncilHypothesis(id, hypothesisId, reason = '') {
  return request(`/council/${encodeURIComponent(id)}/veto`, {
    method: 'POST',
    body: JSON.stringify({ hypothesisId, reason }),
  });
}

/** Move the council power dial (1-5): token burn ↔ speed/parallelism. */
export async function setCouncilPower(id, power) {
  return request(`/council/${encodeURIComponent(id)}/power`, {
    method: 'POST',
    body: JSON.stringify({ power }),
  });
}
