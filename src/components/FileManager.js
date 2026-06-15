import { uploadFile, getFiles } from '../utils/api.js';
import { fadeIn } from '../utils/animations.js';

const FILE_ICONS = {
  image: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
    <polyline points="21 15 16 10 5 21"/>
  </svg>`,
  document: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>
    <line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
  </svg>`,
  code: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
  </svg>`,
  data: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
  </svg>`,
  media: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="5 3 19 12 5 21 5 3"/>
  </svg>`,
  default: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
    <polyline points="13 2 13 9 20 9"/>
  </svg>`
};

const CATEGORY_MAP = {
  'image/png': 'image', 'image/jpeg': 'image', 'image/gif': 'image', 'image/svg+xml': 'image', 'image/webp': 'image',
  'application/pdf': 'document', 'text/plain': 'document', 'text/markdown': 'document',
  'application/json': 'data', 'text/csv': 'data', 'application/xml': 'data',
  'text/javascript': 'code', 'text/html': 'code', 'text/css': 'code', 'application/javascript': 'code',
  'video/mp4': 'media', 'audio/mpeg': 'media', 'audio/wav': 'media', 'video/webm': 'media'
};

const CATEGORY_COLORS = {
  image: '#3b82f6', document: '#00f0ff', code: '#00ff88', data: '#7b2fff', media: '#ff9f1c', default: '#8b92a5'
};

export class FileManager {
  constructor(container) {
    this.container = container;
    this.el = null;
    this.files = [];
    this.gridEl = null;
    this.statsEl = null;
    this._dragHandlers = {};
  }

  async init() {
    this.render();
    try {
      const data = await getFiles();
      const fileList = data?.files || data || [];
      if (Array.isArray(fileList)) {
        this.files = fileList.map(file => this._normalizeFile(file));
        this._renderFileGrid();
        this._updateStats();
      }
    } catch (e) {
      // Silent fail
    }
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'file-manager';

    this.el.innerHTML = `
      <div class="file-dropzone" id="file-dropzone">
        <div class="dropzone-content">
          <div class="dropzone-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#00f0ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M16.5 9.4l-9-5.19M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
              <polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>
            </svg>
          </div>
          <p class="dropzone-text">Drop files here to assimilate into the knowledge graph</p>
          <p class="dropzone-subtext">or click to browse</p>
        </div>
        <input type="file" class="dropzone-input" multiple hidden />
      </div>

      <div class="file-stats" id="file-stats">0 files indexed | 0 KB total</div>
      <div class="file-grid" id="file-grid"></div>
    `;

    this.container.appendChild(this.el);

    this.gridEl = this.el.querySelector('#file-grid');
    this.statsEl = this.el.querySelector('#file-stats');
    const dropzone = this.el.querySelector('#file-dropzone');
    const fileInput = this.el.querySelector('.dropzone-input');

    // Click to browse
    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => this._handleFiles(e.target.files));

    // Drag and drop
    this._dragHandlers.dragenter = (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-active');
      dropzone.querySelector('.dropzone-text').textContent = 'Release to upload';
    };
    this._dragHandlers.dragover = (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-active');
    };
    this._dragHandlers.dragleave = (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-active');
      dropzone.querySelector('.dropzone-text').textContent = 'Drop files here to assimilate into the knowledge graph';
    };
    this._dragHandlers.drop = (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-active');
      dropzone.querySelector('.dropzone-text').textContent = 'Drop files here to assimilate into the knowledge graph';
      if (e.dataTransfer.files.length) {
        this._handleFiles(e.dataTransfer.files);
      }
    };

    dropzone.addEventListener('dragenter', this._dragHandlers.dragenter);
    dropzone.addEventListener('dragover', this._dragHandlers.dragover);
    dropzone.addEventListener('dragleave', this._dragHandlers.dragleave);
    dropzone.addEventListener('drop', this._dragHandlers.drop);
  }

  async _handleFiles(fileList) {
    for (const file of Array.from(fileList)) {
      // Show progress
      const progressEl = this._showProgress(file.name);

      try {
        const result = await uploadFile(file);
        const fileData = this._normalizeFile(result?.file || {
          name: file.name,
          size: file.size,
          type: file.type,
          category: this._getCategory(file.type),
          uploadedAt: new Date().toISOString()
        });
        fileData.category = fileData.category || this._getCategory(file.type || fileData.type);
        fileData.size = fileData.size || file.size;
        this.addFile(fileData);

        // Emit event
        this.container.dispatchEvent(new CustomEvent('file_uploaded', {
          detail: fileData,
          bubbles: true
        }));
      } catch (e) {
        console.error('Upload failed:', e);
      }

      // Remove progress
      if (progressEl && progressEl.parentNode) {
        progressEl.parentNode.removeChild(progressEl);
      }
    }
  }

  _showProgress(filename) {
    const el = document.createElement('div');
    el.className = 'file-upload-progress';
    el.innerHTML = `
      <span class="progress-filename">${this._truncate(filename, 30)}</span>
      <div class="progress-bar"><div class="progress-bar-fill"></div></div>
    `;
    this.el.insertBefore(el, this.gridEl);

    // Animate progress bar
    const fill = el.querySelector('.progress-bar-fill');
    let progress = 0;
    const interval = setInterval(() => {
      progress += Math.random() * 20;
      if (progress >= 95) {
        clearInterval(interval);
        progress = 95;
      }
      fill.style.width = `${progress}%`;
    }, 200);

    el._interval = interval;
    return el;
  }

  addFile(fileData) {
    const normalized = this._normalizeFile(fileData);
    if (this.files.some(file => this._fileKey(file) === this._fileKey(normalized))) {
      return;
    }

    this.files.push(normalized);
    const card = this._createFileCard(normalized);
    this.gridEl.appendChild(card);

    // Animate in
    card.style.opacity = '0';
    card.style.transform = 'scale(0.9)';
    requestAnimationFrame(() => {
      card.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
      card.style.opacity = '1';
      card.style.transform = 'scale(1)';
    });

    this._updateStats();
  }

  onFileAdded(payload) {
    this.addFile(payload?.file || payload);
  }

  _createFileCard(file) {
    const category = file.category || this._getCategory(file.type || file.mime_type || file.mimeType || '');
    const color = CATEGORY_COLORS[category] || CATEGORY_COLORS.default;
    const icon = FILE_ICONS[category] || FILE_ICONS.default;
    const displayName = file.name || file.originalName || file.original_name || file.filename || 'Unknown';

    const card = document.createElement('div');
    card.className = 'file-card';
    card.innerHTML = `
      <div class="file-card-icon" style="color: ${color}">${icon}</div>
      <div class="file-card-info">
        <span class="file-card-name" title="${this._escape(displayName)}">${this._escape(this._truncate(displayName, 24))}</span>
        <span class="file-card-size">${this._formatSize(file.size || 0)}</span>
      </div>
      <span class="file-card-badge" style="background: ${color}22; color: ${color}; border: 1px solid ${color}44">${category}</span>
    `;

    card.addEventListener('click', () => {
      this.container.dispatchEvent(new CustomEvent('file_selected', {
        detail: file,
        bubbles: true
      }));
    });

    return card;
  }

  _renderFileGrid() {
    this.gridEl.innerHTML = '';
    this.files.forEach(file => {
      this.gridEl.appendChild(this._createFileCard(file));
    });
  }

  _updateStats() {
    const totalSize = this.files.reduce((sum, f) => sum + (f.size || 0), 0);
    if (this.statsEl) {
      this.statsEl.textContent = `${this.files.length} files indexed | ${this._formatSize(totalSize)} total`;
    }
  }

  _getCategory(mimeType) {
    return CATEGORY_MAP[mimeType] || 'default';
  }

  _normalizeFile(file = {}) {
    const metadata = file.metadata || {};
    const type = file.type || file.mimeType || file.mime_type || metadata.mimeType || '';
    const category = file.category || metadata.category || this._getCategory(type);
    return {
      ...file,
      name: file.name || file.originalName || file.original_name || file.filename || 'Unknown',
      type,
      category,
      size: file.size || 0,
    };
  }

  _fileKey(file) {
    return file.id || file.fileId || `${file.filename || file.name}-${file.size}`;
  }

  _formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  _truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.substring(0, max - 3) + '...' : str;
  }

  _escape(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  destroy() {
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = null;
  }
}

export default FileManager;
