// MediaPipe Pose の33点の定義
export const N = 33;

export const LM = {
  NOSE: 0,
  L_EYE_INNER: 1, L_EYE: 2, L_EYE_OUTER: 3,
  R_EYE_INNER: 4, R_EYE: 5, R_EYE_OUTER: 6,
  L_EAR: 7, R_EAR: 8,
  MOUTH_L: 9, MOUTH_R: 10,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_PINKY: 17, R_PINKY: 18,
  L_INDEX: 19, R_INDEX: 20,
  L_THUMB: 21, R_THUMB: 22,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
  L_HEEL: 29, R_HEEL: 30,
  L_FOOT: 31, R_FOOT: 32,
};

// 左右を入れ替えたときの対応（左右反転した動画の補正に使う）
export const MIRROR_INDEX = [
  0, 4, 5, 6, 1, 2, 3, 8, 7, 10, 9,
  12, 11, 14, 13, 16, 15, 18, 17, 20, 19, 22, 21,
  24, 23, 26, 25, 28, 27, 30, 29, 32, 31,
];

// 各点が体のどちら側か（L=左, R=右, C=中央）
export const SIDE = [
  'C', 'L', 'L', 'L', 'R', 'R', 'R', 'L', 'R', 'L', 'R',
  'L', 'R', 'L', 'R', 'L', 'R', 'L', 'R', 'L', 'R', 'L', 'R',
  'L', 'R', 'L', 'R', 'L', 'R', 'L', 'R', 'L', 'R',
];

// 骨格表示用の線
export const BONES = [
  [11, 12], [11, 23], [12, 24], [23, 24],
  [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
  [0, 2], [2, 7], [0, 5], [5, 8], [9, 10],
];

// 骨格表示で点を描く関節（顔の細かい点は省く）
export const SKELETON_POINTS = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];

export const COLORS = {
  L: '#4ea1ff',
  R: '#ff8a3d',
  C: '#e8ecf3',
  ghost: '#b794f6',
};

export function boneSide(a, b) {
  const sa = SIDE[a], sb = SIDE[b];
  if (sa === sb) return sa;
  return 'C';
}
