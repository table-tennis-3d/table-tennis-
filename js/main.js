// フォーム3D — 画面の制御
import { PoseExtractor } from './pose-extractor.js';
import { buildMotion, sampleImage, frameIndexAt } from './motion.js';
import { computeMetrics, findSwings, summarize, CHART_GROUPS, metricCards, SIDE_NAME } from './analysis.js';
import { TimeChart, valueAt } from './chart.js';
import { Overlay2D } from './overlay2d.js';
import { serializeTake, parseTake } from './io.js';
import { MAX_ANALYZE_SECONDS, RECOMMENDED_SECONDS, MODEL_URLS } from './config.js';
import { MIRROR_INDEX, N, COLORS } from './landmarks.js';

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $('fileInput'), dropzone: $('dropzone'), importInput: $('importInput'), btnImport: $('btnImport'),
  btnNew: $('btnNew'), btnHelp: $('btnHelp'), helpDialog: $('helpDialog'),
  video: $('video'), overlay: $('overlay'), viewerCanvas: $('viewerCanvas'), videoPanel: $('videoPanel'),
  procStatus: $('procStatus'), procBar: $('procBar'), procCount: $('procCount'), procEta: $('procEta'), btnCancel: $('btnCancel'),
  trimLabel: $('trimLabel'), trimBar: $('trimBar'), trimRange: $('trimRange'), trimHead: $('trimHead'),
  btnTrimStart: $('btnTrimStart'), btnTrimEnd: $('btnTrimEnd'), btnTrimReset: $('btnTrimReset'),
  optModel: $('optModel'), optFps: $('optFps'), btnAnalyze: $('btnAnalyze'), modelStatus: $('modelStatus'),
  btnPrev: $('btnPrev'), btnPlay: $('btnPlay'), btnNext: $('btnNext'),
  timeline: $('timeline'), timelineTrack: $('timelineTrack'), timelineMarks: $('timelineMarks'), timeLabel: $('timeLabel'),
  speed: $('speed'), btnLoop: $('btnLoop'),
  metricGrid: $('metricGrid'), metricsTime: $('metricsTime'),
  swingList: $('swingList'), summary: $('summary'), chartChips: $('chartChips'), charts: $('charts'),
  btnShot: $('btnShot'), btnRecord: $('btnRecord'), btnExport: $('btnExport'),
  btnCompareVideo: $('btnCompareVideo'), btnCompareJson: $('btnCompareJson'),
  compareVideoInput: $('compareVideoInput'), compareJsonInput: $('compareJsonInput'), compareStatus: $('compareStatus'),
  compareName: $('compareName'), compareOffset: $('compareOffset'), compareOffsetLabel: $('compareOffsetLabel'),
  compareMirror: $('compareMirror'), btnCompareAlign: $('btnCompareAlign'), btnCompareClear: $('btnCompareClear'),
  toast: $('toast'),
};
const video = els.video;

// ---------- 状態 ----------
const settings = {
  handedness: 'right',
  mirror: false,
  timeScale: 1,
  smoothing: 2,
  floor: true,
  trail: true,
  mode: 'mannequin',
  overlay: true,
};
const PERSIST_KEYS = ['handedness', 'smoothing', 'floor', 'trail', 'mode', 'overlay'];

const state = {
  phase: 'empty',
  file: null,
  url: null,
  name: '',
  duration: 0,
  trim: { start: 0, end: 0 },
  raw: null,
  motion: null,
  metrics: null,
  swings: [],
  summary: null,
  ghost: null,
  abort: null,
  hasVideo: false,
};

const player = { t: 0, playing: false, speed: 0.5, loop: true, last: 0, seekFollow: false, scrubbing: false };
const extractor = new PoseExtractor();
const overlay = new Overlay2D(els.overlay, video);
let viewer = null;
let viewerModule = null;
let charts = [];
let cardEls = [];
let lastCardUpdate = 0;
const chartOn = new Set(CHART_GROUPS.filter((g) => g.defaultOn).map((g) => g.id));
const imgBuf = new Float32Array(N * 2);
let recording = null;
let wakeLock = null;

// ---------- 小さな道具 ----------
let toastTimer = 0;
function toast(msg, type = 'info', ms = 4200) {
  const t = els.toast;
  t.textContent = msg;
  t.classList.toggle('error', type === 'error');
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fmtSec = (t) => `${t.toFixed(2)}秒`;
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const baseName = () => (state.name || 'form').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'form';

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('form3d:prefs') || '{}');
    for (const k of PERSIST_KEYS) if (k in p) settings[k] = p[k];
    if (p.model) els.optModel.value = p.model;
    if (p.fps) els.optFps.value = String(p.fps);
    if (p.speed) { player.speed = Number(p.speed); els.speed.value = String(p.speed); }
    if (Array.isArray(p.charts)) { chartOn.clear(); p.charts.forEach((c) => chartOn.add(c)); }
  } catch { /* 保存できない環境では何もしない */ }
}

function savePrefs() {
  try {
    const p = {};
    for (const k of PERSIST_KEYS) p[k] = settings[k];
    p.model = els.optModel.value;
    p.fps = Number(els.optFps.value);
    p.speed = player.speed;
    p.charts = [...chartOn];
    localStorage.setItem('form3d:prefs', JSON.stringify(p));
  } catch { /* 無視 */ }
}

function setPhase(phase) {
  state.phase = phase;
  document.body.dataset.state = phase;
  video.controls = phase === 'preview';
  if (phase !== 'viewer') pause();
  if (phase === 'viewer') requestAnimationFrame(() => viewer?.resize());
}

// ---------- 3D表示の読み込み（必要になったときに） ----------
function loadViewerModule() {
  if (!viewerModule) {
    viewerModule = import('./viewer3d.js').catch((err) => {
      viewerModule = null;
      throw err;
    });
  }
  return viewerModule;
}

async function ensureViewer() {
  if (viewer) return viewer;
  const { Viewer3D } = await loadViewerModule();
  viewer = new Viewer3D(els.viewerCanvas);
  viewer.onUserOrbit = () => setViewButton(null);
  return viewer;
}

function setViewButton(name) {
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
}

// ---------- 動画を開く ----------
function isVideoFile(file) {
  return file && (file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(file.name));
}
function isJsonFile(file) {
  return file && (file.type === 'application/json' || /\.json$/i.test(file.name));
}

function resetAll() {
  if (state.abort) state.abort.abort();
  stopRecording(true);
  pause();
  clearGhost();
  if (state.url) URL.revokeObjectURL(state.url);
  state.file = null; state.url = null; state.name = ''; state.duration = 0;
  state.raw = null; state.motion = null; state.metrics = null; state.swings = []; state.summary = null;
  state.hasVideo = false;
  video.removeAttribute('src');
  video.load();
  overlay.clear();
  charts.forEach((c) => c.destroy());
  charts = [];
  viewer?.clear();
  document.body.classList.remove('no-video', 'mirrored');
  els.fileInput.value = '';
  els.importInput.value = '';
}

function openVideoFile(file) {
  if (!isVideoFile(file)) {
    if (isJsonFile(file)) { openJsonFile(file); return; }
    toast('動画ファイルを選んでください', 'error');
    return;
  }
  resetAll();
  state.file = file;
  state.name = file.name;
  state.url = URL.createObjectURL(file);
  state.hasVideo = true;
  video.src = state.url;
  video.load();
  document.body.classList.toggle('mirrored', settings.mirror);
  setPhase('preview');
  els.trimLabel.textContent = '（読み込み中…）';
  els.btnAnalyze.disabled = true;
  prewarmModel();
}

video.addEventListener('loadedmetadata', async () => {
  if (state.phase !== 'preview') return;
  let d = video.duration;
  if (!Number.isFinite(d)) d = await probeDuration();
  state.duration = d || 0;
  resetTrim();
  els.btnAnalyze.disabled = !(state.duration > 0);
  if (state.duration > RECOMMENDED_SECONDS) {
    toast(`動画が長め（${Math.round(state.duration)}秒）です。スイングの部分だけを範囲にすると速く終わります。`, 'info', 6000);
  }
});

// 小窓表示のために縦横比を覚えておく
video.addEventListener('loadedmetadata', () => {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return;
  els.videoPanel.style.setProperty('--video-ar', `${w} / ${h}`);
  els.videoPanel.classList.toggle('landscape', w > h * 1.1);
});
els.videoPanel.addEventListener('click', () => {
  if (state.phase === 'viewer' && window.matchMedia('(max-width: 860px)').matches) {
    els.videoPanel.classList.toggle('pip-large');
  }
});

// 長さが分からない動画（一部のWebMなど）は最後までシークして長さを調べる
function probeDuration() {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('durationchange', onChange);
      const d = video.duration;
      video.currentTime = 0;
      resolve(Number.isFinite(d) ? d : 0);
    };
    const onChange = () => { if (Number.isFinite(video.duration)) done(); };
    video.addEventListener('durationchange', onChange);
    video.currentTime = 1e7;
    setTimeout(done, 3000);
  });
}

video.addEventListener('error', () => {
  if (!state.hasVideo || !video.getAttribute('src')) return;
  const isMov = /\.mov$/i.test(state.name || '');
  toast(isMov
    ? 'この動画はこのブラウザで再生できない形式のようです。iPhoneなら「設定 › カメラ › フォーマット › 互換性優先」で撮るか、Safari／Chromeで開いてください。'
    : 'この動画を読み込めませんでした。MP4（H.264）形式の動画をお試しください。', 'error', 9000);
  setPhase('empty');
  state.hasVideo = false;
});

async function openJsonFile(file) {
  try {
    const take = parseTake(await file.text());
    resetAll();
    state.raw = take.raw;
    state.name = take.name || file.name;
    for (const k of ['handedness', 'mirror', 'timeScale']) {
      if (k in take.settings) settings[k] = k === 'timeScale' ? Number(take.settings[k]) || 1 : take.settings[k];
    }
    syncAllSettings();
    document.body.classList.add('no-video');
    if (await enterViewer()) toast('解析データを開きました（元の動画は含まれません）');
  } catch (err) {
    console.error(err);
    toast(err.message || '読み込めませんでした', 'error');
  }
}

// ---------- 範囲（トリム） ----------
function resetTrim() {
  state.trim.start = 0;
  state.trim.end = Math.min(state.duration, MAX_ANALYZE_SECONDS);
  renderTrim();
}

function renderTrim() {
  const { start, end } = state.trim;
  const d = state.duration || 1;
  els.trimRange.style.left = `${(start / d) * 100}%`;
  els.trimRange.style.width = `${((end - start) / d) * 100}%`;
  const frames = Math.floor((end - start) * Number(els.optFps.value)) + 1;
  els.trimLabel.textContent = `${fmtSec(start)}〜${fmtSec(end)}（${(end - start).toFixed(1)}秒・約${frames}コマ）`;
  updateTrimHead();
}

function updateTrimHead() {
  const d = state.duration || 1;
  els.trimHead.style.left = `${(clamp(video.currentTime || 0, 0, d) / d) * 100}%`;
}

function setTrimStart() {
  const t = video.currentTime || 0;
  state.trim.start = clamp(t, 0, Math.max(0, state.duration - 0.2));
  if (state.trim.end <= state.trim.start + 0.2 || state.trim.end - state.trim.start > MAX_ANALYZE_SECONDS) {
    state.trim.end = Math.min(state.duration, state.trim.start + Math.min(MAX_ANALYZE_SECONDS, Math.max(3, state.trim.end - state.trim.start)));
  }
  renderTrim();
}

function setTrimEnd() {
  const t = video.currentTime || 0;
  state.trim.end = clamp(t, 0.2, state.duration);
  if (state.trim.start >= state.trim.end - 0.2 || state.trim.end - state.trim.start > MAX_ANALYZE_SECONDS) {
    state.trim.start = Math.max(0, state.trim.end - Math.min(MAX_ANALYZE_SECONDS, Math.max(3, state.trim.end - state.trim.start)));
  }
  renderTrim();
}

els.btnTrimStart.addEventListener('click', setTrimStart);
els.btnTrimEnd.addEventListener('click', setTrimEnd);
els.btnTrimReset.addEventListener('click', resetTrim);
els.optFps.addEventListener('change', () => { renderTrim(); savePrefs(); });
els.trimBar.addEventListener('pointerdown', (e) => {
  const r = els.trimBar.getBoundingClientRect();
  video.currentTime = clamp((e.clientX - r.left) / r.width, 0, 1) * state.duration;
});
video.addEventListener('timeupdate', () => { if (state.phase === 'preview') updateTrimHead(); });

// ---------- AIモデル ----------
function modelLabel() {
  return els.optModel.options[els.optModel.selectedIndex]?.textContent.replace(/（.*$/, '') || '';
}

function prewarmModel() {
  const model = els.optModel.value;
  els.modelStatus.textContent = 'AIモデルを読み込んでいます…（初回のみ少し時間がかかります）';
  extractor.prepare({ model }).then((lm) => {
    if (!lm || els.optModel.value !== model || state.phase === 'empty') return;
    els.modelStatus.textContent = `AIモデルの準備ができました（${modelLabel()}・${extractor.delegate === 'GPU' ? 'GPU' : 'CPU'}処理）`;
  }).catch((err) => {
    console.warn(err);
    if (els.optModel.value === model) els.modelStatus.textContent = 'AIモデルを読み込めませんでした。「3Dモデルを作る」を押すともう一度試します。';
  });
}

els.optModel.addEventListener('change', () => {
  savePrefs();
  if (state.phase === 'preview') prewarmModel();
});

// ---------- 解析 ----------
async function acquireWakeLock() {
  // 埋め込み表示などで許可されていない場合は頼まない（ブラウザが警告を出すため）
  if (!navigator.wakeLock || document.featurePolicy?.allowsFeature?.('screen-wake-lock') === false) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch { wakeLock = null; }
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch { /* 無視 */ }
  wakeLock = null;
}

function errorMessage(err) {
  if (err?.code === 'NO_PERSON') return '人物を検出できませんでした。全身が映っているか、明るさが十分か確認してください。';
  const msg = String(err?.message || err || '');
  if (/fetch|network|load|404|Failed to/i.test(msg)) return 'AIモデルやプログラムを読み込めませんでした。インターネット接続を確認して、もう一度お試しください。';
  return `解析中にエラーが起きました（${msg}）`;
}

async function analyze() {
  if (state.phase !== 'preview' || !(state.duration > 0)) return;
  const { start, end } = state.trim;
  const fps = Number(els.optFps.value);
  const model = els.optModel.value;
  // iOSでは、ユーザー操作の中で一度再生しておくとシークで映像が出るようになる
  try { await video.play(); } catch { /* 無視 */ }
  video.pause();
  setPhase('processing');
  const ac = new AbortController();
  state.abort = ac;
  acquireWakeLock();
  setProgress('AIモデルを準備しています…', 0, '', '');
  const runOnce = async (label) => {
    await extractor.prepare({ model });
    if (ac.signal.aborted) throw new DOMException('中止しました', 'AbortError');
    const began = performance.now();
    return extractor.extract(video, {
      start, end, fps, signal: ac.signal,
      onFrame: (i, n, frame) => {
        const done = i + 1;
        const el = (performance.now() - began) / 1000;
        const eta = done > 3 ? Math.max(0, (el / done) * (n - done)) : null;
        setProgress(label, done / n, `${done} / ${n} コマ`, eta != null ? `残り約${Math.ceil(eta)}秒` : '');
        drawProcessingOverlay(frame);
      },
    });
  };
  try {
    let raw;
    try {
      raw = await runOnce('1コマずつ姿勢を推定しています…');
      if (extractor.delegate === 'GPU' && raw.frames.every((f) => !f.world)) {
        const e = new Error('GPUで人物を検出できませんでした');
        e.code = 'DETECT_FAILED';
        throw e;
      }
    } catch (err) {
      // GPU処理がうまく動かない端末では、CPU処理に切り替えてやり直す
      if (err?.code !== 'DETECT_FAILED' || extractor.delegate !== 'GPU') throw err;
      console.warn(err);
      extractor.forceCpu = true;
      setProgress('GPUでうまく推定できなかったため、CPUでやり直しています…', 0, '', '');
      raw = await runOnce('CPUで1コマずつ推定しています…');
    }
    raw.model = model;
    state.raw = raw;
    if (!(await enterViewer())) return;
    const ratio = state.motion?.validRatio ?? 0;
    if (ratio < 0.6) {
      toast(`人物を検出できたのは全体の${Math.round(ratio * 100)}%のコマでした。全身が映るように撮ると精度が上がります。`, 'info', 7000);
    } else {
      toast('3Dモデルができました。ドラッグで回して見てみましょう。');
    }
  } catch (err) {
    overlay.clear();
    if (err?.name === 'AbortError') {
      if (state.phase === 'processing') setPhase('preview');
      if (state.hasVideo) toast('解析を中止しました');
    } else {
      console.error(err);
      setPhase('preview');
      toast(errorMessage(err), 'error', 8000);
    }
  } finally {
    if (state.abort === ac) state.abort = null;
    releaseWakeLock();
  }
}

function setProgress(status, ratio, count, eta) {
  els.procStatus.textContent = status;
  els.procBar.style.width = `${Math.round(ratio * 100)}%`;
  els.procCount.textContent = count;
  els.procEta.textContent = eta;
}

const procBuf = new Float32Array(N * 3);
function drawProcessingOverlay(frame) {
  if (!frame.image) { overlay.clear(); return; }
  let img = frame.image;
  let vis = frame.vis;
  if (settings.mirror) {
    // 表示は左右反転しているので、左右のラベルだけ入れ替える
    const v2 = new Float32Array(N);
    for (let j = 0; j < N; j++) {
      const s = MIRROR_INDEX[j];
      procBuf[j * 3] = img[s * 3]; procBuf[j * 3 + 1] = img[s * 3 + 1]; procBuf[j * 3 + 2] = img[s * 3 + 2];
      v2[j] = vis[s];
    }
    img = procBuf; vis = v2;
  }
  overlay.draw(img, vis, { stride: 3 });
}

els.btnAnalyze.addEventListener('click', analyze);
els.btnCancel.addEventListener('click', () => state.abort?.abort());

// ---------- 結果の表示 ----------
async function enterViewer() {
  try {
    await ensureViewer();
  } catch (err) {
    console.error(err);
    toast('3D表示のプログラムを読み込めませんでした。インターネット接続を確認してください。', 'error', 8000);
    setPhase(state.hasVideo ? 'preview' : 'empty');
    return false;
  }
  setPhase('viewer');
  viewer.resize();
  try {
    rebuild({ resetView: true });
  } catch (err) {
    console.error(err);
    state.raw = null;
    state.motion = null;
    toast(errorMessage(err), 'error', 8000);
    setPhase(state.hasVideo ? 'preview' : 'empty');
    return false;
  }
  setViewButton(viewer.view);
  const first = state.swings[0];
  seekTo(first ? Math.max(state.motion.start, first.t - 0.6 / settings.timeScale) : state.motion.start);
  return true;
}

function rebuild({ resetView = false } = {}) {
  if (!state.raw) return;
  state.motion = buildMotion(state.raw, { mirror: settings.mirror, smoothing: settings.smoothing, floor: settings.floor });
  state.metrics = computeMetrics(state.motion, { timeScale: settings.timeScale });
  state.swings = findSwings(state.metrics, state.motion, settings);
  state.summary = summarize(state.metrics, state.motion, settings);
  if (state.ghost) rebuildGhost();
  document.body.classList.toggle('mirrored', settings.mirror && state.hasVideo);

  viewer.setMotion(state.motion, { handedness: settings.handedness, timeScale: settings.timeScale, resetView });
  viewer.setMode(settings.mode);
  viewer.setTrail(settings.trail);
  if (state.ghost) applyGhostToViewer();

  const { start, end, fps } = state.motion;
  els.timeline.min = String(start);
  els.timeline.max = String(end);
  els.timeline.step = String(1 / (fps * 4));
  player.t = clamp(player.t, start, end);

  buildMetricCards();
  buildChips();
  buildCharts();
  renderSwings();
  renderSummary();
  renderTimeline();
  updateFrame(true);
}

// ---------- 再生 ----------
function range() {
  return state.motion ? [state.motion.start, state.motion.end] : [0, 0];
}

function setVideoRate(rate) {
  try {
    video.playbackRate = rate;
    player.seekFollow = Math.abs(video.playbackRate - rate) > 1e-3;
  } catch {
    player.seekFollow = true;
  }
}

let pendingVideoSeek = null;
function videoSeek(t) {
  if (!state.hasVideo) return;
  if (video.seeking) { pendingVideoSeek = t; return; }
  video.currentTime = t;
}
video.addEventListener('seeked', () => {
  if (pendingVideoSeek != null && state.phase === 'viewer') {
    const t = pendingVideoSeek;
    pendingVideoSeek = null;
    video.currentTime = t;
  }
});

function play() {
  if (!state.motion || player.playing) return;
  const [start, end] = range();
  if (player.t >= end - 1e-3) player.t = start;
  player.playing = true;
  player.last = performance.now();
  document.body.classList.add('playing');
  els.btnPlay.setAttribute('aria-label', '一時停止');
  if (state.hasVideo) {
    setVideoRate(player.speed);
    video.currentTime = player.t;
    if (!player.seekFollow) video.play().catch(() => { player.seekFollow = true; });
  }
}

function pause() {
  if (!player.playing) return;
  player.playing = false;
  document.body.classList.remove('playing');
  els.btnPlay.setAttribute('aria-label', '再生');
  if (state.hasVideo) {
    video.pause();
    videoSeek(player.t);
  }
  updateFrame(true);
  if (recording) stopRecording();
}

function togglePlay() { player.playing ? pause() : play(); }

function seekTo(t) {
  if (!state.motion) return;
  const [start, end] = range();
  player.t = clamp(t, start, end);
  if (!player.playing) videoSeek(player.t);
  else if (state.hasVideo) video.currentTime = player.t;
  updateFrame(true);
}

function stepFrame(dir) {
  if (!state.motion) return;
  pause();
  const { start, fps } = state.motion;
  const idx = Math.round((player.t - start) * fps) + dir;
  seekTo(start + idx / fps);
}

function tickPlayback(now) {
  const [start, end] = range();
  const dt = Math.min(0.1, (now - player.last) / 1000);
  player.last = now;
  // 動画が普通に再生できているときは動画の時刻に合わせる（ずれない）。それ以外は自前の時計で進める
  const videoClock = state.hasVideo && !player.seekFollow && !video.paused && !video.seeking && video.readyState >= 2;
  let t = videoClock ? Math.max(video.currentTime, start) : player.t + dt * player.speed;
  if (t >= end) {
    if (player.loop && !recording) {
      t = videoClock ? start : start + ((t - end) % Math.max(1e-3, end - start));
      if (state.hasVideo) {
        video.currentTime = t;
        if (!player.seekFollow && (video.paused || video.ended)) video.play().catch(() => {});
      }
    } else {
      player.t = end;
      pause();
      return;
    }
  }
  player.t = t;
  if (state.hasVideo && player.seekFollow && !video.seeking && Math.abs(video.currentTime - t) > 0.5 / state.motion.fps) {
    video.currentTime = t;
  }
  updateFrame(false);
}

function updateFrame(force) {
  if (!state.motion || !viewer) return;
  const t = player.t;
  viewer.setTime(t);
  // 元動画の骨格（表示されているコマに合わせる）
  if (state.hasVideo && settings.overlay) {
    const tv = player.playing && !player.seekFollow && !video.seeking ? clamp(video.currentTime, state.motion.start, state.motion.end) : t;
    sampleImage(state.motion, tv, imgBuf);
    const i = frameIndexAt(state.motion, tv);
    overlay.draw(imgBuf, state.motion.vis.subarray(i * N, i * N + N), { dim: !state.motion.valid[i] });
  } else {
    overlay.clear();
  }
  for (const c of charts) c.setCursor(t);
  if (!player.scrubbing) els.timeline.value = String(t);
  els.timeLabel.textContent = `${t.toFixed(2)} / ${state.motion.end.toFixed(2)}秒`;
  const now = performance.now();
  if (force || now - lastCardUpdate > 90) {
    lastCardUpdate = now;
    updateMetricCards(t);
  }
}

els.btnPlay.addEventListener('click', togglePlay);
els.btnPrev.addEventListener('click', () => stepFrame(-1));
els.btnNext.addEventListener('click', () => stepFrame(1));
els.speed.addEventListener('change', () => {
  player.speed = Number(els.speed.value);
  if (player.playing && state.hasVideo) {
    setVideoRate(player.speed);
    if (player.seekFollow) video.pause();
    else video.play().catch(() => {});
  }
  savePrefs();
});
els.btnLoop.addEventListener('click', () => {
  player.loop = !player.loop;
  els.btnLoop.setAttribute('aria-pressed', String(player.loop));
});
els.timeline.addEventListener('pointerdown', () => { player.scrubbing = true; pause(); });
els.timeline.addEventListener('input', () => { pause(); seekTo(Number(els.timeline.value)); });
const endScrub = () => { player.scrubbing = false; };
els.timeline.addEventListener('pointerup', endScrub);
els.timeline.addEventListener('change', endScrub);

document.addEventListener('keydown', (e) => {
  if (state.phase !== 'viewer' || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = e.target?.tagName;
  const type = e.target?.type;
  // フォーム部品の上では、その部品本来のキー操作を優先する（再生位置のスライダーだけは例外）
  if (tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && type !== 'range')) return;
  if (els.helpDialog.open) return;
  if (e.code === 'Space') {
    if (tag === 'BUTTON') return;
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'ArrowLeft' && type !== 'range') {
    e.preventDefault();
    stepFrame(-1);
  } else if (e.key === 'ArrowRight' && type !== 'range') {
    e.preventDefault();
    stepFrame(1);
  }
});

document.querySelectorAll('[data-view]').forEach((b) => {
  b.addEventListener('click', () => {
    if (!viewer) return;
    viewer.setView(b.dataset.view);
    setViewButton(b.dataset.view);
  });
});

// ---------- 数値カード ----------
function buildMetricCards() {
  const defs = metricCards(settings.handedness);
  els.metricGrid.innerHTML = '';
  cardEls = defs.map((d) => {
    const el = document.createElement('div');
    el.className = `metric${d.dominant ? ' dominant' : ''}`;
    const sw = d.side ? `<i class="sw sw-${d.side.toLowerCase()}"></i>` : '';
    el.innerHTML = `<span class="m-label">${sw}${escapeHtml(d.label)}</span><span class="m-value">–</span><span class="m-sub"></span>`;
    els.metricGrid.appendChild(el);
    return { def: d, value: el.querySelector('.m-value'), sub: el.querySelector('.m-sub'), last: '', lastSub: '' };
  });
}

function formatValue(v, def) {
  if (!Number.isFinite(v)) return '–';
  const d = def.decimals ?? 0;
  let s = Math.abs(v).toFixed(d);
  if (def.signed && Number(s) !== 0) s = (v > 0 ? '+' : '−') + s;
  return s;
}

function updateMetricCards(t) {
  if (!state.metrics) return;
  els.metricsTime.textContent = fmtSec(t);
  const g = state.ghost;
  for (const c of cardEls) {
    const v = valueAt(state.metrics[c.def.key], state.motion.times, t);
    const unit = c.def.unit === '°' ? '°' : `<small>${c.def.unit}</small>`;
    const txt = `${formatValue(v, c.def)}${unit}`;
    if (txt !== c.last) { c.value.innerHTML = txt; c.last = txt; }
    let sub = c.def.sub || '';
    if (g?.metrics) {
      const gv = valueAt(g.metrics[c.def.key], g.motion.times, t + g.offset);
      sub = `比較 ${formatValue(gv, c.def)}${c.def.unit}`;
    }
    if (sub !== c.lastSub) {
      c.sub.textContent = sub;
      c.sub.style.color = g?.metrics ? COLORS.ghost : '';
      c.lastSub = sub;
    }
  }
}

// ---------- グラフ ----------
function buildChips() {
  els.chartChips.innerHTML = '';
  for (const g of CHART_GROUPS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = g.title;
    b.setAttribute('aria-pressed', String(chartOn.has(g.id)));
    b.addEventListener('click', () => {
      if (chartOn.has(g.id)) chartOn.delete(g.id); else chartOn.add(g.id);
      b.setAttribute('aria-pressed', String(chartOn.has(g.id)));
      buildCharts();
      savePrefs();
    });
    els.chartChips.appendChild(b);
  }
}

function ghostSeriesFor(group) {
  const g = state.ghost;
  if (!g?.metrics) return [];
  const D = settings.handedness === 'left' ? 'L' : 'R';
  let s = group.series.find((x) => x.side === D);
  if (!s) s = group.series.find((x) => x.key === 'xFactor') || group.series[0];
  const times = Float64Array.from(g.motion.times, (x) => x - g.offset);
  return [{ key: s.key, label: `${s.label}（比較）`, color: COLORS.ghost, dashed: true, data: g.metrics[s.key], times }];
}

function buildCharts() {
  charts.forEach((c) => c.destroy());
  charts = [];
  if (!state.metrics) return;
  const [start, end] = range();
  for (const g of CHART_GROUPS) {
    if (!chartOn.has(g.id)) continue;
    const series = g.series.map((s) => ({ ...s, data: state.metrics[s.key] })).concat(ghostSeriesFor(g));
    charts.push(new TimeChart(els.charts, {
      title: g.title, sub: g.sub, unit: g.unit, decimals: g.decimals,
      series, times: state.motion.times, range: [start, end], valid: state.motion.valid,
      events: state.swings.map((s) => s.t),
      onSeek: (t) => { pause(); seekTo(t); },
    }));
  }
  for (const c of charts) c.setCursor(player.t);
}

// ---------- スイング・まとめ ----------
function renderSwings() {
  const list = els.swingList;
  list.innerHTML = '';
  if (!state.swings.length) {
    list.innerHTML = '<p class="swing-empty">はっきりしたスイングは見つかりませんでした。</p>';
    return;
  }
  state.swings.forEach((s, k) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swing-chip';
    b.innerHTML = `<b>スイング ${k + 1}</b><span>${fmtSec(s.t)}・${s.speed.toFixed(1)} m/s</span>`;
    b.addEventListener('click', () => { pause(); seekTo(s.t); });
    list.appendChild(b);
  });
}

function renderSummary() {
  const s = state.summary;
  if (!s) { els.summary.innerHTML = ''; return; }
  const D = SIDE_NAME[s.dominant];
  const jump = (t) => (t != null ? `<button class="link" type="button" data-jump="${t}">見る</button>` : '');
  const rows = [
    [`最高の手首の速さ（${D}）`, `${s.maxSpeed.value.toFixed(1)} m/s（${fmtSec(s.maxSpeed.t ?? 0)}）${jump(s.maxSpeed.t)}`],
    ['最大の捻転差', `${Math.abs(s.maxXFactor.value).toFixed(0)}°（${fmtSec(s.maxXFactor.t ?? 0)}）${jump(s.maxXFactor.t)}`],
    [`いちばん深い膝の曲げ（${SIDE_NAME[s.minKnee.side]}）`, `${s.minKnee.value.toFixed(0)}°（${fmtSec(s.minKnee.t ?? 0)}）${jump(s.minKnee.t)}`],
    [`${D}肘の角度の範囲`, `${s.elbowRange.min.toFixed(0)}°〜${s.elbowRange.max.toFixed(0)}°`],
    ['人物を検出できたコマ', `${Math.round(s.validRatio * 100)}%`],
  ];
  els.summary.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('');
}

els.summary.addEventListener('click', (e) => {
  const b = e.target.closest('[data-jump]');
  if (!b) return;
  pause();
  seekTo(Number(b.dataset.jump));
});

function renderTimeline() {
  const [start, end] = range();
  const span = Math.max(1e-6, end - start);
  els.timelineMarks.innerHTML = state.swings
    .map((s) => `<span class="mark" style="left:calc(8px + (100% - 16px) * ${((s.t - start) / span).toFixed(4)})"></span>`)
    .join('');
  // 検出できなかった区間
  const m = state.motion;
  let html = '';
  let i = 0;
  while (i < m.n) {
    if (m.valid[i]) { i++; continue; }
    const a = i;
    while (i < m.n && !m.valid[i]) i++;
    const l = ((m.times[a] - start) / span) * 100;
    const w = Math.max(0.6, ((m.times[i - 1] - m.times[a] + 1 / m.fps) / span) * 100);
    html += `<span class="gap" style="left:${l.toFixed(2)}%;width:${w.toFixed(2)}%"></span>`;
  }
  els.timelineTrack.innerHTML = html;
}

// ---------- 設定 ----------
function readSetting(el) {
  const key = el.dataset.setting;
  if (el.type === 'checkbox') return el.checked;
  const v = el.value;
  if (key === 'timeScale' || key === 'smoothing') return Number(v);
  return v;
}

function syncSetting(key) {
  document.querySelectorAll(`[data-setting="${key}"]`).forEach((el) => {
    if (el.type === 'checkbox') el.checked = !!settings[key];
    else if (el.type === 'radio') el.checked = String(settings[key]) === el.value;
    else el.value = String(settings[key]);
  });
}

function syncAllSettings() {
  for (const k of Object.keys(settings)) syncSetting(k);
}

document.querySelectorAll('[data-setting]').forEach((el) => {
  el.addEventListener('change', () => {
    if (el.type === 'radio' && !el.checked) return;
    const key = el.dataset.setting;
    settings[key] = readSetting(el);
    syncSetting(key);
    savePrefs();
    onSettingChanged(key);
  });
});

function onSettingChanged(key) {
  switch (key) {
    case 'mode':
      viewer?.setMode(settings.mode);
      viewer?.refresh();
      break;
    case 'trail':
      viewer?.setTrail(settings.trail);
      viewer?.refresh();
      break;
    case 'overlay':
      updateFrame(true);
      break;
    case 'mirror':
      document.body.classList.toggle('mirrored', settings.mirror && state.hasVideo);
      if (state.raw && state.phase === 'viewer') rebuild();
      break;
    default:
      if (state.raw && state.phase === 'viewer') rebuild();
  }
}

// ---------- 比較 ----------
let compareAbort = null;

function clearGhost() {
  if (compareAbort) { compareAbort.abort(); compareAbort = null; }
  state.ghost = null;
  viewer?.clearGhost();
  document.body.classList.remove('has-ghost');
  els.compareStatus.textContent = '';
  els.btnCompareVideo.disabled = false;
  els.btnCompareJson.disabled = false;
}

function rebuildGhost() {
  const g = state.ghost;
  const mirror = g.mirror;
  g.motion = buildMotion(g.raw, { mirror, smoothing: settings.smoothing, floor: settings.floor });
  g.metrics = computeMetrics(g.motion, { timeScale: g.timeScale || 1 });
  g.summary = summarize(g.metrics, g.motion, settings);
  g.autoOffset = autoOffset(g);
  g.offset = g.autoOffset + g.fine;
}

// 比較側の山場（手首最速）を、本体の「今いちばん近いスイング」に合わせる
function autoOffset(g, nearT = null) {
  const gt = g.summary?.maxSpeed.t;
  if (gt == null || !state.motion) return 0;
  let mt = state.summary?.maxSpeed.t ?? state.motion.start;
  if (nearT != null && state.swings.length) {
    mt = state.swings.reduce((best, s) => (Math.abs(s.t - nearT) < Math.abs(best - nearT) ? s.t : best), state.swings[0].t);
  }
  return gt - mt;
}

function applyGhostToViewer() {
  const g = state.ghost;
  if (!g?.motion || !viewer) return;
  const layout = document.querySelector('input[name="cmpLayout"]:checked')?.value || 'overlay';
  viewer.setGhost(g.motion, { offset: g.offset, layout });
  document.body.classList.add('has-ghost');
  els.compareName.textContent = g.name;
  els.compareOffset.value = String(g.fine);
  els.compareOffsetLabel.textContent = `${g.fine >= 0 ? '+' : '−'}${Math.abs(g.fine).toFixed(2)}秒`;
}

function setGhost(raw, name, opts = {}) {
  state.ghost = { raw, name, fine: 0, mirror: !!opts.mirror, timeScale: opts.timeScale || 1 };
  els.compareMirror.checked = state.ghost.mirror;
  rebuildGhost();
  applyGhostToViewer();
  buildCharts();
  updateFrame(true);
  toast('比較を重ねました。紫の半透明の人形が比較対象です。');
}

async function compareFromJson(file) {
  clearGhost();
  try {
    const take = parseTake(await file.text());
    setGhost(take.raw, take.name || file.name, { mirror: !!take.settings.mirror, timeScale: Number(take.settings.timeScale) || 1 });
  } catch (err) {
    toast(err.message || '読み込めませんでした', 'error');
  }
}

async function compareFromVideo(file) {
  if (!isVideoFile(file)) { toast('動画ファイルを選んでください', 'error'); return; }
  clearGhost();
  buildCharts();
  const ac = new AbortController();
  compareAbort = ac;
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.appendChild(v);
  const url = URL.createObjectURL(file);
  els.btnCompareVideo.disabled = true;
  els.btnCompareJson.disabled = true;
  try {
    v.src = url;
    await new Promise((resolve, reject) => {
      v.addEventListener('loadedmetadata', resolve, { once: true });
      v.addEventListener('error', () => reject(new Error('この動画は読み込めませんでした')), { once: true });
    });
    try { await v.play(); } catch { /* 無視 */ }
    v.pause();
    const end = Math.min(Number.isFinite(v.duration) ? v.duration : MAX_ANALYZE_SECONDS, MAX_ANALYZE_SECONDS);
    els.compareStatus.textContent = 'AIモデルを準備しています…';
    await extractor.prepare({ model: state.raw?.model || els.optModel.value });
    if (ac.signal.aborted) return;
    const raw = await extractor.extract(v, {
      start: 0, end, fps: state.raw?.fps || 30, signal: ac.signal,
      onFrame: (i, n) => { els.compareStatus.textContent = `比較する動画を解析中… ${Math.round(((i + 1) / n) * 100)}%`; },
    });
    if (ac.signal.aborted || compareAbort !== ac) return;
    compareAbort = null;
    els.compareStatus.textContent = '';
    setGhost(raw, file.name, { timeScale: settings.timeScale });
  } catch (err) {
    if (err?.name !== 'AbortError') {
      console.error(err);
      els.compareStatus.textContent = '';
      toast(errorMessage(err), 'error', 7000);
    }
  } finally {
    if (compareAbort === ac) compareAbort = null;
    els.btnCompareVideo.disabled = false;
    els.btnCompareJson.disabled = false;
    URL.revokeObjectURL(url);
    v.remove();
  }
}

els.btnCompareVideo.addEventListener('click', () => els.compareVideoInput.click());
els.btnCompareJson.addEventListener('click', () => els.compareJsonInput.click());
els.compareVideoInput.addEventListener('change', () => {
  const f = els.compareVideoInput.files?.[0];
  els.compareVideoInput.value = '';
  if (f) compareFromVideo(f);
});
els.compareJsonInput.addEventListener('change', () => {
  const f = els.compareJsonInput.files?.[0];
  els.compareJsonInput.value = '';
  if (f) compareFromJson(f);
});
els.compareOffset.addEventListener('input', () => {
  const g = state.ghost;
  if (!g) return;
  g.fine = Number(els.compareOffset.value);
  g.offset = g.autoOffset + g.fine;
  els.compareOffsetLabel.textContent = `${g.fine >= 0 ? '+' : '−'}${Math.abs(g.fine).toFixed(2)}秒`;
  viewer?.setGhostOffset(g.offset);
  buildCharts();
  updateFrame(true);
});
els.compareMirror.addEventListener('change', () => {
  const g = state.ghost;
  if (!g) return;
  g.mirror = els.compareMirror.checked;
  rebuildGhost();
  applyGhostToViewer();
  buildCharts();
  updateFrame(true);
});
document.querySelectorAll('input[name="cmpLayout"]').forEach((r) => r.addEventListener('change', () => {
  viewer?.setGhostLayout(r.value);
  viewer?.refresh();
}));
els.btnCompareAlign.addEventListener('click', () => {
  const g = state.ghost;
  if (!g) return;
  g.autoOffset = autoOffset(g, player.t);
  g.fine = 0;
  g.offset = g.autoOffset;
  applyGhostToViewer();
  buildCharts();
  updateFrame(true);
});
els.btnCompareClear.addEventListener('click', () => {
  clearGhost();
  buildCharts();
  updateMetricCards(player.t);
  viewer?.refresh();
});

// ---------- 保存 ----------
els.btnShot.addEventListener('click', async () => {
  if (!viewer) return;
  try {
    download(await viewer.snapshot(), `${baseName()}_3d_${player.t.toFixed(2)}s.png`);
  } catch (err) {
    toast(err.message || '画像を作れませんでした', 'error');
  }
});

els.btnExport.addEventListener('click', () => {
  if (!state.raw) return;
  const json = serializeTake(state.raw, {
    name: state.name,
    settings: { handedness: settings.handedness, mirror: settings.mirror, timeScale: settings.timeScale },
  });
  download(new Blob([json], { type: 'application/json' }), `${baseName()}_form3d.json`);
});

function pickRecorderType() {
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

els.btnRecord.addEventListener('click', () => {
  if (recording) { stopRecording(); return; }
  if (!viewer || !state.motion) return;
  const canvas = viewer.canvas;
  if (!window.MediaRecorder || !canvas.captureStream) {
    toast('このブラウザは動画の書き出しに対応していません', 'error');
    return;
  }
  const type = pickRecorderType();
  let rec;
  try {
    const stream = canvas.captureStream(30);
    rec = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 8e6 } : undefined);
  } catch (err) {
    console.error(err);
    toast('動画の書き出しを始められませんでした', 'error');
    return;
  }
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  rec.onstop = () => {
    const mime = rec.mimeType || type || 'video/webm';
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    if (chunks.length && !recording?.cancelled) download(new Blob(chunks, { type: mime }), `${baseName()}_3d.${ext}`);
    recording = null;
    els.btnRecord.textContent = '3Dを動画で保存';
    els.btnRecord.classList.remove('recording');
  };
  pause();
  seekTo(state.motion.start);
  recording = { rec, cancelled: false };
  els.btnRecord.textContent = '録画を止める';
  els.btnRecord.classList.add('recording');
  rec.start(250);
  toast(`いまの視点・${player.speed}倍速で最後まで録画します。録画中も3Dを回せます。`, 'info', 5000);
  play();
});

function stopRecording(cancel = false) {
  if (!recording) return;
  recording.cancelled = cancel;
  try { recording.rec.stop(); } catch { recording = null; }
}

// ---------- ファイル選択・ドラッグ＆ドロップ ----------
els.fileInput.addEventListener('change', () => {
  const f = els.fileInput.files?.[0];
  if (f) openVideoFile(f);
});
els.btnImport.addEventListener('click', () => els.importInput.click());
els.importInput.addEventListener('change', () => {
  const f = els.importInput.files?.[0];
  if (f) openJsonFile(f);
});

['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
  if (state.phase !== 'empty' || !e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  els.dropzone.classList.add('drag');
}));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
  if (ev === 'dragleave' && e.relatedTarget) return;
  els.dropzone.classList.remove('drag');
}));
document.addEventListener('drop', (e) => {
  if (state.phase !== 'empty') return;
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  if (isJsonFile(f)) openJsonFile(f); else openVideoFile(f);
});

els.btnNew.addEventListener('click', () => {
  resetAll();
  setPhase('empty');
  window.scrollTo({ top: 0 });
});
els.btnHelp.addEventListener('click', () => els.helpDialog.showModal());

// ---------- メインループ ----------
function loop(now) {
  requestAnimationFrame(loop);
  if (state.phase === 'viewer' && state.motion) {
    if (player.playing) tickPlayback(now);
  } else if (state.phase === 'preview') {
    updateTrimHead();
  }
  viewer?.tick();
}

// ---------- 起動 ----------
document.body.dataset.state = state.phase;
for (const opt of [...els.optModel.options]) if (!MODEL_URLS[opt.value]) opt.remove();
loadPrefs();
if (!MODEL_URLS[els.optModel.value]) els.optModel.value = 'full';
syncAllSettings();
els.btnLoop.setAttribute('aria-pressed', String(player.loop));
requestAnimationFrame(loop);
// 3D表示のプログラムは、使う前に裏で読み込んでおく
const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
idle(() => loadViewerModule().catch(() => {}));

// テスト・デバッグ用
window.__form3d = { state, settings, player, get viewer() { return viewer; }, seekTo, play, pause };
