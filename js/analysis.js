// 3Dの動きから角度・速さなどを計算する
import { N, LM } from './landmarks.js';
import { gaussian1D } from './motion.js';

const S = N * 3;
const DEG = 180 / Math.PI;

export const SIDE_NAME = { L: '左', R: '右' };

// グラフのまとまり
export const CHART_GROUPS = [
  {
    id: 'elbow', title: '肘の角度', unit: '°', sub: '180°で腕がまっすぐ', defaultOn: true,
    series: [{ key: 'elbowL', label: '左', side: 'L' }, { key: 'elbowR', label: '右', side: 'R' }],
  },
  {
    id: 'rotation', title: '腰と肩の回転', unit: '°', sub: '＋が左回り／平均の向きを0°', defaultOn: true,
    series: [
      { key: 'pelvisYaw', label: '腰', color: '#5eead4' },
      { key: 'shoulderYaw', label: '肩', color: '#fcd34d' },
      { key: 'xFactor', label: '捻転差（肩−腰）', color: '#f472b6' },
    ],
  },
  {
    id: 'speed', title: '手首の速さ', unit: 'm/s', sub: '体の中心から見た速さ（目安）', defaultOn: true, decimals: 1,
    series: [{ key: 'wristSpeedL', label: '左', side: 'L' }, { key: 'wristSpeedR', label: '右', side: 'R' }],
  },
  {
    id: 'knee', title: '膝の角度', unit: '°', sub: '180°で脚がまっすぐ',
    series: [{ key: 'kneeL', label: '左', side: 'L' }, { key: 'kneeR', label: '右', side: 'R' }],
  },
  {
    id: 'armpit', title: '脇の開き', unit: '°', sub: '上腕と体の側面の角度',
    series: [{ key: 'armpitL', label: '左', side: 'L' }, { key: 'armpitR', label: '右', side: 'R' }],
  },
  {
    id: 'hip', title: '股関節の角度', unit: '°', sub: '上体と太ももの角度',
    series: [{ key: 'hipL', label: '左', side: 'L' }, { key: 'hipR', label: '右', side: 'R' }],
  },
  {
    id: 'trunk', title: '上体の傾き', unit: '°', sub: '0°で直立・骨盤の向きが基準',
    series: [
      { key: 'trunkLean', label: '前傾（＋前／−後ろ）', color: '#5eead4' },
      { key: 'trunkSide', label: '横の傾き（＋右／−左）', color: '#c4b5fd' },
    ],
  },
  {
    id: 'height', title: '腰の高さ', unit: 'cm', sub: '床からの高さ',
    series: [{ key: 'hipHeight', label: '腰', color: '#5eead4' }],
  },
  {
    id: 'stance', title: 'スタンス幅', unit: 'cm', sub: '左右の足首の間隔',
    series: [{ key: 'stance', label: '幅', color: '#5eead4' }],
  },
];

// 「この瞬間の数値」に出すカード
export function metricCards(handedness) {
  const D = handedness === 'left' ? 'L' : 'R';
  const yawSub = '＋左回り／−右回り';
  return [
    { key: `elbow${D}`, label: `${SIDE_NAME[D]}肘の角度`, unit: '°', side: D, dominant: true },
    { key: `wristSpeed${D}`, label: `${SIDE_NAME[D]}手首の速さ`, unit: 'm/s', side: D, dominant: true, decimals: 1 },
    { key: `armpit${D}`, label: `${SIDE_NAME[D]}脇の開き`, unit: '°', side: D, dominant: true },
    { key: 'xFactor', label: '捻転差（肩−腰）', unit: '°', signed: true, sub: yawSub },
    { key: 'pelvisYaw', label: '腰の回転', unit: '°', signed: true, sub: yawSub },
    { key: 'shoulderYaw', label: '肩の回転', unit: '°', signed: true, sub: yawSub },
    { key: 'trunkLean', label: '上体の前傾', unit: '°', signed: true, sub: '＋前／−後ろ' },
    { key: 'trunkSide', label: '上体の横の傾き', unit: '°', signed: true, sub: '＋右／−左' },
    { key: 'kneeL', label: '左膝の角度', unit: '°', side: 'L' },
    { key: 'kneeR', label: '右膝の角度', unit: '°', side: 'R' },
    { key: 'hipHeight', label: '腰の高さ', unit: 'cm' },
    { key: 'stance', label: 'スタンス幅', unit: 'cm' },
  ];
}

/**
 * @param {object} motion buildMotion の結果
 * @param {{timeScale?: number}} opts timeScale: 実時間/動画時間（1/4スローなら0.25）
 */
export function computeMetrics(motion, { timeScale = 1 } = {}) {
  const { n, fps, pos } = motion;
  const keys = ['elbowL', 'elbowR', 'kneeL', 'kneeR', 'armpitL', 'armpitR', 'hipL', 'hipR',
    'trunkLean', 'trunkSide', 'pelvisYaw', 'shoulderYaw', 'xFactor', 'wristSpeedL', 'wristSpeedR', 'hipHeight', 'stance'];
  const m = {};
  for (const k of keys) m[k] = new Float32Array(n);

  // 基準の向き（クリップ全体の平均の「右→左」方向）
  const yaw = motion.facingYaw;
  const refX = Math.cos(yaw), refZ = -Math.sin(yaw);

  for (let i = 0; i < n; i++) {
    const o = i * S;
    const px = (j) => pos[o + j * 3], py = (j) => pos[o + j * 3 + 1], pz = (j) => pos[o + j * 3 + 2];

    m.elbowL[i] = angleAt(pos, o, LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST);
    m.elbowR[i] = angleAt(pos, o, LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST);
    m.kneeL[i] = angleAt(pos, o, LM.L_HIP, LM.L_KNEE, LM.L_ANKLE);
    m.kneeR[i] = angleAt(pos, o, LM.R_HIP, LM.R_KNEE, LM.R_ANKLE);
    m.armpitL[i] = angleAt(pos, o, LM.L_ELBOW, LM.L_SHOULDER, LM.L_HIP);
    m.armpitR[i] = angleAt(pos, o, LM.R_ELBOW, LM.R_SHOULDER, LM.R_HIP);
    m.hipL[i] = angleAt(pos, o, LM.L_SHOULDER, LM.L_HIP, LM.L_KNEE);
    m.hipR[i] = angleAt(pos, o, LM.R_SHOULDER, LM.R_HIP, LM.R_KNEE);

    // 腰・肩のライン（右→左）
    const hx = px(LM.L_HIP) - px(LM.R_HIP), hz = pz(LM.L_HIP) - pz(LM.R_HIP);
    const sx = px(LM.L_SHOULDER) - px(LM.R_SHOULDER), sz = pz(LM.L_SHOULDER) - pz(LM.R_SHOULDER);
    m.pelvisYaw[i] = signedYaw(refX, refZ, hx, hz);
    m.shoulderYaw[i] = signedYaw(refX, refZ, sx, sz);
    m.xFactor[i] = signedYaw(hx, hz, sx, sz);

    // 上体の傾き（背骨を骨盤の前後・左右の方向に分けて、それぞれ鉛直からの角度にする）
    const hmx = (px(LM.L_HIP) + px(LM.R_HIP)) / 2, hmy = (py(LM.L_HIP) + py(LM.R_HIP)) / 2, hmz = (pz(LM.L_HIP) + pz(LM.R_HIP)) / 2;
    const smx = (px(LM.L_SHOULDER) + px(LM.R_SHOULDER)) / 2, smy = (py(LM.L_SHOULDER) + py(LM.R_SHOULDER)) / 2, smz = (pz(LM.L_SHOULDER) + pz(LM.R_SHOULDER)) / 2;
    const vx = smx - hmx, vy = smy - hmy, vz = smz - hmz;
    const hl = Math.hypot(hx, hz) || 1;
    const fwd = (-hz * vx + hx * vz) / hl; // 骨盤の正面 (-hz, 0, hx) 方向の成分
    const right = (-hx * vx - hz * vz) / hl; // 右方向 (-hx, 0, -hz) の成分
    m.trunkLean[i] = Math.atan2(fwd, vy) * DEG;
    m.trunkSide[i] = Math.atan2(right, vy) * DEG;

    m.hipHeight[i] = hmy * 100;
    m.stance[i] = Math.hypot(px(LM.L_ANKLE) - px(LM.R_ANKLE), pz(LM.L_ANKLE) - pz(LM.R_ANKLE)) * 100;
  }

  unwrapDegrees(m.pelvisYaw);
  unwrapDegrees(m.shoulderYaw);
  unwrapDegrees(m.xFactor);

  // 手首の速さ（腰の中心に対する相対速度、実時間に換算）
  const dt = timeScale / fps;
  for (const [key, w] of [['wristSpeedL', LM.L_WRIST], ['wristSpeedR', LM.R_WRIST]]) {
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      if (a === b) continue;
      const ra = relToHip(pos, a, w), rb = relToHip(pos, b, w);
      raw[i] = Math.hypot(rb[0] - ra[0], rb[1] - ra[1], rb[2] - ra[2]) / ((b - a) * dt);
    }
    // 微分で増えるノイズを軽くならす（約25ミリ秒）
    m[key] = gaussian1D(raw, n, 0.025 * fps);
  }
  return m;
}

/** 利き手の手首が速くなった瞬間（スイングの山場）を探す */
export function findSwings(metrics, motion, { handedness = 'right', timeScale = 1 } = {}) {
  const sp = handedness === 'left' ? metrics.wristSpeedL : metrics.wristSpeedR;
  const n = sp.length;
  let max = 0;
  for (let i = 0; i < n; i++) if (motion.valid[i] && sp[i] > max) max = sp[i];
  const thresh = Math.max(max * 0.55, 1.2);
  const minSep = Math.max(2, Math.round((0.45 / timeScale) * motion.fps));
  const cands = [];
  for (let i = 1; i < n - 1; i++) {
    if (!motion.valid[i]) continue;
    if (sp[i] >= thresh && sp[i] >= sp[i - 1] && sp[i] > sp[i + 1]) cands.push(i);
  }
  cands.sort((a, b) => sp[b] - sp[a]);
  const kept = [];
  for (const c of cands) if (kept.every((k) => Math.abs(k - c) >= minSep)) kept.push(c);
  kept.sort((a, b) => a - b);
  return kept.map((i) => ({ index: i, t: motion.times[i], speed: sp[i] }));
}

/** クリップ全体のまとめ */
export function summarize(metrics, motion, { handedness = 'right' } = {}) {
  const D = handedness === 'left' ? 'L' : 'R';
  const valid = motion.valid;
  const argExt = (arr, cmp, absolute = false) => {
    let best = -1, bv = 0;
    for (let i = 0; i < arr.length; i++) {
      if (!valid[i]) continue;
      const v = absolute ? Math.abs(arr[i]) : arr[i];
      if (best < 0 || cmp(v, bv)) { best = i; bv = v; }
    }
    return best;
  };
  const iSpeed = argExt(metrics[`wristSpeed${D}`], (a, b) => a > b);
  const iX = argExt(metrics.xFactor, (a, b) => a > b, true);
  const iKneeL = argExt(metrics.kneeL, (a, b) => a < b);
  const iKneeR = argExt(metrics.kneeR, (a, b) => a < b);
  const elbow = metrics[`elbow${D}`];
  const iElbowMin = argExt(elbow, (a, b) => a < b);
  const iElbowMax = argExt(elbow, (a, b) => a > b);
  const kneeSide = (iKneeL >= 0 && (iKneeR < 0 || metrics.kneeL[iKneeL] < metrics.kneeR[iKneeR])) ? 'L' : 'R';
  const iKnee = kneeSide === 'L' ? iKneeL : iKneeR;
  const t = (i) => (i >= 0 ? motion.times[i] : null);
  return {
    dominant: D,
    maxSpeed: { value: iSpeed >= 0 ? metrics[`wristSpeed${D}`][iSpeed] : 0, t: t(iSpeed) },
    maxXFactor: { value: iX >= 0 ? metrics.xFactor[iX] : 0, t: t(iX) },
    minKnee: { value: iKnee >= 0 ? metrics[`knee${kneeSide}`][iKnee] : 0, t: t(iKnee), side: kneeSide },
    elbowRange: {
      min: iElbowMin >= 0 ? elbow[iElbowMin] : 0, max: iElbowMax >= 0 ? elbow[iElbowMax] : 0,
      tMin: t(iElbowMin), tMax: t(iElbowMax),
    },
    validRatio: motion.validRatio,
  };
}

// ---------- 内部処理 ----------

function angleAt(P, o, a, b, c) {
  const ax = P[o + a * 3] - P[o + b * 3], ay = P[o + a * 3 + 1] - P[o + b * 3 + 1], az = P[o + a * 3 + 2] - P[o + b * 3 + 2];
  const cx = P[o + c * 3] - P[o + b * 3], cy = P[o + c * 3 + 1] - P[o + b * 3 + 1], cz = P[o + c * 3 + 2] - P[o + b * 3 + 2];
  const la = Math.hypot(ax, ay, az), lc = Math.hypot(cx, cy, cz);
  if (la < 1e-6 || lc < 1e-6) return 0;
  return Math.acos(clamp((ax * cx + ay * cy + az * cz) / (la * lc), -1, 1)) * DEG;
}

// 水平面で ref から cur への回転角（上から見て左回りが＋）
function signedYaw(rx, rz, cx, cz) {
  return Math.atan2(rz * cx - rx * cz, rx * cx + rz * cz) * DEG;
}

function unwrapDegrees(arr) {
  for (let i = 1; i < arr.length; i++) {
    let d = arr[i] - arr[i - 1];
    while (d > 180) { arr[i] -= 360; d -= 360; }
    while (d < -180) { arr[i] += 360; d += 360; }
  }
}

function relToHip(P, i, j) {
  const o = i * S;
  return [
    P[o + j * 3] - (P[o + LM.L_HIP * 3] + P[o + LM.R_HIP * 3]) / 2,
    P[o + j * 3 + 1] - (P[o + LM.L_HIP * 3 + 1] + P[o + LM.R_HIP * 3 + 1]) / 2,
    P[o + j * 3 + 2] - (P[o + LM.L_HIP * 3 + 2] + P[o + LM.R_HIP * 3 + 2]) / 2,
  ];
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
