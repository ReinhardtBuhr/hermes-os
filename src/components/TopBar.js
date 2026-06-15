export class TopBar {
  constructor(container) {
    this.container = container;
    this.el = null;
    this.clockInterval = null;
    this.notificationCount = 0;
    this.currentSection = 'Dashboard';
  }

  render() {
    this.el = document.createElement('header');
    this.el.className = 'topbar';
    this.el.innerHTML = this._template();
    this.container.appendChild(this.el);

    // Start clock
    this._startClock();

    // Bind search
    const searchInput = this.el.querySelector('.topbar-search-input');
    if (searchInput) {
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && searchInput.value.trim()) {
          this.container.dispatchEvent(new CustomEvent('search', {
            detail: { query: searchInput.value.trim() },
            bubbles: true
          }));
        }
      });
    }

    // Bind notification bell
    const bell = this.el.querySelector('.topbar-bell');
    if (bell) {
      bell.addEventListener('click', () => {
        this.notificationCount = 0;
        this._updateBadge();
      });
    }
  }

  _template() {
    return `
      <div class="topbar-left">
        <span class="topbar-breadcrumb">
          <span class="breadcrumb-icon">◈</span>
          Mission Control / <span class="breadcrumb-section">${this.currentSection}</span>
        </span>
      </div>

      <div class="topbar-center">
        <div class="topbar-search">
          <span class="topbar-search-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </span>
          <input type="text" class="topbar-search-input" placeholder="Search the knowledge graph..." />
        </div>
      </div>

      <div class="topbar-right">
        <button class="topbar-bell" title="Notifications">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
          </svg>
          <span class="topbar-badge ${this.notificationCount > 0 ? '' : 'hidden'}">${this.notificationCount}</span>
        </button>

        <div class="topbar-clock" id="topbar-clock">--:--:--</div>

        <div class="topbar-hermes-status">
          <span class="status-dot status-dot--online"></span>
          <span>Hermes Online</span>
        </div>
      </div>
    `;
  }

  updateSection(name) {
    this.currentSection = name;
    const sectionEl = this.el?.querySelector('.breadcrumb-section');
    if (sectionEl) sectionEl.textContent = name;
  }

  addNotification() {
    this.notificationCount++;
    this._updateBadge();
  }

  _updateBadge() {
    const badge = this.el?.querySelector('.topbar-badge');
    if (badge) {
      badge.textContent = this.notificationCount;
      badge.classList.toggle('hidden', this.notificationCount === 0);
    }
  }

  _startClock() {
    const update = () => {
      const now = new Date();
      const h = String(now.getHours()).padStart(2, '0');
      const m = String(now.getMinutes()).padStart(2, '0');
      const s = String(now.getSeconds()).padStart(2, '0');
      const el = this.el?.querySelector('#topbar-clock');
      if (el) el.textContent = `${h}:${m}:${s}`;
    };
    update();
    this.clockInterval = setInterval(update, 1000);
  }

  destroy() {
    if (this.clockInterval) clearInterval(this.clockInterval);
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = null;
  }
}
