// 時系列グラフ（canvas）。カーソル線とタップでの移動に対応。
import { COLORS } from './landmarks.js';

const PAD = { l: 40, r: 10, t: 10, b: 20 };

export class TimeChart {
  /**
   * @param {HTMLElement} parent
   * @param {{title:string, sub?:string, unit:string, decimals?:number,
   *   series:{label:string, side?:string, color?:string, data:Float32Array, times?:Float64Array, dashed?:boolean}[],
   *   times:Float64Array, range:[number,number], events?:number[], valid?:Uint8Array, onSeek?:(t:number)=>void}} opts
   */
  constructor(parent, opts) {
    this.opts = opts;
    this.cursor = opts.range[0];
    this.el = document.createElement('div');
    this.el.className = 'chart';
    const legend = opts.series.map((s) => {
      const c = seriesColor(s);
      return `<span><i style="background:${c};${s.dashed ? 'opacity:.6' : ''}"></i>${escapeHtml(s.label)}</span>`;
    }).join('');
    this.el.innerHTML = `
      <div class="chart-head">
        <div class="chart-title">${escapeHtml(opts.title)} <span class="chart-sub">${escapeHtml(opts.unit)}${opts.sub ? '・' + escapeHtml(opts.sub) : ''}</span></div>
        <div class="chart-legend">${legend}</div>
      </div>
      <canvas role="img" aria-label="${escapeHtml(opts.title)}のグラフ"></canvas>`;
    parent.appendChild(this.el);
    this.canvas = this.el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.layer = document.createElement('canvas');

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas);

    let dragging = false;
    const seek = (e) => {
      const r = this.canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const [t0, t1] = this.opts.range;
      const w = r.width - PAD.l - PAD.r;
      const t = t0 + ((x - PAD.l) / Math.max(1, w)) * (t1 - t0);
      this.opts.onSeek?.(Math.max(t0, Math.min(t1, t)));
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      seek(e);
    });
    this.canvas.addEventListener('pointermove', (e) => { if (dragging) seek(e); });
    const end = () => { dragging = false; };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
  }

  destroy() {
    this.ro.disconnect();
    this.el.remove();
  }

  setCursor(t) {
    if (t === this.cursor) return;
    this.cursor = t;
    this.paint();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
      this.layer.width = w; this.layer.height = h;
    }
    this.dpr = dpr;
    this.cssW = r.width; this.cssH = r.height;
    this.drawStatic();
    this.paint();
  }

  // 目盛り・線など、カーソル以外の部分を描いておく
  drawStatic() {
    const { opts } = this;
    const ctx = this.layer.getContext('2d');
    const dpr = this.dpr, W = this.cssW, H = this.cssH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // 値の範囲
    let lo = Infinity, hi = -Infinity;
    for (const s of opts.series) {
      for (let i = 0; i < s.data.length; i++) {
        const v = s.data[i];
        if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
      }
    }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    const minSpan = opts.unit === 'm/s' ? 1 : opts.unit === 'cm' ? 10 : 10;
    if (hi - lo < minSpan) { const c = (hi + lo) / 2; lo = c - minSpan / 2; hi = c + minSpan / 2; }
    const padV = (hi - lo) * 0.08;
    lo -= padV; hi += padV;
    if (opts.unit === 'm/s' && lo < 0) lo = 0;
    this.yLo = lo; this.yHi = hi;

    const [t0, t1] = opts.range;
    const x = (t) => PAD.l + ((t - t0) / Math.max(1e-6, t1 - t0)) * (W - PAD.l - PAD.r);
    const y = (v) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
    this.x = x; this.y = y;

    ctx.font = '11px system-ui, -apple-system, sans-serif';
    ctx.textBaseline = 'middle';

    // 検出できなかった区間
    if (opts.valid && opts.times) {
      ctx.fillStyle = 'rgba(248,113,113,.10)';
      const tm = opts.times;
      for (let i = 0; i < tm.length; i++) {
        if (opts.valid[i]) continue;
        const dt = tm.length > 1 ? (tm[1] - tm[0]) : 0.033;
        ctx.fillRect(x(tm[i] - dt / 2), PAD.t, Math.max(1, x(tm[i] + dt / 2) - x(tm[i] - dt / 2)), H - PAD.t - PAD.b);
      }
    }

    // 横の目盛り
    const step = niceStep((hi - lo) / 3);
    ctx.strokeStyle = 'rgba(255,255,255,.07)';
    ctx.fillStyle = '#7b8496';
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(PAD.l, yy); ctx.lineTo(W - PAD.r, yy); ctx.stroke();
      ctx.fillText(formatTick(v, step), PAD.l - 6, yy);
    }
    // 0の線
    if (lo < 0 && hi > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,.18)';
      const yy = Math.round(y(0)) + 0.5;
      ctx.beginPath(); ctx.moveTo(PAD.l, yy); ctx.lineTo(W - PAD.r, yy); ctx.stroke();
    }
    // 時間の目盛り
    const tStep = niceStep((t1 - t0) / Math.max(2, Math.floor((W - PAD.l) / 70)));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#6b7385';
    for (let t = Math.ceil(t0 / tStep) * tStep; t <= t1 + 1e-9; t += tStep) {
      ctx.fillText(`${formatTick(t, tStep)}s`, x(t), H - 5);
    }

    // スイングの山場
    if (opts.events?.length) {
      ctx.strokeStyle = 'rgba(45,212,191,.55)';
      ctx.setLineDash([3, 3]);
      for (const t of opts.events) {
        const xx = Math.round(x(t)) + 0.5;
        ctx.beginPath(); ctx.moveTo(xx, PAD.t); ctx.lineTo(xx, H - PAD.b); ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // 線
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const s of opts.series) {
      const tm = s.times || opts.times;
      ctx.strokeStyle = seriesColor(s);
      ctx.globalAlpha = s.dashed ? 0.75 : 1;
      ctx.lineWidth = s.dashed ? 1.5 : 2;
      ctx.setLineDash(s.dashed ? [5, 4] : []);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < s.data.length; i++) {
        const v = s.data[i];
        const tt = tm[i];
        if (!Number.isFinite(v) || tt < t0 - 1e-6 || tt > t1 + 1e-6) { started = false; continue; }
        const xx = x(tt), yy = y(v);
        if (!started) { ctx.moveTo(xx, yy); started = true; } else ctx.lineTo(xx, yy);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  paint() {
    if (!this.dpr) return;
    const ctx = this.ctx;
    const { dpr, cssW: W, cssH: H } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.layer, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const t = this.cursor;
    const [t0, t1] = this.opts.range;
    if (t < t0 - 1e-6 || t > t1 + 1e-6) return;
    const xx = Math.round(this.x(t)) + 0.5;
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(xx, PAD.t); ctx.lineTo(xx, H - PAD.b); ctx.stroke();
    // 各線の現在値の点
    for (const s of this.opts.series) {
      const v = valueAt(s.data, s.times || this.opts.times, t);
      if (!Number.isFinite(v)) continue;
      ctx.fillStyle = seriesColor(s);
      ctx.beginPath(); ctx.arc(xx, this.y(v), s.dashed ? 2.5 : 3.5, 0, Math.PI * 2); ctx.fill();
    }
  }
}

export function valueAt(data, times, t) {
  const n = data.length;
  if (!n) return NaN;
  if (t <= times[0]) return times[0] - t < 0.05 ? data[0] : NaN;
  if (t >= times[n - 1]) return t - times[n - 1] < 0.05 ? data[n - 1] : NaN;
  const dt = (times[n - 1] - times[0]) / Math.max(1, n - 1);
  const f = (t - times[0]) / dt;
  const i0 = Math.floor(f), i1 = Math.min(n - 1, i0 + 1);
  const a = f - i0;
  return data[i0] * (1 - a) + data[i1] * a;
}

function seriesColor(s) {
  if (s.color) return s.color;
  if (s.side === 'L') return COLORS.L;
  if (s.side === 'R') return COLORS.R;
  return COLORS.C;
}

function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  const m = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  return m * p;
}

function formatTick(v, step) {
  const d = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  const s = v.toFixed(d);
  return s === '-0' ? '0' : s;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
