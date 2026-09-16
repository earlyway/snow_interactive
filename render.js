// 렌더 레이어 — 슬롯(에셋)마다 InstancedMesh 하나 + 하단 핫초코 액체 메시 + 떠 있는 멜로우봇 GLB. 시뮬 상태를 매 프레임 행렬/정점으로 옮긴다.
import * as THREE from 'three';
import { MAX, BINS } from './sim.js';

const COCOA_TOP = new THREE.Color(0x8b5a3a), COCOA_BOTTOM = new THREE.Color(0x2c160c), FOAM = new THREE.Color(0xf1dcc3);

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
    this.buildLiquid();
    this.resize();
  }

  // 액체: 폭 방향 BINS 세그먼트 스트립. 윗줄 정점 y 를 매 프레임 수면으로 옮긴다. 마스코트(z -1.6) 앞, 파티클(z -1~1) 뒤.
  buildLiquid() {
    const geo = new THREE.PlaneGeometry(1, 1, BINS - 1, 1);
    const n = geo.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const c = i < BINS ? COCOA_TOP : COCOA_BOTTOM; col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    // depthWrite 를 켜서 뒤(z<-1.2)에 있는 멜로우봇의 잠긴 부분을 가린다
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.96, depthWrite: true });
    this.liquid = new THREE.Mesh(geo, mat); this.liquid.position.z = -1.2; this.liquid.renderOrder = 1;
    this.scene.add(this.liquid);
    // 거품/크림 띠: 수면 위 얇은 밝은 선
    const fgeo = new THREE.PlaneGeometry(1, 1, BINS - 1, 1);
    this.foam = new THREE.Mesh(fgeo, new THREE.MeshBasicMaterial({ color: FOAM, transparent: true, opacity: 0.75, depthWrite: false }));
    this.foam.position.z = -1.1; this.foam.renderOrder = 2; this.scene.add(this.foam);
  }

  updateLiquid(sim) {
    const L = sim.liquid, W = this.view.width, G = this.view.ground;
    const visible = L.level > 0.005;
    this.liquid.visible = this.foam.visible = visible;
    if (!visible) return;
    const pos = this.liquid.geometry.attributes.position, fpos = this.foam.geometry.attributes.position;
    const bottom = G - 0.5, thick = 0.07 + Math.min(0.08, L.level * 0.03);
    for (let b = 0; b < BINS; b++) {
      const x = -W / 2 + (b / (BINS - 1)) * W, top = sim.surfaceAt(b);
      pos.setXY(b, x, top); pos.setXY(b + BINS, x, bottom);
      fpos.setXY(b, x, top + thick * 0.35); fpos.setXY(b + BINS, x, top - thick);
    }
    pos.needsUpdate = true; fpos.needsUpdate = true;
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.view.setViewport(w, h);
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

  // 떠 있는 멜로우봇: GLB 씬을 받아 높이를 맞추고 바운딩 중심을 피벗으로. 액체(z -1.2) 뒤에 두어 잠긴 부분이 가려진다.
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
    // 자유 회전하므로 바운딩 구 반경만큼 뒤로 — 어떤 방향으로 돌아도 액체 평면(z -1.2)을 뚫지 않는다
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
    this.liquid.material.wireframe = on;
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
    this.updateLiquid(sim); this.updateFloater(sim);
    if (this.liquid.visible) draws += 2;
    this.renderer.render(this.scene, this.camera);
    return draws;
  }
}
