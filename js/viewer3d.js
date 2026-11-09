// 3D表示（three.js）: 人形 / 骨格、視点の切り替え、手首の軌跡、比較用の半透明人形
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { N, LM, BONES, SKELETON_POINTS, SIDE, COLORS, boneSide } from './landmarks.js';
import { samplePose } from './motion.js';

const UP = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const SPHERE = new THREE.SphereGeometry(1, 36, 24);
const SPHERE_LOW = new THREE.SphereGeometry(1, 16, 12);

function readVec(P, j, out) {
  return out.set(P[j * 3], P[j * 3 + 1], P[j * 3 + 2]);
}

// a を b に直交化して正規化
function orthoNormalize(a, b, fallback) {
  a.addScaledVector(b, -a.dot(b));
  const l = a.length();
  if (l < 1e-6) return a.copy(fallback);
  return a.multiplyScalar(1 / l);
}

/** 2点を結ぶテーパー付きの筒（両端は関節の球で隠れる） */
class Segment {
  constructor(rStart, rEnd, material, radial = 22) {
    const geo = new THREE.CylinderGeometry(rEnd, rStart, 1, radial, 1, true);
    geo.translate(0, 0.5, 0);
    this.mesh = new THREE.Mesh(geo, material);
  }
  place(a, b) {
    _a.subVectors(b, a);
    const len = _a.length();
    this.mesh.position.copy(a);
    if (len > 1e-6) this.mesh.quaternion.setFromUnitVectors(UP, _a.multiplyScalar(1 / len));
    this.mesh.scale.set(1, Math.max(len, 1e-4), 1);
  }
}

/** 向きと大きさを指定できる楕円体 */
class Ellipsoid {
  constructor(material, geo = SPHERE) {
    this.mesh = new THREE.Mesh(geo, material);
  }
  place(center, x, y, z, sx, sy, sz) {
    _m4.makeBasis(x, y, z);
    this.mesh.quaternion.setFromRotationMatrix(_m4);
    this.mesh.position.copy(center);
    this.mesh.scale.set(sx, sy, sz);
  }
}

function makeJoint(r, material, geo = SPHERE) {
  const mesh = new THREE.Mesh(geo, material);
  mesh.scale.setScalar(r);
  return mesh;
}

/** デッサン人形のような3Dモデル */
class Mannequin {
  constructor(mats) {
    this.group = new THREE.Group();
    const g = this.group;
    const add = (part) => { g.add(part.mesh || part); return part; };

    this.chest = add(new Ellipsoid(mats.body));
    this.pelvis = add(new Ellipsoid(mats.body));
    this.head = add(new Ellipsoid(mats.body));
    this.abdomen = add(new Segment(0.098, 0.112, mats.body));
    this.neck = add(new Segment(0.05, 0.044, mats.body));
    this.nose = add(makeJoint(0.022, mats.joint));

    this.limbs = {};
    for (const s of ['L', 'R']) {
      const m = mats[s];
      this.limbs[s] = {
        upperArm: add(new Segment(0.05, 0.04, m)),
        forearm: add(new Segment(0.039, 0.03, m)),
        thigh: add(new Segment(0.078, 0.056, m)),
        shin: add(new Segment(0.055, 0.037, m)),
        hand: add(new Ellipsoid(m)),
        foot: add(new Ellipsoid(m)),
        shoulder: add(makeJoint(0.057, mats.joint)),
        elbow: add(makeJoint(0.044, mats.joint)),
        wrist: add(makeJoint(0.033, mats.joint)),
        hip: add(makeJoint(0.072, mats.joint)),
        knee: add(makeJoint(0.058, mats.joint)),
        ankle: add(makeJoint(0.042, mats.joint)),
      };
    }
    this.v = {};
    for (const k of ['ls', 'rs', 'lh', 'rh', 'sm', 'hm', 'spine', 'x', 'z', 'c', 'c2', 'ear', 'nose', 'le', 're', 'tmp']) this.v[k] = new THREE.Vector3();
    this.j = Array.from({ length: N }, () => new THREE.Vector3());
  }

  setShadow(on) {
    this.group.traverse((o) => { if (o.isMesh) o.castShadow = on; });
  }

  update(P) {
    const J = this.j;
    for (let i = 0; i < N; i++) readVec(P, i, J[i]);
    const v = this.v;
    const ls = J[LM.L_SHOULDER], rs = J[LM.R_SHOULDER], lh = J[LM.L_HIP], rh = J[LM.R_HIP];
    v.sm.addVectors(ls, rs).multiplyScalar(0.5);
    v.hm.addVectors(lh, rh).multiplyScalar(0.5);
    v.spine.subVectors(v.sm, v.hm);
    const spineLen = Math.max(0.2, v.spine.length());
    const up = v.spine.multiplyScalar(1 / spineLen);

    // 胸
    const shoulderW = ls.distanceTo(rs);
    orthoNormalize(v.x.subVectors(ls, rs), up, AXIS_X);
    v.z.crossVectors(v.x, up);
    v.c.copy(v.sm).addScaledVector(up, -spineLen * 0.21);
    this.chest.place(v.c, v.x, up, v.z, Math.max(0.12, shoulderW * 0.47), spineLen * 0.31, 0.115);

    // 骨盤
    const hipW = lh.distanceTo(rh);
    orthoNormalize(v.x.subVectors(lh, rh), up, AXIS_X);
    v.z.crossVectors(v.x, up);
    v.c2.copy(v.hm).addScaledVector(up, spineLen * 0.07);
    this.pelvis.place(v.c2, v.x, up, v.z, Math.max(0.13, hipW * 0.5 * 1.42), spineLen * 0.19, 0.105);
    this.abdomen.place(v.c2, v.c);

    // 頭（両耳の中点と鼻から向きを決める）
    const lear = J[LM.L_EAR], rear = J[LM.R_EAR], nose = J[LM.NOSE];
    v.ear.addVectors(lear, rear).multiplyScalar(0.5);
    const hx = v.le.subVectors(lear, rear);
    if (hx.lengthSq() < 1e-8) hx.set(1, 0, 0);
    hx.normalize();
    const hz = orthoNormalize(v.re.subVectors(nose, v.ear), hx, AXIS_Z);
    const hy = v.nose.crossVectors(hz, hx).normalize();
    const headC = v.c.copy(v.ear).addScaledVector(hy, 0.03).addScaledVector(hz, 0.008);
    this.head.place(headC, hx, hy, hz, 0.079, 0.108, 0.099);
    this.nose.position.copy(headC).addScaledVector(hz, 0.098).addScaledVector(hy, -0.028);
    v.tmp.copy(headC).addScaledVector(hy, -0.075);
    this.neck.place(v.sm, v.tmp);

    // 腕・脚
    const idx = {
      L: [LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST, LM.L_INDEX, LM.L_PINKY, LM.L_HIP, LM.L_KNEE, LM.L_ANKLE, LM.L_HEEL, LM.L_FOOT],
      R: [LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST, LM.R_INDEX, LM.R_PINKY, LM.R_HIP, LM.R_KNEE, LM.R_ANKLE, LM.R_HEEL, LM.R_FOOT],
    };
    for (const s of ['L', 'R']) {
      const [sh, el, wr, ix, pk, hp, kn, an, he, ft] = idx[s].map((k) => J[k]);
      const L = this.limbs[s];
      L.upperArm.place(sh, el);
      L.forearm.place(el, wr);
      L.thigh.place(hp, kn);
      L.shin.place(kn, an);
      L.shoulder.position.copy(sh);
      L.elbow.position.copy(el);
      L.wrist.position.copy(wr);
      L.hip.position.copy(hp);
      L.knee.position.copy(kn);
      L.ankle.position.copy(an);
      placeHand(L.hand, wr, ix, pk);
      placeFoot(L.foot, he, ft);
    }
  }
}

const _hy = new THREE.Vector3(), _hx = new THREE.Vector3(), _hz = new THREE.Vector3(), _hc = new THREE.Vector3();
function placeHand(part, wrist, index, pinky) {
  _hc.addVectors(index, pinky).multiplyScalar(0.5);
  _hy.subVectors(_hc, wrist);
  const len = Math.max(0.05, _hy.length());
  _hy.multiplyScalar(1 / len);
  orthoNormalize(_hx.subVectors(index, pinky), _hy, AXIS_X);
  _hz.crossVectors(_hx, _hy);
  _hc.copy(wrist).addScaledVector(_hy, len * 0.6);
  part.place(_hc, _hx, _hy, _hz, 0.042, len * 0.62 + 0.012, 0.021);
}

function placeFoot(part, heel, toe) {
  _hy.subVectors(toe, heel);
  const len = Math.max(0.12, _hy.length());
  _hy.normalize();
  _hx.crossVectors(UP, _hy);
  if (_hx.lengthSq() < 1e-6) orthoNormalize(_hx.copy(AXIS_X), _hy, AXIS_Z);
  else _hx.normalize();
  _hz.crossVectors(_hx, _hy);
  _hc.addVectors(heel, toe).multiplyScalar(0.5).addScaledVector(UP, 0.022);
  part.place(_hc, _hx, _hy, _hz, 0.046, len * 0.6, 0.033);
}

/** 点と線の骨格表示 */
class StickFigure {
  constructor(mats) {
    this.group = new THREE.Group();
    this.points = SKELETON_POINTS.map((j) => {
      const mesh = makeJoint(j === LM.NOSE ? 0.03 : 0.022, mats[SIDE[j]] || mats.C, SPHERE_LOW);
      this.group.add(mesh);
      return { j, mesh };
    });
    this.bones = BONES.map(([a, b]) => {
      const seg = new Segment(0.011, 0.011, mats[boneSide(a, b)] || mats.C, 8);
      this.group.add(seg.mesh);
      return { a, b, seg };
    });
    this.va = new THREE.Vector3();
    this.vb = new THREE.Vector3();
  }
  setShadow(on) {
    this.group.traverse((o) => { if (o.isMesh) o.castShadow = on; });
  }
  update(P) {
    for (const p of this.points) readVec(P, p.j, p.mesh.position);
    for (const b of this.bones) b.seg.place(readVec(P, b.a, this.va), readVec(P, b.b, this.vb));
  }
}

function standardMaterials() {
  const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.04, ...extra });
  const body = std('#dfe4ec');
  return {
    body,
    C: body,
    joint: std('#768296', { roughness: 0.38 }),
    L: std(COLORS.L, { roughness: 0.5 }),
    R: std(COLORS.R, { roughness: 0.5 }),
  };
}

function ghostMaterials() {
  const g = new THREE.MeshStandardMaterial({
    color: COLORS.ghost, roughness: 0.6, metalness: 0, transparent: true, opacity: 0.4, depthWrite: false,
  });
  return { body: g, C: g, joint: g, L: g, R: g };
}

function backgroundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d');
  const grd = ctx.createRadialGradient(256, 190, 20, 256, 230, 380);
  grd.addColorStop(0, '#222a3a');
  grd.addColorStop(0.55, '#141922');
  grd.addColorStop(1, '#0b0d12');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function floorGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const grd = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, 'rgba(110,170,255,0.20)');
  grd.addColorStop(0.6, 'rgba(110,170,255,0.06)');
  grd.addColorStop(1, 'rgba(110,170,255,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Viewer3D {
  constructor(container) {
    this.container = container;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = backgroundTexture();
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 80);
    this.camera.position.set(0, 1.1, 3.6);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.minDistance = 0.6;
    this.controls.maxDistance = 14;
    this.controls.target.set(0, 0.95, 0);
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('start', () => {
      this.anim = null;
      this.onUserOrbit?.();
    });

    this.buildEnvironment();

    this.mats = standardMaterials();
    this.mannequin = new Mannequin(this.mats);
    this.stick = new StickFigure(this.mats);
    this.mannequin.setShadow(true);
    this.stick.setShadow(true);
    scene.add(this.mannequin.group, this.stick.group);

    const gm = ghostMaterials();
    this.ghostGroup = new THREE.Group();
    this.ghostMannequin = new Mannequin(gm);
    this.ghostStick = new StickFigure(gm);
    this.ghostGroup.add(this.ghostMannequin.group, this.ghostStick.group);
    this.ghostGroup.visible = false;
    this.ghostGroup.traverse((o) => { if (o.isMesh) o.renderOrder = 2; });
    scene.add(this.ghostGroup);

    // 手首の軌跡（直近 / クリップ全体）
    this.trailMat = new LineMaterial({ color: 0xffffff, linewidth: 4, vertexColors: true, transparent: true, depthWrite: false, worldUnits: false });
    this.trail = new Line2(new LineGeometry(), this.trailMat);
    this.trail.renderOrder = 3;
    this.pathMat = new LineMaterial({ color: COLORS.R, linewidth: 1.5, transparent: true, opacity: 0.28, depthWrite: false, worldUnits: false });
    this.path = new Line2(new LineGeometry(), this.pathMat);
    this.path.renderOrder = 1;
    this.trail.visible = this.path.visible = false;
    scene.add(this.trail, this.path);

    this.P = new Float32Array(N * 3);
    this.GP = new Float32Array(N * 3);
    this.motion = null;
    this.ghost = null;
    this.mode = 'mannequin';
    this.handedness = 'right';
    this.trailOn = true;
    this.trailSeconds = 0.6;
    this.timeScale = 1;
    this.facingYaw = 0;
    this.targetY = 0.95;
    this.view = 'camera';
    this.sph0 = new THREE.Spherical();
    this.sph1 = new THREE.Spherical();
    this.sphT = new THREE.Spherical();
    this.dirty = true;
    this.applyMode();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
  }

  buildEnvironment() {
    const scene = this.scene;
    scene.add(new THREE.HemisphereLight(0xe6eeff, 0x1d2330, 1.05));
    const key = new THREE.DirectionalLight(0xffffff, 1.75);
    key.position.set(2.2, 4.4, 2.9);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = -2; sc.right = 2; sc.top = 2.4; sc.bottom = -1.6; sc.near = 0.5; sc.far = 14;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9db8ff, 0.75);
    rim.position.set(-2.6, 2.6, -3.2);
    scene.add(rim);

    const shadowFloor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.ShadowMaterial({ opacity: 0.34 }));
    shadowFloor.rotation.x = -Math.PI / 2;
    shadowFloor.receiveShadow = true;
    scene.add(shadowFloor);

    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(1.7, 64),
      new THREE.MeshBasicMaterial({ map: floorGlowTexture(), transparent: true, depthWrite: false }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.001;
    scene.add(glow);

    const grid = new THREE.GridHelper(8, 32, 0x44506a, 0x262d3a);
    grid.material.transparent = true;
    grid.material.opacity = 0.6;
    grid.material.depthWrite = false;
    grid.position.y = 0.002;
    scene.add(grid);
  }

  resize() {
    const r = this.container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.trailMat.resolution.set(w, h);
    this.pathMat.resolution.set(w, h);
    this.dirty = true;
    this.tick();
  }

  /** 新しい動きデータを表示する */
  setMotion(motion, { handedness = 'right', timeScale = 1, resetView = false } = {}) {
    const first = !this.motion;
    this.motion = motion;
    this.handedness = handedness;
    this.timeScale = timeScale;
    this.facingYaw = motion.facingYaw;
    this.targetY = Math.min(1.25, Math.max(0.6, motion.hipHeight + 0.05));
    this.buildPath();
    this.alignGhost();
    if (first || resetView) this.setView(this.view, false);
    this.dirty = true;
  }

  clear() {
    this.motion = null;
    this.clearGhost();
    this.trail.visible = this.path.visible = false;
    this.dirty = true;
  }

  setMode(mode) {
    this.mode = mode;
    this.applyMode();
    this.dirty = true;
  }

  applyMode() {
    const m = this.mode === 'mannequin';
    this.mannequin.group.visible = m;
    this.stick.group.visible = !m;
    this.ghostMannequin.group.visible = m;
    this.ghostStick.group.visible = !m;
  }

  setTrail(on) {
    this.trailOn = on;
    this.pathKey = '';
    if (!on) this.trail.visible = this.path.visible = false;
    this.dirty = true;
  }

  get wristIndex() { return this.handedness === 'left' ? LM.L_WRIST : LM.R_WRIST; }

  buildPath() {
    this.pathKey = '';
    this.pathMat.color.set(this.handedness === 'left' ? COLORS.L : COLORS.R);
  }

  // 今の前後の手首の通り道（うすい線）。表示範囲が変わったときだけ作り直す
  updatePath(t) {
    const m = this.motion;
    if (!m || !this.trailOn) { this.path.visible = false; return; }
    const before = 1.4 / this.timeScale, after = 0.8 / this.timeScale;
    const i0 = Math.max(0, Math.floor((t - before - m.start) * m.fps));
    const i1 = Math.min(m.n - 1, Math.ceil((t + after - m.start) * m.fps));
    const w = this.wristIndex;
    const key = `${i0}:${i1}:${w}`;
    if (key === this.pathKey) return;
    this.pathKey = key;
    if (i1 - i0 < 2) { this.path.visible = false; return; }
    const pts = [];
    for (let i = i0; i <= i1; i++) {
      const o = i * N * 3 + w * 3;
      pts.push(m.pos[o], m.pos[o + 1], m.pos[o + 2]);
    }
    this.path.geometry.dispose();
    this.path.geometry = new LineGeometry();
    this.path.geometry.setPositions(pts);
    this.path.visible = true;
  }

  updateTrail(t) {
    const m = this.motion;
    if (!m || !this.trailOn) { this.trail.visible = false; return; }
    const w = this.wristIndex;
    const span = this.trailSeconds / this.timeScale; // 実時間で一定の長さ
    const t0 = Math.max(m.start, t - span);
    const i0 = Math.ceil((t0 - m.start) * m.fps);
    const iNow = (t - m.start) * m.fps;
    const pts = [];
    const ts = [];
    for (let i = i0; i < iNow && i < m.n; i++) {
      const o = i * N * 3 + w * 3;
      pts.push(m.pos[o], m.pos[o + 1], m.pos[o + 2]);
      ts.push(m.times[i]);
    }
    pts.push(this.P[w * 3], this.P[w * 3 + 1], this.P[w * 3 + 2]);
    ts.push(t);
    if (pts.length < 6) { this.trail.visible = false; return; }
    const base = new THREE.Color(this.handedness === 'left' ? COLORS.L : COLORS.R);
    const bright = base.clone().lerp(new THREE.Color('#ffffff'), 0.35);
    const dark = new THREE.Color('#141922');
    const cols = [];
    const c = new THREE.Color();
    for (let k = 0; k < ts.length; k++) {
      const a = Math.min(1, Math.max(0, 1 - (t - ts[k]) / span));
      c.copy(dark).lerp(bright, a * a);
      cols.push(c.r, c.g, c.b);
    }
    this.trail.geometry.dispose();
    this.trail.geometry = new LineGeometry();
    this.trail.geometry.setPositions(pts);
    this.trail.geometry.setColors(cols);
    this.trail.visible = true;
  }

  /** 比較用の動きを設定（offset: 比較側の時刻 = 本体の時刻 + offset） */
  setGhost(motion, { offset = 0, layout = 'overlay' } = {}) {
    this.ghost = { motion, offset, layout };
    this.ghostGroup.visible = true;
    this.alignGhost();
    this.dirty = true;
  }

  setGhostOffset(offset) { if (this.ghost) { this.ghost.offset = offset; this.dirty = true; } }
  setGhostLayout(layout) { if (this.ghost) { this.ghost.layout = layout; this.alignGhost(); this.dirty = true; } }

  clearGhost() {
    this.ghost = null;
    this.ghostGroup.visible = false;
    this.dirty = true;
  }

  alignGhost() {
    if (!this.ghost) return;
    // 体の向きをそろえる（どちらも腰の中心が原点）
    this.ghostGroup.rotation.y = this.facingYaw - this.ghost.motion.facingYaw;
    if (this.ghost.layout === 'side') {
      // 本体の右側に並べる
      const rx = -Math.cos(this.facingYaw), rz = Math.sin(this.facingYaw);
      this.ghostGroup.position.set(rx * 1.0, 0, rz * 1.0);
    } else {
      this.ghostGroup.position.set(0, 0, 0);
    }
  }

  /** 時刻 t の姿勢を表示 */
  setTime(t) {
    if (!this.motion) return;
    samplePose(this.motion, t, this.P);
    if (this.mode === 'mannequin') this.mannequin.update(this.P); else this.stick.update(this.P);
    this.updateTrail(t);
    this.updatePath(t);
    if (this.ghost) {
      samplePose(this.ghost.motion, t + this.ghost.offset, this.GP);
      if (this.mode === 'mannequin') this.ghostMannequin.update(this.GP); else this.ghostStick.update(this.GP);
    }
    this.lastT = t;
    this.dirty = true;
  }

  refresh() {
    if (this.lastT != null) this.setTime(this.lastT);
  }

  /** 視点のプリセット */
  setView(name, animate = true) {
    this.view = name;
    const yaw = this.facingYaw;
    const F = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const R = new THREE.Vector3(-F.z, 0, F.x);
    const target = new THREE.Vector3(0, this.targetY, 0);
    const half = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const D = Math.max(3.3, 1.05 / (Math.tan(half) * Math.max(0.3, this.camera.aspect)));
    const pos = new THREE.Vector3();
    switch (name) {
      case 'front': pos.copy(target).addScaledVector(F, D).add(_b.set(0, 0.35, 0)); break;
      case 'back': pos.copy(target).addScaledVector(F, -D).add(_b.set(0, 0.4, 0)); break;
      case 'right': pos.copy(target).addScaledVector(R, D).add(_b.set(0, 0.35, 0)); break;
      case 'left': pos.copy(target).addScaledVector(R, -D).add(_b.set(0, 0.35, 0)); break;
      case 'top': pos.copy(target).add(_b.set(0, D * 1.05, 0)).addScaledVector(F, -0.02); target.y = 0.4; break;
      case 'camera':
      default: pos.set(0, this.targetY + 0.75, D); break;
    }
    if (!animate) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      this.anim = null;
    } else {
      this.anim = {
        t0: performance.now(), dur: 520,
        fromPos: this.camera.position.clone(), toPos: pos,
        fromTarget: this.controls.target.clone(), toTarget: target,
      };
    }
    this.dirty = true;
  }

  /** 毎フレーム呼ぶ。必要なときだけ描画する */
  tick() {
    if (this.anim) {
      const a = this.anim;
      let k = (performance.now() - a.t0) / a.dur;
      if (k >= 1) { k = 1; this.anim = null; }
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      // ターゲットの周りを回り込むように、球面座標（方位・仰角・距離）で補間する
      const s0 = this.sph0.setFromVector3(_a.subVectors(a.fromPos, a.fromTarget));
      const s1 = this.sph1.setFromVector3(_b.subVectors(a.toPos, a.toTarget));
      let dTheta = s1.theta - s0.theta;
      if (dTheta > Math.PI) dTheta -= Math.PI * 2;
      if (dTheta < -Math.PI) dTheta += Math.PI * 2;
      this.sphT.set(
        s0.radius + (s1.radius - s0.radius) * e,
        s0.phi + (s1.phi - s0.phi) * e,
        s0.theta + dTheta * e,
      );
      this.controls.target.lerpVectors(a.fromTarget, a.toTarget, e);
      this.camera.position.copy(this.controls.target).add(_a.setFromSpherical(this.sphT));
      this.dirty = true;
    }
    if (this.controls.update()) this.dirty = true;
    if (this.dirty) {
      this.renderer.render(this.scene, this.camera);
      this.dirty = false;
    }
  }

  /** 今の3D画面をPNG画像（Blob）で返す */
  snapshot() {
    this.renderer.render(this.scene, this.camera);
    return new Promise((resolve, reject) => {
      this.renderer.domElement.toBlob((b) => (b ? resolve(b) : reject(new Error('画像を作れませんでした'))), 'image/png');
    });
  }

  get canvas() { return this.renderer.domElement; }
}
