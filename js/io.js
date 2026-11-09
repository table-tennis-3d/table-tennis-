// 解析データの保存と読み込み（JSON）
const FORMAT = 'form3d';
const VERSION = 1;

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const roundArr = (arr, d) => Array.from(arr, (v) => round(v, d));

export function serializeTake(raw, meta = {}) {
  return JSON.stringify({
    app: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    name: meta.name || '',
    settings: meta.settings || {},
    model: raw.model || '',
    fps: raw.fps,
    start: round(raw.start, 4),
    end: round(raw.end, 4),
    videoWidth: raw.videoWidth || 0,
    videoHeight: raw.videoHeight || 0,
    frames: raw.frames.map((f) => (f.world
      ? { t: round(f.t, 4), w: roundArr(f.world, 4), i: roundArr(f.image, 4), v: roundArr(f.vis, 3) }
      : { t: round(f.t, 4) })),
  });
}

export function parseTake(text) {
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    throw new Error('JSONとして読み込めませんでした');
  }
  if (!d || d.app !== FORMAT || !Array.isArray(d.frames) || !(d.fps > 0)) {
    throw new Error('フォーム3Dで保存した解析データではありません');
  }
  const frames = d.frames.map((f) => {
    const ok = Array.isArray(f.w) && f.w.length === 99 && Array.isArray(f.i) && f.i.length === 99 && Array.isArray(f.v) && f.v.length === 33;
    return ok
      ? { t: Number(f.t), world: Float32Array.from(f.w), image: Float32Array.from(f.i), vis: Float32Array.from(f.v) }
      : { t: Number(f.t), world: null, image: null, vis: null };
  });
  if (!frames.length) throw new Error('解析データが空です');
  return {
    name: String(d.name || ''),
    settings: d.settings && typeof d.settings === 'object' ? d.settings : {},
    raw: {
      fps: Number(d.fps),
      start: Number(d.start ?? frames[0].t),
      end: Number(d.end ?? frames[frames.length - 1].t),
      frames,
      videoWidth: Number(d.videoWidth) || 0,
      videoHeight: Number(d.videoHeight) || 0,
      model: String(d.model || ''),
    },
  };
}
