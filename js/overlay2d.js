// 元動画の上に骨格を重ねて描く
import { BONES, SKELETON_POINTS, SIDE, COLORS, N, boneSide } from './landmarks.js';

export class Overlay2D {
  constructor(canvas, video) {
    this.canvas = canvas;
    this.video = video;
    this.ctx = canvas.getContext('2d');
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.w = r.width; this.h = r.height;
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W; this.canvas.height = H;
    }
    if (this.last) this.draw(...this.last);
  }

  // object-fit: contain の実際の映像の位置
  contentRect() {
    const vw = this.video.videoWidth || 16, vh = this.video.videoHeight || 9;
    const s = Math.min(this.w / vw, this.h / vh);
    const cw = vw * s, ch = vh * s;
    return { x: (this.w - cw) / 2, y: (this.h - ch) / 2, w: cw, h: ch };
  }

  clear() {
    this.last = null;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * @param {Float32Array|null} img 33点 × (u, v)（0〜1）
   * @param {Float32Array|null} vis 33点の見え具合
   * @param {{stride?: number, dim?: boolean}} opts
   */
  draw(img, vis, opts = {}) {
    this.last = [img, vis, opts];
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!img) return;
    const stride = opts.stride || 2;
    const r = this.contentRect();
    const scale = Math.max(0.7, Math.min(1.6, r.h / 420));
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const X = (j) => r.x + img[j * stride] * r.w;
    const Y = (j) => r.y + img[j * stride + 1] * r.h;
    const alpha = (j) => (vis ? Math.max(0.25, Math.min(1, vis[j] * 1.2)) : 1);

    ctx.lineCap = 'round';
    ctx.globalAlpha = opts.dim ? 0.5 : 1;
    for (const [a, b] of BONES) {
      ctx.strokeStyle = COLORS[boneSide(a, b)];
      ctx.globalAlpha = (opts.dim ? 0.5 : 1) * Math.min(alpha(a), alpha(b));
      ctx.lineWidth = 3 * scale;
      ctx.beginPath();
      ctx.moveTo(X(a), Y(a));
      ctx.lineTo(X(b), Y(b));
      ctx.stroke();
    }
    for (const j of SKELETON_POINTS) {
      if (j >= N) continue;
      ctx.globalAlpha = (opts.dim ? 0.5 : 1) * alpha(j);
      ctx.fillStyle = '#0b0d11';
      ctx.beginPath(); ctx.arc(X(j), Y(j), 4.2 * scale, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COLORS[SIDE[j]];
      ctx.beginPath(); ctx.arc(X(j), Y(j), 2.8 * scale, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  destroy() { this.ro.disconnect(); }
}
