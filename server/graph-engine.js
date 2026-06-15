// ─────────────────────────────────────────────────────────────
// Hermes OS — Knowledge Graph Engine
// Inspired by Graphify — builds & analyzes the knowledge graph
// ─────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import path from 'node:path';

// ── Build a graph from an array of file metadata objects ─────
// Each file becomes a node; edges are inferred from relationships.
export function buildGraphFromFiles(files) {
  const nodes = [];
  const edges = [];

  // Create a node for every file
  for (const file of files) {
    nodes.push({
      id: file.id || randomUUID(),
      label: file.originalName || file.filename,
      type: 'file',
      size: Math.max(8, Math.min(30, Math.log2((file.size || 1024) + 1) * 3)),
      color: file.color || '#00fff7',
      metadata: {
        mimeType: file.mimeType,
        category: file.category,
        directory: file.directory || '',
        keywords: file.keywords || [],
      },
    });
  }

  // Infer edges between every pair of nodes
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];

      // Same directory → strong edge
      if (a.metadata.directory && a.metadata.directory === b.metadata.directory) {
        edges.push(createEdge(a.id, b.id, 0.9, 'directory'));
      }

      // Same MIME category → medium edge
      if (a.metadata.category && a.metadata.category === b.metadata.category) {
        edges.push(createEdge(a.id, b.id, 0.6, 'type_similarity'));
      }

      // Keyword overlap → weighted edge
      const overlap = keywordOverlap(a.metadata.keywords || [], b.metadata.keywords || []);
      if (overlap > 0) {
        edges.push(createEdge(a.id, b.id, Math.min(1, overlap * 0.3), 'name_similarity'));
      }
    }
  }

  return { nodes, edges };
}

// ── Community detection (connected components + modularity) ──
export function detectCommunities(nodes, edges) {
  const adjacency = buildAdjacencyMap(nodes, edges);
  const visited = new Set();
  const communities = [];
  let communityId = 0;

  // Phase 1: Find connected components via BFS
  for (const node of nodes) {
    if (visited.has(node.id)) continue;

    const community = [];
    const queue = [node.id];
    visited.add(node.id);

    while (queue.length > 0) {
      const current = queue.shift();
      community.push(current);

      for (const neighbour of (adjacency.get(current) || [])) {
        if (!visited.has(neighbour)) {
          visited.add(neighbour);
          queue.push(neighbour);
        }
      }
    }

    communities.push({ id: communityId++, members: community });
  }

  // Phase 2: Simple modularity-inspired sub-clustering
  // Split large components by edge density around high-degree nodes
  const refined = [];
  for (const community of communities) {
    if (community.members.length <= 3) {
      refined.push(community);
      continue;
    }

    // Find the node with highest degree inside this community
    const memberSet = new Set(community.members);
    let maxDeg = 0;
    let hub = community.members[0];

    for (const nodeId of community.members) {
      const neighbors = (adjacency.get(nodeId) || []).filter(n => memberSet.has(n));
      if (neighbors.length > maxDeg) {
        maxDeg = neighbors.length;
        hub = nodeId;
      }
    }

    // Split into "hub-adjacent" and "peripheral"
    const hubNeighbors = new Set((adjacency.get(hub) || []).filter(n => memberSet.has(n)));
    hubNeighbors.add(hub);

    const peripheral = community.members.filter(m => !hubNeighbors.has(m));

    if (peripheral.length > 0) {
      refined.push({ id: refined.length, members: [...hubNeighbors] });
      refined.push({ id: refined.length + 1, members: peripheral });
    } else {
      refined.push(community);
    }
  }

  return refined;
}

// ── Node importance via degree centrality ────────────────────
export function calculateNodeImportance(nodes, edges) {
  const degree = new Map();

  // Initialise all nodes to 0
  for (const node of nodes) {
    degree.set(node.id, 0);
  }

  // Count edges (weighted)
  for (const edge of edges) {
    const w = edge.weight || 1;
    degree.set(edge.source, (degree.get(edge.source) || 0) + w);
    degree.set(edge.target, (degree.get(edge.target) || 0) + w);
  }

  // Normalise to 0-1 range
  const maxDegree = Math.max(...degree.values(), 1);
  const importance = {};

  for (const [id, d] of degree) {
    importance[id] = +(d / maxDegree).toFixed(4);
  }

  return importance;
}

// ── BFS traversal to find a connected subgraph ───────────────
export function findConnections(nodeId, depth, nodes, edges) {
  const adjacency = buildAdjacencyMap(nodes, edges);
  const visited = new Set();
  const result = { nodes: [], edges: [] };

  const queue = [{ id: nodeId, d: 0 }];
  visited.add(nodeId);

  while (queue.length > 0) {
    const { id, d } = queue.shift();

    const node = nodes.find(n => n.id === id);
    if (node) result.nodes.push(node);

    if (d >= depth) continue;

    for (const neighbour of (adjacency.get(id) || [])) {
      if (!visited.has(neighbour)) {
        visited.add(neighbour);
        queue.push({ id: neighbour, d: d + 1 });
      }
    }
  }

  // Collect edges within the visited set
  const visitedSet = visited;
  result.edges = edges.filter(e => visitedSet.has(e.source) && visitedSet.has(e.target));

  return result;
}

// ── Add a single file to the live graph ──────────────────────
export function addFileToGraph(fileMetadata, db) {
  // 1. Create a node for the file
  const nodeColor = fileMetadata.color || '#00fff7';
  const nodeSize = Math.max(8, Math.min(30, Math.log2((fileMetadata.size || 1024) + 1) * 3));

  const node = db.addNode({
    label: fileMetadata.originalName || fileMetadata.filename,
    type: 'file',
    size: nodeSize,
    color: nodeColor,
    metadata: {
      mimeType: fileMetadata.mimeType,
      category: fileMetadata.category,
      keywords: fileMetadata.keywords || [],
      fileId: fileMetadata.id,
    },
  });

  // 2. Find related existing nodes and create edges
  const existingNodes = db.getNodes();
  const newEdges = [];

  for (const existing of existingNodes) {
    if (existing.id === node.id) continue;

    let shouldConnect = false;
    let weight = 0;
    let edgeType = 'related';

    // Same category
    if (existing.metadata?.category && existing.metadata.category === fileMetadata.category) {
      shouldConnect = true;
      weight = Math.max(weight, 0.5);
      edgeType = 'type_similarity';
    }

    // Keyword overlap with node label or keywords
    const existingKeywords = existing.metadata?.keywords || [];
    const newKeywords = fileMetadata.keywords || [];

    // Also treat the existing label as potential keywords
    const existingLabelWords = (existing.label || '').toLowerCase().split(/[\s\-_]+/);
    const overlap = keywordOverlap(newKeywords, [...existingKeywords, ...existingLabelWords]);

    if (overlap > 0) {
      shouldConnect = true;
      weight = Math.max(weight, Math.min(1, overlap * 0.3));
      edgeType = 'name_similarity';
    }

    // Same type (file nodes)
    if (existing.type === 'file' && existing.metadata?.mimeType === fileMetadata.mimeType) {
      shouldConnect = true;
      weight = Math.max(weight, 0.6);
      edgeType = 'type_match';
    }

    if (shouldConnect && weight > 0.2) {
      const edge = db.addEdge({
        source: node.id,
        target: existing.id,
        weight,
        type: edgeType,
      });
      newEdges.push(edge);
    }
  }

  return { node, edges: newEdges };
}

// ── Full graph data for frontend ─────────────────────────────
export function getGraphData(db) {
  const nodes = db.getNodes();
  const edges = db.getEdges();

  const importance = calculateNodeImportance(nodes, edges);

  // Attach importance score to each node
  const enrichedNodes = nodes.map(node => ({
    ...node,
    importance: importance[node.id] || 0,
  }));

  return { nodes: enrichedNodes, edges };
}

// ── Utility: adjacency map ───────────────────────────────────
function buildAdjacencyMap(nodes, edges) {
  const adj = new Map();
  for (const node of nodes) {
    adj.set(node.id, []);
  }
  for (const edge of edges) {
    if (adj.has(edge.source)) adj.get(edge.source).push(edge.target);
    if (adj.has(edge.target)) adj.get(edge.target).push(edge.source);
  }
  return adj;
}

// ── Utility: keyword overlap count ───────────────────────────
function keywordOverlap(a, b) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b.map(k => k.toLowerCase()));
  return a.filter(k => setB.has(k.toLowerCase())).length;
}

// ── Utility: create edge object ──────────────────────────────
function createEdge(source, target, weight, type) {
  return {
    id: randomUUID(),
    source,
    target,
    weight,
    type,
    metadata: {},
    created_at: new Date().toISOString(),
  };
}

export default {
  buildGraphFromFiles,
  detectCommunities,
  calculateNodeImportance,
  findConnections,
  addFileToGraph,
  getGraphData,
};
