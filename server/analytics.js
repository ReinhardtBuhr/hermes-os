// ─────────────────────────────────────────────────────────────
// Hermes OS — Analytics Engine
// Produces realistic-looking mock analytics with random variance
// ─────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';

// ── Utility: add random variance to a base number ────────────
function vary(base, pct = 0.1) {
  const delta = base * pct;
  return +(base + (Math.random() * 2 - 1) * delta).toFixed(2);
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function dateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

// ── AnalyticsEngine class ────────────────────────────────────

export class AnalyticsEngine {
  constructor(db = null) {
    this.db = db;
    this.baseMetrics = {
      totalVisitors: 48_392,
      pageViews: 142_817,
      bounceRate: 34.2,
      avgSession: 245, // seconds
      revenue: 28_450.00,
      socialFollowers: 12_840,
    };
  }

  /** High-level summary — every call returns slightly different numbers. */
  getSummary() {
    const widgets = this.getWidgets();
    if (widgets.length) {
      const byLabel = (pattern) => widgets.find(widget => pattern.test(widget.label));
      const visitors = byLabel(/visitor|traffic/i);
      const pageViews = byLabel(/page\s*view|views/i);
      const revenue = byLabel(/revenue|sales|mrr|arr/i);
      const actions = byLabel(/agent action/i);

      return {
        totalVisitors: Math.round(Number(visitors?.value ?? this.baseMetrics.totalVisitors)),
        pageViews: Math.round(Number(pageViews?.value ?? this.baseMetrics.pageViews)),
        bounceRate: +vary(this.baseMetrics.bounceRate, 0.04).toFixed(1),
        avgSession: `${Math.floor(vary(this.baseMetrics.avgSession, 0.03))}s`,
        revenue: +(Number(revenue?.value ?? this.baseMetrics.revenue)).toFixed(2),
        agentActions: Math.round(Number(actions?.value ?? 0)),
        widgets: widgets.length,
        lastUpdated: new Date().toISOString(),
      };
    }

    return {
      totalVisitors:   Math.round(vary(this.baseMetrics.totalVisitors, 0.05)),
      pageViews:       Math.round(vary(this.baseMetrics.pageViews, 0.05)),
      bounceRate:      +vary(this.baseMetrics.bounceRate, 0.08).toFixed(1),
      avgSession:      `${Math.floor(vary(this.baseMetrics.avgSession, 0.06))}s`,
      revenue:         +vary(this.baseMetrics.revenue, 0.04).toFixed(2),
      socialFollowers: Math.round(vary(this.baseMetrics.socialFollowers, 0.03)),
      lastUpdated:     new Date().toISOString(),
    };
  }

  /** Traffic data for sparkline / line chart. */
  getTrafficData(days = 30) {
    const visitors = this.getWidgets().find(widget => /visitor|traffic/i.test(widget.label));
    const pageViews = this.getWidgets().find(widget => /page\s*view|views/i.test(widget.label));
    if (visitors?.history?.length || pageViews?.history?.length) {
      const visitorHistory = visitors?.history?.length ? visitors.history : [Number(visitors?.value || 0)];
      const viewHistory = pageViews?.history?.length ? pageViews.history : [Number(pageViews?.value || 0)];
      const len = Math.min(days, Math.max(visitorHistory.length, viewHistory.length));
      return Array.from({ length: len }, (_, i) => ({
        date: dateNDaysAgo(len - i - 1),
        visitors: Math.round(Number(visitorHistory[visitorHistory.length - len + i] ?? visitorHistory.at(-1) ?? 0)),
        pageViews: Math.round(Number(viewHistory[viewHistory.length - len + i] ?? viewHistory.at(-1) ?? 0)),
      }));
    }

    const data = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = dateNDaysAgo(i);
      // Weekend dip
      const dayOfWeek = new Date(date).getDay();
      const weekendFactor = (dayOfWeek === 0 || dayOfWeek === 6) ? 0.7 : 1.0;

      const visitors = Math.round(vary(1600 * weekendFactor, 0.15));
      const pageViews = Math.round(visitors * vary(2.9, 0.1));

      data.push({ date, visitors, pageViews });
    }
    return data;
  }

  /** Social media metrics. */
  getSocialMetrics() {
    const widgets = this.getWidgets().filter(widget => /social|followers|subscriber|twitter|instagram|youtube|linkedin/i.test(`${widget.label} ${widget.kind}`));
    if (widgets.length) {
      return Object.fromEntries(widgets.map(widget => [
        widget.id,
        {
          followers: Math.round(Number(widget.value || 0)),
          engagement: Number(widget.trend || 0),
          source: widget.source,
        },
      ]));
    }

    return {
      twitter: {
        followers: Math.round(vary(4_230, 0.02)),
        engagement: +vary(3.8, 0.15).toFixed(1),
        tweets: randomInt(12, 28),
        impressions: Math.round(vary(89_000, 0.1)),
      },
      instagram: {
        followers: Math.round(vary(5_620, 0.02)),
        likes: Math.round(vary(12_400, 0.08)),
        posts: randomInt(8, 18),
        reachRate: +vary(22.5, 0.1).toFixed(1),
      },
      youtube: {
        subscribers: Math.round(vary(2_990, 0.02)),
        views: Math.round(vary(34_700, 0.1)),
        videos: randomInt(3, 8),
        watchTime: `${Math.round(vary(1_240, 0.12))}h`,
      },
      linkedin: {
        followers: Math.round(vary(1_850, 0.03)),
        engagement: +vary(5.2, 0.12).toFixed(1),
        posts: randomInt(6, 14),
      },
    };
  }

  /** Revenue / orders data for chart. */
  getRevenueData(days = 30) {
    const revenue = this.getWidgets().find(widget => /revenue|sales|mrr|arr/i.test(widget.label));
    if (revenue?.history?.length) {
      const history = revenue.history.slice(-days);
      return history.map((value, i) => ({
        date: dateNDaysAgo(history.length - i - 1),
        revenue: Number(value || 0),
        orders: Math.max(0, Math.round(Number(value || 0) / 80)),
      }));
    }

    const data = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = dateNDaysAgo(i);
      const dayOfWeek = new Date(date).getDay();
      const weekendFactor = (dayOfWeek === 0 || dayOfWeek === 6) ? 0.65 : 1.0;

      const revenue = +vary(950 * weekendFactor, 0.2).toFixed(2);
      const orders = Math.round(vary(24 * weekendFactor, 0.2));

      data.push({ date, revenue, orders });
    }
    return data;
  }

  /** Top pages data. */
  getTopPages() {
    const pages = [
      { page: '/',              views: vary(18_200, 0.05), avgTime: '1m 42s' },
      { page: '/dashboard',     views: vary(12_800, 0.05), avgTime: '3m 15s' },
      { page: '/graph',         views: vary(9_450, 0.06),  avgTime: '4m 08s' },
      { page: '/analytics',     views: vary(7_320, 0.06),  avgTime: '2m 53s' },
      { page: '/files',         views: vary(6_100, 0.07),  avgTime: '2m 11s' },
      { page: '/settings',      views: vary(3_840, 0.08),  avgTime: '1m 27s' },
      { page: '/hermes',        views: vary(5_670, 0.06),  avgTime: '5m 02s' },
      { page: '/docs',          views: vary(4_190, 0.07),  avgTime: '3m 44s' },
    ];

    return pages
      .map(p => ({ ...p, views: Math.round(p.views) }))
      .sort((a, b) => b.views - a.views);
  }

  /** Convert analytics data sources into graph nodes. */
  getAnalyticsNodes() {
    const widgets = this.getWidgets();
    if (widgets.length) {
      return widgets.map((widget, i) => ({
        id: `analytics-${widget.id}`,
        label: widget.label,
        type: 'analytics',
        size: vary(18 + Math.min(8, Math.abs(Number(widget.trend || 0))), 0.1),
        color: widget.color,
        x: Math.cos((2 * Math.PI * i) / widgets.length) * 150,
        y: Math.sin((2 * Math.PI * i) / widgets.length) * 150,
        metadata: {
          source: widget.source,
          kind: widget.kind,
          value: widget.value,
          trend: widget.trend,
        },
      }));
    }

    const sources = [
      { name: 'Google Analytics',  type: 'analytics', color: '#ff3131' },
      { name: 'Social Tracker',    type: 'analytics', color: '#ff6ec7' },
      { name: 'Revenue Monitor',   type: 'analytics', color: '#ffd700' },
      { name: 'Traffic Sensor',    type: 'analytics', color: '#00bfff' },
      { name: 'SEO Scanner',       type: 'analytics', color: '#39ff14' },
    ];

    return sources.map((s, i) => ({
      id: `analytics-${i}`,
      label: s.name,
      type: s.type,
      size: vary(18, 0.2),
      color: s.color,
      x: Math.cos((2 * Math.PI * i) / sources.length) * 150,
      y: Math.sin((2 * Math.PI * i) / sources.length) * 150,
      metadata: {
        source: true,
        category: 'analytics',
      },
    }));
  }

  getWidgets() {
    if (!this.db?.getAnalyticsWidgets) return [];
    return this.db.getAnalyticsWidgets();
  }

  upsertWidget(widget) {
    if (!this.db?.upsertAnalyticsWidget) {
      throw new Error('Analytics widget storage is not available');
    }
    return this.db.upsertAnalyticsWidget(widget);
  }
}

export default AnalyticsEngine;
