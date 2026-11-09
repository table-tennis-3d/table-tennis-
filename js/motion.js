// 推定結果（1コマごとの33点）を、3D表示と分析に使える「動き」データに整える
import { N, LM, MIRROR_INDEX } from './landmarks.js';

// なめらかさ設定 → ガウシアンの幅（秒）
const SMOOTHING_SIGMA = [0, 0.018, 0.033, 0.055];
// かかと・つま先を床からどれだけ浮かせるか（人形の足の厚み分）
const FOOT_CLEARANCE = 0.012;
const FOOT_POINTS = [LM.L_HEEL, LM.R_HEEL, LM.L_FOOT, LM.R_FOOT];
const S = N * 3; // 1コマあたりの3D座標の数

/**
 * @param {object} raw 推定結果 { fps, start, frames: [{t, world, image, vis}] }
 * @param {{mirror?:boolean, smoothing?:number, floor?:boolean}} opts
 */
export function buildMotion(raw, opts = {}) {
  const fps = raw.fps;
  const frames = raw.frames;
  const n = frames.length;
  const mirror = !!opts.mirror;

  const pos = new Float32Array(n * S);
  const img = new Float32Array(n * N * 2);
  const vis = new Float32Array(n * N);
  const valid = new Uint8Array(n);
  const times = new Float64Array(n);
  let validCount = 0;

  for (let i = 0; i < n; i++) {
    const f = frames[i];
    times[i] = f.t;
    if (!f.world) continue;
    valid[i] = 1;
    validCount++;
    for (let j = 0; j < N; j++) {
      const src = mirror ? MIRROR_INDEX[j] : j;
      const x = f.world[src * 3], y = f.world[src * 3 + 1], z = f.world[src * 3 + 2];
      // MediaPipe（x右・y下・z奥）→ three.js（x右・y上・z手前）
      pos[i * S + j * 3] = mirror ? -x : x;
      pos[i * S + j * 3 + 1] = -y;
      pos[i * S + j * 3 + 2] = -z;
      // 画像上の位置は元の向きのまま（表示側で左右反転する）
      img[(i * N + j) * 2] = f.image[src * 3];
      img[(i * N + j) * 2 + 1] = f.image[src * 3 + 1];
      vis[i * N + j] = f.vis[src];
    }
  }

  if (validCount === 0) {
    const err = new Error('人物を検出できませんでした');
    err.code = 'NO_PERSON';
    throw err;
  }

  fillGaps(pos, S, valid, n);
  fillGaps(img, N * 2, valid, n);
  fillGaps(vis, N, valid, n);

  const sigma = SMOOTHING_SIGMA[opts.smoothing ?? 2] ?? SMOOTHING_SIGMA[2];
  let P = pos;
  let I = img;
  if (sigma > 0) {
    const sf = sigma * fps;
    P = smoothJoints(pos, n, 3, sf, vis, valid);
    I = smoothJoints(img, n, 2, sf, vis, valid);
  }

  // 床の高さをそろえる（腰が原点のデータなので、しゃがむと足が上がってしまうのを直す）
  const footMin = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = Infinity;
    for (const j of FOOT_POINTS) m = Math.min(m, P[i * S + j * 3 + 1]);
    footMin[i] = m;
  }
  let offsets;
  if (opts.floor !== false) {
    const smoothed = gaussian1D(footMin, n, 0.12 * fps);
    offsets = smoothed.map((m) => FOOT_CLEARANCE - m);
  } else {
    const med = median(Array.from(footMin));
    offsets = new Float32Array(n).fill(FOOT_CLEARANCE - med);
  }
  for (let i = 0; i < n; i++) {
    const o = offsets[i];
    for (let j = 0; j < N; j++) P[i * S + j * 3 + 1] += o;
  }

  const facing = averageFacing(P, n, valid);

  return {
    n,
    fps,
    start: times[0],
    end: times[n - 1],
    times,
    pos: P,
    img: I,
    vis,
    valid,
    validRatio: validCount / n,
    facingYaw: facing.yaw,
    hipHeight: facing.hipHeight,
    videoWidth: raw.videoWidth || 0,
    videoHeight: raw.videoHeight || 0,
  };
}

/** 時刻tの姿勢を補間して out(Float32Array(99)) に書き込む。範囲外は端のコマ。 */
export function samplePose(motion, t, out) {
  const { n, fps, start, pos } = motion;
  let f = (t - start) * fps;
  if (!(f > 0)) f = 0;
  if (f > n - 1) f = n - 1;
  const i0 = Math.floor(f);
  const i1 = Math.min(n - 1, i0 + 1);
  const a = f - i0;
  const o0 = i0 * S, o1 = i1 * S;
  for (let k = 0; k < S; k++) out[k] = pos[o0 + k] * (1 - a) + pos[o1 + k] * a;
  return out;
}

/** 時刻tの画像上の位置を補間して out(Float32Array(66)) に書き込む */
export function sampleImage(motion, t, out) {
  const { n, fps, start, img } = motion;
  let f = (t - start) * fps;
  if (!(f > 0)) f = 0;
  if (f > n - 1) f = n - 1;
  const i0 = Math.floor(f);
  const i1 = Math.min(n - 1, i0 + 1);
  const a = f - i0;
  const W = N * 2;
  for (let k = 0; k < W; k++) out[k] = img[i0 * W + k] * (1 - a) + img[i1 * W + k] * a;
  return out;
}

export function frameIndexAt(motion, t) {
  const f = Math.round((t - motion.start) * motion.fps);
  return Math.max(0, Math.min(motion.n - 1, f));
}

export function isValidAt(motion, t) {
  return motion.valid[frameIndexAt(motion, t)] === 1;
}

// ---------- 内部処理 ----------

// 検出できなかったコマを前後のコマから直線補間する
function fillGaps(arr, stride, valid, n) {
  let prev = -1;
  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    if (prev === -1 && i > 0) {
      for (let k = 0; k < i; k++) arr.copyWithin(k * stride, i * stride, i * stride + stride);
    } else if (prev >= 0 && i - prev > 1) {
      for (let k = prev + 1; k < i; k++) {
        const a = (k - prev) / (i - prev);
        for (let c = 0; c < stride; c++) {
          arr[k * stride + c] = arr[prev * stride + c] * (1 - a) + arr[i * stride + c] * a;
        }
      }
    }
    prev = i;
  }
  if (prev >= 0) {
    for (let k = prev + 1; k < n; k++) arr.copyWithin(k * stride, prev * stride, prev * stride + stride);
  }
}

// 見え具合（visibility）で重み付けした、時間方向のガウシアン平滑化（位相ずれなし）
function smoothJoints(arr, n, comps, sigmaFrames, vis, valid) {
  const out = new Float32Array(arr.length);
  const R = Math.max(1, Math.ceil(sigmaFrames * 3));
  const kern = new Float32Array(2 * R + 1);
  for (let k = -R; k <= R; k++) kern[k + R] = Math.exp(-0.5 * (k / sigmaFrames) ** 2);
  const stride = N * comps;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - R), hi = Math.min(n - 1, i + R);
    for (let j = 0; j < N; j++) {
      let ws = 0, a0 = 0, a1 = 0, a2 = 0;
      for (let ii = lo; ii <= hi; ii++) {
        const w = kern[ii - i + R] * (valid[ii] ? Math.max(vis[ii * N + j], 0.15) : 0.02);
        const o = ii * stride + j * comps;
        ws += w;
        a0 += w * arr[o];
        a1 += w * arr[o + 1];
        if (comps === 3) a2 += w * arr[o + 2];
      }
      const o = i * stride + j * comps;
      out[o] = a0 / ws;
      out[o + 1] = a1 / ws;
      if (comps === 3) out[o + 2] = a2 / ws;
    }
  }
  return out;
}

export function gaussian1D(arr, n, sigmaFrames) {
  const out = new Float32Array(n);
  if (sigmaFrames <= 0.01) { out.set(arr.subarray ? arr.subarray(0, n) : arr.slice(0, n)); return out; }
  const R = Math.max(1, Math.ceil(sigmaFrames * 3));
  for (let i = 0; i < n; i++) {
    let ws = 0, acc = 0;
    for (let ii = Math.max(0, i - R); ii <= Math.min(n - 1, i + R); ii++) {
      const w = Math.exp(-0.5 * ((ii - i) / sigmaFrames) ** 2);
      ws += w;
      acc += w * arr[ii];
    }
    out[i] = acc / ws;
  }
  return out;
}

function median(values) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// 体の正面の向き（腰と肩のラインから）をクリップ全体で平均する
function averageFacing(P, n, valid) {
  let fx = 0, fz = 0, hy = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    const o = i * S;
    // 右→左の向きのベクトル
    const hx = P[o + LM.L_HIP * 3] - P[o + LM.R_HIP * 3];
    const hz = P[o + LM.L_HIP * 3 + 2] - P[o + LM.R_HIP * 3 + 2];
    const sx = P[o + LM.L_SHOULDER * 3] - P[o + LM.R_SHOULDER * 3];
    const sz = P[o + LM.L_SHOULDER * 3 + 2] - P[o + LM.R_SHOULDER * 3 + 2];
    // 正面 = (右→左) × 上 = (-z, 0, x)
    fx += -(hz * 2 + sz);
    fz += hx * 2 + sx;
    hy += (P[o + LM.L_HIP * 3 + 1] + P[o + LM.R_HIP * 3 + 1]) / 2;
    cnt++;
  }
  const yaw = (fx === 0 && fz === 0) ? 0 : Math.atan2(fx, fz);
  return { yaw, hipHeight: cnt ? hy / cnt : 0.95 };
}
