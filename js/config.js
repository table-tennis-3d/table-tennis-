// ライブラリとAIモデルの読み込み先（バージョンは固定）
export const MEDIAPIPE_VERSION = '0.10.21';
export const MEDIAPIPE_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;

const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker';
export const MODEL_URLS = {
  lite: `${MODEL_BASE}/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
  full: `${MODEL_BASE}/pose_landmarker_full/float16/1/pose_landmarker_full.task`,
  heavy: `${MODEL_BASE}/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task`,
};

// 解析できる長さの上限（秒）。長すぎると時間とメモリを使いすぎるため。
export const MAX_ANALYZE_SECONDS = 60;
export const RECOMMENDED_SECONDS = 20;
