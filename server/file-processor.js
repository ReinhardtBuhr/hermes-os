// ─────────────────────────────────────────────────────────────
// Hermes OS — File Processor
// Extracts metadata, keywords, and categories from uploaded files
// ─────────────────────────────────────────────────────────────

import path from 'node:path';
import fs from 'node:fs';
import mime from 'mime-types';

// ── Category → neon color mapping ────────────────────────────
const CATEGORY_COLORS = {
  image:    '#ff6ec7', // hot pink
  document: '#00bfff', // deep sky blue
  code:     '#39ff14', // neon green
  data:     '#ffd700', // gold
  media:    '#da70d6', // orchid
  other:    '#7b68ee', // medium slate blue
};

// ── Process an uploaded file (from multer) ───────────────────
export function processUploadedFile(file, uploadDir) {
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  const mimeType = file.mimetype || mime.lookup(file.originalname) || 'application/octet-stream';
  const category = getFileCategory(mimeType);
  const keywords = extractKeywords(file.originalname);
  const color = generateFileColor(category);

  const metadata = {
    id: undefined, // will be assigned by the database layer
    filename: file.filename,
    originalName: file.originalname,
    mimeType,
    size: file.size,
    extension: ext,
    category,
    color,
    keywords,
    directory: uploadDir,
    filePath: file.path,
    processedAt: new Date().toISOString(),
  };

  return metadata;
}

// ── Extract keywords from a filename ─────────────────────────
// Splits on spaces, hyphens, underscores, dots, and camelCase boundaries.
export function extractKeywords(filename) {
  if (!filename) return [];

  // Strip the extension first
  const nameWithoutExt = path.basename(filename, path.extname(filename));

  // Split by common delimiters
  let tokens = nameWithoutExt.split(/[\s\-_.]+/);

  // Further split camelCase and PascalCase tokens
  const expanded = [];
  for (const token of tokens) {
    // "myFileName" → ["my", "File", "Name"]
    const camelParts = token.replace(/([a-z])([A-Z])/g, '$1 $2')
                            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
                            .split(/\s+/);
    expanded.push(...camelParts);
  }

  // Normalize: lowercase, remove short tokens & pure numbers
  return [...new Set(
    expanded
      .map(t => t.toLowerCase().trim())
      .filter(t => t.length > 1 && !/^\d+$/.test(t))
  )];
}

// ── Categorize a file by its MIME type ───────────────────────
export function getFileCategory(mimeType) {
  if (!mimeType) return 'other';

  const mt = mimeType.toLowerCase();

  // Images
  if (mt.startsWith('image/')) return 'image';

  // Video & audio
  if (mt.startsWith('video/') || mt.startsWith('audio/')) return 'media';

  // Code & scripts
  const codeTypes = [
    'application/javascript', 'application/json', 'application/xml',
    'application/x-python', 'application/x-sh', 'application/typescript',
    'text/javascript', 'text/html', 'text/css', 'text/x-python',
    'text/x-java-source', 'text/x-c', 'text/x-c++',
    'application/x-httpd-php', 'text/x-ruby', 'text/x-go',
    'text/x-rust', 'text/x-swift', 'text/x-kotlin',
  ];
  if (codeTypes.includes(mt) || mt.includes('javascript') || mt.includes('json') || mt.includes('xml')) {
    return 'code';
  }

  // Data (spreadsheets, CSV, databases)
  const dataTypes = [
    'text/csv', 'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/x-sqlite3', 'application/sql',
  ];
  if (dataTypes.includes(mt) || mt.includes('csv') || mt.includes('excel') || mt.includes('spreadsheet')) {
    return 'data';
  }

  // Documents (PDF, Word, text, markdown)
  const docTypes = [
    'application/pdf', 'text/plain', 'text/markdown',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/rtf',
  ];
  if (docTypes.includes(mt) || mt.startsWith('text/')) {
    return 'document';
  }

  return 'other';
}

// ── Generate a neon color based on file category ─────────────
export function generateFileColor(category) {
  return CATEGORY_COLORS[category] || CATEGORY_COLORS.other;
}

export default {
  processUploadedFile,
  extractKeywords,
  getFileCategory,
  generateFileColor,
};
