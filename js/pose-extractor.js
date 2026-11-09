// 動画から1コマずつ姿勢（33点の3D座標）を推定する
import { MEDIAPIPE_WASM, WASM_SIMD_ONLY, MODEL_URLS, MODEL_FORMAT } from './config.js';
import { N } from './landmarks.js';

// Base64のテキストで置いたモデルを読み込んでバイト列に戻す（一度読んだら使い回す）
const modelBuffers = new Map();
function loadModelBuffer(model) {
  if (!modelBuffers.has(model)) {
    const p = fetch(MODEL_URLS[model])
      .then((r) => {
        if (!r.ok) throw new Error(`AIモデルを読み込めませんでした（${r.status}）`);
        return r.text();
      })
      .then(decodeBase64)
      .catch((err) => {
        modelBuffers.delete(model);
        throw err;
      });
    modelBuffers.set(model, p);
  }
  return modelBuffers.get(model);
}

function decodeBase64(text) {
  const clean = text.replace(/[^A-Za-z0-9+/=]/g, '');
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - pad);
  const CHUNK = 1 << 20; // 4の倍数ずつ区切ってメモリを節約
  let o = 0;
  for (let i = 0; i < clean.length; i += CHUNK) {
    const bin = atob(clean.slice(i, i + CHUNK));
    for (let k = 0; k < bin.length; k++) out[o++] = bin.charCodeAt(k);
  }
  return out;
}

let visionPromise = null;
function loadVision() {
  if (!visionPromise) {
    visionPromise = import('@mediapipe/tasks-vision').catch((err) => {
      visionPromise = null;
      throw err;
    });
  }
  return visionPromise;
}

// ソフトウェア描画（GPUが使えない環境）ではGPU処理がかえって遅いのでCPUを使う
function prefersCpu() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
  } catch {
    return true;
  }
}

function waitForEvent(target, name, timeoutMs) {
  return new Promise((resolve) => {
    let timer = null;
    const done = () => {
      target.removeEventListener(name, done);
      clearTimeout(timer);
      resolve();
    };
    target.addEventListener(name, done);
    timer = setTimeout(done, timeoutMs);
  });
}

async function seekTo(video, t) {
  const seeked = waitForEvent(video, 'seeked', 4000);
  video.currentTime = t;
  await seeked;
  if (video.readyState < 2) await waitForEvent(video, 'loadeddata', 2000);
}

function toFrame(result, t) {
  const world = result?.worldLandmarks?.[0];
  const image = result?.landmarks?.[0];
  if (!world || !image || world.length < N) return { t, world: null, image: null, vis: null };
  const w = new Float32Array(N * 3);
  const im = new Float32Array(N * 3);
  const vis = new Float32Array(N);
  for (let j = 0; j < N; j++) {
    w[j * 3] = world[j].x; w[j * 3 + 1] = world[j].y; w[j * 3 + 2] = world[j].z;
    im[j * 3] = image[j].x; im[j * 3 + 1] = image[j].y; im[j * 3 + 2] = image[j].z;
    vis[j] = image[j].visibility ?? world[j].visibility ?? 1;
  }
  return { t, world: w, image: im, vis };
}

export class PoseExtractor {
  constructor() {
    this.landmarker = null;
    this.key = '';
    this.pending = null;
    this.pendingKey = '';
    this.requestId = 0;
    this.forceCpu = false;
    this.delegate = '';
    this.lastTimestamp = 0;
  }

  resolveKey({ model = 'full', delegate = 'auto' } = {}) {
    const wanted = delegate === 'auto' ? (this.forceCpu || prefersCpu() ? 'CPU' : 'GPU') : delegate;
    return { key: `${model}:${wanted}`, wanted };
  }

  /**
   * AIモデルを読み込む（同じ設定なら使い回す）。最後に頼まれた設定だけが有効になる。
   * @param {{model: 'lite'|'full'|'heavy', delegate?: 'auto'|'GPU'|'CPU'}} opts
   */
  async prepare({ model = 'full', delegate = 'auto' } = {}) {
    const { key, wanted } = this.resolveKey({ model, delegate });
    if (this.landmarker && this.key === key) return this.landmarker;
    if (this.pending && this.pendingKey === key) return this.pending;

    const id = ++this.requestId;
    const task = (async () => {
      const { FilesetResolver, PoseLandmarker } = await loadVision();
      const fileset = WASM_SIMD_ONLY
        ? { wasmLoaderPath: `${MEDIAPIPE_WASM}/vision_wasm_internal.js`, wasmBinaryPath: `${MEDIAPIPE_WASM}/vision_wasm_internal.wasm` }
        : await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
      const buffer = MODEL_FORMAT === 'base64' ? await loadModelBuffer(model) : null;
      const create = (d) => PoseLandmarker.createFromOptions(fileset, {
        baseOptions: buffer
          ? { modelAssetBuffer: buffer.slice(), delegate: d }
          : { modelAssetPath: MODEL_URLS[model], delegate: d },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputSegmentationMasks: false,
      });
      let lm;
      let used = wanted;
      try {
        lm = await create(wanted);
      } catch (err) {
        if (wanted !== 'GPU') throw err;
        console.warn('GPUで初期化できなかったためCPUに切り替えます', err);
        used = 'CPU';
        lm = await create('CPU');
      }
      if (id !== this.requestId) {
        // 途中で別の設定が頼まれたので、これは使わない
        try { lm.close(); } catch { /* 無視 */ }
        return null;
      }
      if (this.landmarker) {
        try { this.landmarker.close(); } catch { /* 無視 */ }
      }
      this.landmarker = lm;
      this.key = key;
      this.delegate = used;
      this.lastTimestamp = 0;
      return lm;
    })();

    this.pending = task;
    this.pendingKey = key;
    try {
      return await task;
    } finally {
      if (this.pending === task) {
        this.pending = null;
        this.pendingKey = '';
      }
    }
  }

  /**
   * 動画の指定範囲を一定間隔で解析する
   * @param {HTMLVideoElement} video
   * @param {{start:number,end:number,fps:number,signal?:AbortSignal,onFrame?:Function}} opts
   */
  async extract(video, { start, end, fps, signal, onFrame }) {
    if (!this.landmarker) throw new Error('モデルが読み込まれていません');
    const lm = this.landmarker;
    // 前の動画の追跡状態を引き継がないように、グラフを作り直す
    try { await lm.setOptions({ runningMode: 'VIDEO' }); } catch (err) { console.warn(err); }
    const count = Math.max(1, Math.floor((end - start) * fps + 1e-6) + 1);
    const frames = new Array(count);
    // VIDEOモードではタイムスタンプが単調増加である必要がある
    const base = this.lastTimestamp + 1000;
    video.pause();

    let errors = 0;
    for (let i = 0; i < count; i++) {
      if (signal?.aborted) throw new DOMException('中止しました', 'AbortError');
      const t = Math.min(end, start + i / fps);
      await seekTo(video, t);
      if (signal?.aborted) throw new DOMException('中止しました', 'AbortError');
      let ts = base + Math.round((t - start) * 1000);
      if (ts <= this.lastTimestamp) ts = this.lastTimestamp + 1;
      let result = null;
      try {
        result = lm.detectForVideo(video, ts);
      } catch (err) {
        console.warn('推定に失敗したコマ', t, err);
        errors++;
        if (errors === i + 1 && errors >= 5) {
          // 最初から失敗し続ける場合は処理方式の問題とみなす
          const e = new Error('姿勢の推定を実行できませんでした');
          e.code = 'DETECT_FAILED';
          throw e;
        }
      }
      this.lastTimestamp = ts;
      frames[i] = toFrame(result, t);
      onFrame?.(i, count, frames[i]);
    }

    return {
      fps,
      start,
      end,
      frames,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
    };
  }
}
