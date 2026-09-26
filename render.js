// 렌더 레이어 — 슬롯(에셋)마다 InstancedMesh 하나 + 하단 마시멜로 젤리 메시(텍스처 격자) + 떠 있는 멜로우봇 GLB. 시뮬 상태를 매 프레임 행렬/정점으로 옮긴다.
import * as THREE from 'three';
import { MAX, BINS, JROWS } from './sim.js';

export class Renderer {
  constructor(canvas, view) {
    this.view = view;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 200);
    this.camera.position.z = 20;
    this.scene.add(new THREE.AmbientLight(0xffe0c4, 1.0));
    const key = new THREE.DirectionalLight(0xfff1e0, 2.2); key.position.set(3, 6, 10); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xffb27a, 0.7); rim.position.set(-5, -2, 6); this.scene.add(rim);
    this.meshes = new Map(); // slotId -> InstancedMesh
    this.dummy = new THREE.Object3D();
    this.wire = false;
    this.buildPile();
    this.buildMallows();
    this.pileMode = '3d';
    this.resize();
  }

  // 마시멜로 젤리 메시: BINS x JROWS 격자. 정점을 매 프레임 시뮬의 젤리 위치로 옮긴다 (Live2D 식 메시 변형).
  // 텍스처는 세로로 메시 높이에 맞추고 가로로는 원본 비율을 지켜 반복. alphaTest 로 투명 부분은 depth 를 쓰지 않는다.
  // 마스코트(z -1.6 이하) 앞, 파티클(z -1~1) 뒤 — 불투명 픽셀은 depthWrite 로 멜로우봇의 잠긴 부분을 가린다.
  buildPile() {
    const geo = new THREE.PlaneGeometry(1, 1, BINS - 1, JROWS - 1);
    geo.attributes.position.setUsage(THREE.DynamicDrawUsage); geo.attributes.uv.setUsage(THREE.DynamicDrawUsage);
    this.pileMat = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.5, depthWrite: true, side: THREE.DoubleSide, color: 0xffffff });
    this.pile = new THREE.Mesh(geo, this.pileMat); this.pile.position.z = -1.2; this.pile.renderOrder = 1; this.pile.frustumCulled = false;
    this.pile.visible = false; this.pileAspect = 1;
    this.scene.add(this.pile);
    this._p = [0, 0];
  }
  // 텍스처 교체 (three Texture). 가로 반복, 세로 클램프.
  setPileTexture(tex) {
    if (!tex) return;
    tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.needsUpdate = true;
    const img = tex.image; this.pileAspect = (img?.width || img?.naturalWidth || 1) / (img?.height || img?.naturalHeight || 1);
    if (this.pileMat.map) this.pileMat.map.dispose();
    this.pileMat.map = tex; this.pileMat.needsUpdate = true;
  }

  updatePile(sim) {
    const L = sim.liquid, W = this.view.width;
    const visible = this.pileMode === '2d' && L.level > 0.02 && !!this.pileMat.map;
    this.pile.visible = visible;
    if (!visible) return;
    const pos = this.pile.geometry.attributes.position, uv = this.pile.geometry.attributes.uv, p = this._p;
    const meshH = (L.level + 0.5) * sim.pileScale, tiles = Math.max(0.5, W / (meshH * this.pileAspect)); // 원본 비율 유지 반복 횟수
    // PlaneGeometry 정점 순서: iy=0 이 윗줄. 젤리 행 r = JROWS-1-iy
    for (let iy = 0; iy < JROWS; iy++) {
      const r = JROWS - 1 - iy, v = r / (JROWS - 1);
      for (let ix = 0; ix < BINS; ix++) {
        const idx = iy * BINS + ix;
        sim.jellyPos(ix, r, p);
        pos.setXY(idx, p[0], p[1]);
        uv.setXY(idx, (ix / (BINS - 1)) * tiles, v);
      }
    }
    pos.needsUpdate = true; uv.needsUpdate = true;
  }


  // ---------- 2.5D 마시멜로: 둥근 원기둥 인스턴스를 줄지어 쌓는다. 전체 더미가 높이(level)에 따라 통째로 오르내리고, 젤리 변위로 위치·기울기가 흔들린다 ----------
  static MALLOW = { spacing: 0.98, rowH: 0.8, size: 0.92, zMin: -1.1, zMax: -0.35 };
  buildMallows() {
    // 프로파일: 반지름 0.5, 높이 0.9, 모서리 라운드 0.16 인 원기둥 (Lathe)
    const R = 0.5, H = 0.9, rr = 0.16, pts = [];
    pts.push(new THREE.Vector2(0, -H / 2));
    for (let i = 0; i <= 6; i++) { const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2); pts.push(new THREE.Vector2(R - rr + Math.cos(a) * rr, -H / 2 + rr + Math.sin(a) * rr)); }
    for (let i = 0; i <= 6; i++) { const a = (i / 6) * (Math.PI / 2); pts.push(new THREE.Vector2(R - rr + Math.cos(a) * rr, H / 2 - rr + Math.sin(a) * rr)); }
    pts.push(new THREE.Vector2(0, H / 2));
    const geo = new THREE.LatheGeometry(pts, 28);
    const mat = new THREE.MeshStandardMaterial({ color: 0xfff6ea, roughness: 0.92, metalness: 0, flatShading: false });
    this.mallowMat = mat;
    this.mallows = new THREE.InstancedMesh(geo, mat, 1024);
    this.mallows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mallows.frustumCulled = false; this.mallows.count = 0; this.mallows.renderOrder = 1;
    this.scene.add(this.mallows);
    this.mallowLayout = [];
    // 마시멜로 전용 부드러운 채움광 (아래에서 살짝) — 그늘진 아랫면이 너무 어둡지 않게
    const fill = new THREE.DirectionalLight(0xffe9d6, 0.5); fill.position.set(0, -3, 8); this.scene.add(fill);
    this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._d = [0, 0];
  }
  // 화면 폭에 맞춰 배치 재계산 (리사이즈 시). 시드 기반 결정적 난수라 매번 같은 더미가 나온다.
  layoutMallows() {
    const M = Renderer.MALLOW, W = this.view.width, G = this.view.ground;
    const cols = Math.ceil(W / M.spacing) + 2, rows = Math.ceil((9 + 1.5) / M.rowH); // maxLevel 9 까지 채울 행 수
    let seed = 1234; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const out = [], colors = this.mallows.instanceColor ?? new THREE.InstancedBufferAttribute(new Float32Array(1024 * 3), 3);
    const c = new THREE.Color();
    for (let r = 0; r < rows && out.length < 1024; r++) {
      for (let k = 0; k < cols && out.length < 1024; k++) {
        const x = -W / 2 + (k + (r % 2 ? 0.5 : 0)) * M.spacing + (rnd() - 0.5) * 0.22;
        const yRest = (r + 0.5) * M.rowH + (rnd() - 0.5) * 0.12;     // 더미 바닥(0) 기준 정지 높이
        const z = M.zMin + rnd() * (M.zMax - M.zMin);
        const sc = M.size * (0.86 + rnd() * 0.24);
        // 방향: 60% 가로로 누움, 25% 끝면이 카메라 쪽, 15% 세움 — 살짝씩 비틀어 자연스럽게
        const t = rnd(); let rx, ry, rz;
        if (t < 0.6) { rz = Math.PI / 2 + (rnd() - 0.5) * 0.7; ry = (rnd() - 0.5) * 1.2; rx = (rnd() - 0.5) * 0.5; }
        else if (t < 0.85) { rx = Math.PI / 2 + (rnd() - 0.5) * 0.6; ry = (rnd() - 0.5) * 0.4; rz = (rnd() - 0.5) * 1.5; }
        else { rx = (rnd() - 0.5) * 0.4; ry = rnd() * Math.PI; rz = (rnd() - 0.5) * 0.4; }
        c.setHSL(0.09 + rnd() * 0.03, 0.08 + rnd() * 0.14, 0.94 + rnd() * 0.05);
        colors.setXYZ(out.length, c.r, c.g, c.b);
        out.push({ x, yRest, z, sc, rx, ry, rz, col: 0 });
      }
    }
    for (const m of out) m.col = Math.min(BINS - 1, Math.max(0, Math.floor((m.x + W / 2) / W * BINS)));
    this.mallowLayout = out;
    if (!this.mallows.instanceColor) { this.mallows.instanceColor = colors; }
    this.mallows.instanceColor.needsUpdate = true;
  }
  setPileMode(mode) { this.pileMode = mode; }
  updateMallows(sim) {
    const L = sim.liquid, G = this.view.ground, M = Renderer.MALLOW, m = this.mallows;
    const visible = this.pileMode === '3d' && L.level > 0.02;
    m.visible = visible; if (!visible) { m.count = 0; return; }
    // 더미 전체를 올린다: 맨 윗줄 마시멜로의 윗면이 기준면(ground + level)에 오도록
    const rows = Math.ceil((9 + 1.5) / M.rowH), pileTopRest = rows * M.rowH;
    const base = G + L.level - pileTopRest - 0.05, bottom = sim.jellyBottom();
    const d = this.dummy, q = this._q, e = this._e, disp = this._d;
    let n = 0;
    for (const k of this.mallowLayout) {
      const surf = sim.surfaceAt(k.col);
      const f = Math.max(0, Math.min(1, (base + k.yRest - bottom) / Math.max(0.1, surf - bottom))); // 더미 안에서의 높이 비율
      const y0 = base + k.yRest + L.wave[k.col] * f;
      if (y0 + 0.6 < G - 0.2) continue;                       // 화면 아래 → 그리지 않음
      sim.jellyDisp(k.col, f, disp);
      d.position.set(k.x + disp[0], y0 + disp[1], k.z);
      e.set(k.rx + disp[1] * 0.6, k.ry, k.rz - disp[0] * 0.9); q.setFromEuler(e); d.quaternion.copy(q);
      d.scale.set(k.sc, k.sc * (1 - disp[1] * 0.25), k.sc);   // 눌리면 살짝 찌부러짐
      d.updateMatrix(); m.setMatrixAt(n++, d.matrix);
    }
    m.count = n; m.instanceMatrix.needsUpdate = true;
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.view.setViewport(w, h);
    this.layoutMallows();
    const W = this.view.width;
    this.camera.left = -W / 2; this.camera.right = W / 2; this.camera.top = this.view.top; this.camera.bottom = this.view.ground;
    this.camera.updateProjectionMatrix();
  }

  ensureMesh(asset) {
    let m = this.meshes.get(asset.id);
    if (m) return m;
    m = new THREE.InstancedMesh(asset.geometry, asset.material, MAX);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false; m.count = 0; m.userData.tier = asset.tier;
    this.scene.add(m); this.meshes.set(asset.id, m);
    return m;
  }

  // 떠 있는 멜로우봇: GLB 씬을 받아 높이를 맞추고 바운딩 중심을 피벗으로. 마시멜로 메시(z -1.2) 뒤에 두어 잠긴 부분이 가려진다.
  setFloater(object, { height = 4.5 } = {}) {
    if (this.floater) { this.scene.remove(this.floater); this.floater = null; }
    if (!object) return null;
    const box = new THREE.Box3().setFromObject(object), size = new THREE.Vector3(), center = new THREE.Vector3();
    box.getSize(size); box.getCenter(center);
    const sc = height / size.y;
    const pivot = new THREE.Group();
    object.position.sub(center).multiplyScalar(sc); object.scale.setScalar(sc);
    pivot.add(object);
    const depth = size.z * sc;
    // 자유 회전하므로 바운딩 구 반경만큼 뒤로 — 어떤 방향으로 돌아도 마시멜로 평면(z -1.2)을 뚫지 않는다
    const radius = Math.hypot(size.x, size.y, size.z) * sc / 2;
    pivot.userData.z = -1.2 - radius - 0.1;
    this.floater = pivot; this.scene.add(pivot);
    return { width: size.x * sc, height, depth };
  }
  setFloaterVisible(v) { if (this.floater) this.floater.visible = v; }
  updateFloater(sim) {
    const F = sim.floater, m = this.floater; if (!F || !m) return;
    m.position.set(F.x, F.y, m.userData.z); m.quaternion.set(F.q[0], F.q[1], F.q[2], F.q[3]);
  }

  dropMesh(id) { const m = this.meshes.get(id); if (!m) return; this.scene.remove(m); this.meshes.delete(id); }

  setWireframe(on) {
    this.wire = on;
    for (const m of this.meshes.values()) for (const mat of (Array.isArray(m.material) ? m.material : [m.material])) mat.wireframe = on;
    this.pileMat.wireframe = on; this.mallowMat.wireframe = on;
  }

  draw(sim) {
    for (const [id, a] of sim.assets) this.ensureMesh(a);
    for (const m of this.meshes.values()) m.count = 0;
    const d = this.dummy;
    for (const i of sim.active) {
      const m = this.meshes.get(sim.slot[i]); if (!m) continue;
      d.position.set(sim.x[i], sim.y[i], (sim.seed[i] % 1) * 2 - 1);
      if (m.userData.tier === 1) d.rotation.set(0, 0, sim.rz[i]); else d.rotation.set(sim.rx[i], sim.ry[i], sim.rz[i]);
      d.scale.setScalar(sim.s[i]);
      d.updateMatrix();
      m.setMatrixAt(m.count++, d.matrix);
    }
    let draws = 0;
    for (const m of this.meshes.values()) { m.instanceMatrix.needsUpdate = true; if (m.count) draws++; }
    this.updatePile(sim); this.updateMallows(sim); this.updateFloater(sim);
    if (this.pile.visible) draws += 1; if (this.mallows.visible) draws += 1;
    this.renderer.render(this.scene, this.camera);
    return draws;
  }
}
