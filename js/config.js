// ライブラリとAIモデルの読み込み先（バージョンは固定）
//
// 通常はCDN（jsDelivr / Google）から読み込む。ページ側で window.FORM3D_ASSETS を
// 先に定義しておくと、同じサーバーに置いたファイルを使う（外部に通信できない環境向け）。
//   window.FORM3D_ASSETS = {
//     wasmBase: './vendor/mediapipe/wasm',          // vision_wasm_internal.js / .wasm の場所
//     models: { lite: './vendor/models/lite.b64.txt', full: '...' },
//     modelFormat: 'base64',                        // モデルをBase64のテキストで置く場合
//   };
const local = (typeof window !== 'undefined' && window.FORM3D_ASSETS) || null;

export const MEDIAPIPE_VERSION = '0.10.21';
export const MEDIAPIPE_WASM = local?.wasmBase || `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
// 同じサーバーに置く場合は SIMD 版の wasm だけを置く（import map に対応したブラウザはすべて SIMD に対応）
export const WASM_SIMD_ONLY = !!local?.wasmBase;

const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker';
export const MODEL_URLS = local?.models || {
  lite: `${MODEL_BASE}/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
  full: `${MODEL_BASE}/pose_landmarker_full/float16/1/pose_landmarker_full.task`,
  heavy: `${MODEL_BASE}/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task`,
};
export const MODEL_FORMAT = local?.modelFormat || 'url';

// 解析できる長さの上限（秒）。長すぎると時間とメモリを使いすぎるため。
export const MAX_ANALYZE_SECONDS = 60;
export const RECOMMENDED_SECONDS = 20;
