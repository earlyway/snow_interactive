// 에셋 레이어 — 이미지/GLB → ParticleAsset { id, tier, geometry, material, boundingRadius, triCount, textureSize, name }
// 시뮬/렌더는 이 인터페이스만 본다. 티어가 바뀌어도 나머지 레이어는 무변경.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

let nextId = 1;
const BUDGET_TOTAL_TRIS = 3_000_000; // NFR-07, M1 안전선

export function triCountOf(geometry) {
  return geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
}

// 바운딩 박스 정규화(최대 변 = 1) + 피벗을 중심으로 (FR-35)
function normalize(geometry) {
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const size = new THREE.Vector3(); bb.getSize(size);
  const s = 1 / Math.max(size.x, size.y, size.z, 1e-6);
  const c = new THREE.Vector3(); bb.getCenter(c);
  geometry.translate(-c.x, -c.y, -c.z);
  geometry.scale(s, s, s);
  geometry.computeBoundingSphere();
  return geometry.boundingSphere.radius;
}

export function budgetCheck(asset, maxParticles) {
  const total = asset.triCount * maxParticles;
  return { total, ok: total <= BUDGET_TOTAL_TRIS, allowed: Math.floor(BUDGET_TOTAL_TRIS / Math.max(asset.triCount, 1)) };
}

// ---------- 이미지 로딩 & 분석 ----------
export async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('이미지를 읽을 수 없어요')); img.src = url; });
    if (Math.max(img.naturalWidth, img.naturalHeight) > 2048) throw new Error('이미지는 2048px 이하로 올려주세요 (FR-30)');
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
}

function toCanvas(img, maxDim) {
  const iw = img.naturalWidth || img.width || 512, ih = img.naturalHeight || img.height || 512; // SVG는 크기가 0일 수 있음
  const s = Math.min(1, maxDim / Math.max(iw, ih));
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(iw * s));
  c.height = Math.max(2, Math.round(ih * s));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

// 투명 배경 자동 감지: 알파가 없으면 네 모서리 평균색을 배경으로 취급
function toMask(canvas) {
  const { width: w, height: h } = canvas;
  const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let hasAlpha = false;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { hasAlpha = true; break; }
  const mask = new Uint8Array(w * h);
  if (hasAlpha) {
    for (let i = 0; i < w * h; i++) mask[i] = d[i * 4 + 3] > 128 ? 1 : 0;
  } else {
    const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + w - 1) * 4];
    const bg = [0, 1, 2].map(k => corners.reduce((a, o) => a + d[o + k], 0) / 4);
    for (let i = 0; i < w * h; i++) {
      const dr = d[i * 4] - bg[0], dg = d[i * 4 + 1] - bg[1], db = d[i * 4 + 2] - bg[2];
      mask[i] = Math.sqrt(dr * dr + dg * dg + db * db) > 60 ? 1 : 0;
    }
  }
  return { mask, w, h, hasAlpha, data: d };
}

function averageColor(data, mask) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { r += data[i * 4]; g += data[i * 4 + 1]; b += data[i * 4 + 2]; n++; }
  if (!n) return new THREE.Color(0xdddddd);
  return new THREE.Color(r / n / 255, g / n / 255, b / n / 255);
}

// 가장 큰 연결 성분만 남긴다 (배경 노이즈 · 잔여 픽셀 제거)
function largestComponent(mask, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  let best = -1, bestSize = 0, cur = 0;
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || label[i] >= 0) continue;
    let size = 0; stack.push(i); label[i] = cur;
    while (stack.length) {
      const p = stack.pop(); size++;
      const x = p % w, y = (p - x) / w;
      const nb = [p - 1, p + 1, p - w, p + w];
      if (x === 0) nb[0] = -1; if (x === w - 1) nb[1] = -1; if (y === 0) nb[2] = -1; if (y === h - 1) nb[3] = -1;
      for (const q of nb) if (q >= 0 && mask[q] && label[q] < 0) { label[q] = cur; stack.push(q); }
    }
    if (size > bestSize) { bestSize = size; best = cur; }
    cur++;
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = label[i] === best ? 1 : 0;
  return { fg: out, size: bestSize };
}

// Moore-neighbor 경계 추적 → 외곽 폴리곤 (픽셀 좌표)
function traceBoundary(fg, w, h) {
  let sx = -1, sy = -1;
  outer: for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (fg[y * w + x]) { sx = x; sy = y; break outer; }
  if (sx < 0) return [];
  // 시계방향 이웃 (이미지 좌표, y 아래): W, NW, N, NE, E, SE, S, SW
  const N = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
  const pts = [[sx, sy]];
  let px = sx, py = sy, bi = 0, guard = 0;
  const limit = w * h * 4;
  while (guard++ < limit) {
    let moved = false;
    for (let k = 1; k <= 8; k++) {
      const ni = (bi + k) % 8, nx = px + N[ni][0], ny = py + N[ni][1];
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && fg[ny * w + nx]) {
        const bx = px + N[(ni + 7) % 8][0], by = py + N[(ni + 7) % 8][1];
        px = nx; py = ny;
        bi = N.findIndex(d => d[0] === bx - px && d[1] === by - py); if (bi < 0) bi = 0;
        moved = true; break;
      }
    }
    if (!moved || (px === sx && py === sy)) break;
    pts.push([px, py]);
  }
  return pts;
}

// Ramer–Douglas–Peucker 폴리곤 단순화
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// ---------- 티어 1: 빌보드 스프라이트 (FR-31) ----------
export function makeBillboard(source, name = 'billboard') {
  const canvas = source instanceof HTMLCanvasElement ? source : toCanvas(source, 512);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const geometry = new THREE.PlaneGeometry(1, 1);
  // 이미지 비율 유지
  const ar = canvas.width / canvas.height;
  if (ar > 1) geometry.scale(1, 1 / ar, 1); else geometry.scale(ar, 1, 1);
  const material = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.12, depthWrite: false, side: THREE.DoubleSide });
  return { id: nextId++, tier: 1, name, geometry, material, boundingRadius: 0.5, triCount: 2, textureSize: `${canvas.width}×${canvas.height}` };
}

// ---------- 티어 2: 2.5D 압출 (FR-32) ----------
// budgetTris: 인스턴스당 삼각형 예산. 압출 tri ≈ 4n-4 이므로 예산을 넘으면 eps를 키워 재단순화.
export function makeExtruded(img, { thickness = 0.15, budgetTris = 500, name = 'extruded' } = {}) {
  const small = toCanvas(img, 220);
  const { mask, w, h, data } = toMask(small);
  const { fg, size } = largestComponent(mask, w, h);
  if (size < 30) throw new Error('외곽선을 찾지 못했어요. 배경이 투명한 PNG를 권장합니다.');
  const raw = traceBoundary(fg, w, h);
  if (raw.length < 8) throw new Error('외곽선이 너무 짧아요. 얇은 선 이미지는 압출이 어려워요.');

  let eps = 0.8, pts = simplify(raw, eps);
  while (4 * pts.length - 4 > budgetTris && eps < 40) { eps *= 1.4; pts = simplify(raw, eps); }
  if (pts.length < 3) throw new Error('단순화 후 폴리곤이 남지 않았어요.');

  // 픽셀 → 중심 기준, y 위로
  const cx = w / 2, cy = h / 2, sc = 1 / Math.max(w, h);
  const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2((x + 0.5 - cx) * sc, (cy - y - 0.5) * sc)));
  const bb = new THREE.Box2().setFromPoints(shape.getPoints());
  const uvgen = {
    generateTopUV(_g, v, a, b, c) {
      const uv = i => new THREE.Vector2((v[i * 3] - bb.min.x) / (bb.max.x - bb.min.x), (v[i * 3 + 1] - bb.min.y) / (bb.max.y - bb.min.y));
      return [uv(a), uv(b), uv(c)];
    },
    generateSideWallUV() { const z = new THREE.Vector2(0.5, 0.5); return [z, z, z, z]; }
  };
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, UVGenerator: uvgen });
  const boundingRadius = normalize(geometry);

  const texCanvas = toCanvas(img, 512);
  const tex = new THREE.CanvasTexture(texCanvas); tex.colorSpace = THREE.SRGBColorSpace;
  const capMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0.05, transparent: true, alphaTest: 0.1 });
  const sideMat = new THREE.MeshStandardMaterial({ color: averageColor(data, fg), roughness: 0.7 });
  return { id: nextId++, tier: 2, name, geometry, material: [capMat, sideMat], boundingRadius, triCount: triCountOf(geometry), textureSize: `${texCanvas.width}×${texCanvas.height}`, pointCount: pts.length };
}

// ---------- GLB 직접 업로드 (FR-34) ----------
const GLB_MAX_TRIS = 100_000; // 데시메이션(SimplifyModifier)이 O(n²)에 가까워 8만 tri ≈ 3.5s. 그 이상은 거부.
let gltfLoader = null;
function getGLTFLoader() {
  if (gltfLoader) return gltfLoader;
  gltfLoader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/gltf/');
  gltfLoader.setDRACOLoader(draco);
  gltfLoader.setMeshoptDecoder(MeshoptDecoder);
  return gltfLoader;
}

// 모델 안의 모든 메시를 position/normal/uv 만 남긴 non-indexed 지오메트리로 정리한다 (병합 전제 조건).
function flattenMesh(o) {
  let g = o.geometry.clone();
  if (g.index) g = g.toNonIndexed();
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
  g.morphAttributes = {};
  g.applyMatrix4(o.matrixWorld);
  if (!g.attributes.normal) g.computeVertexNormals();
  g.clearGroups();
  return g;
}

export async function makeFromGLB(file, { budgetTris = 500 } = {}) {
  const buf = await file.arrayBuffer();
  const gltf = await new Promise((res, rej) => getGLTFLoader().parse(buf, '', res, e => rej(new Error('GLB를 읽지 못했어요: ' + (e?.message ?? e)))));
  gltf.scene.updateMatrixWorld(true);
  const parts = [];
  gltf.scene.traverse(o => { if (o.isMesh && o.geometry?.attributes?.position) parts.push(o); });
  if (!parts.length) throw new Error('GLB 안에 메시가 없어요.');

  // 모든 메시를 하나로 병합 (재질은 그룹으로 유지 → 여러 부품으로 된 모델도 통째로 보임)
  const geos = parts.map(flattenMesh);
  const allUV = geos.every(g => g.attributes.uv);
  if (!allUV) for (const g of geos) g.deleteAttribute('uv');
  let materials = parts.map(p => Array.isArray(p.material) ? p.material[0] : p.material);
  let geometry = geos.length === 1 ? geos[0] : mergeGeometries(geos, true);
  if (!geometry) throw new Error('메시를 병합하지 못했어요.');
  if (geos.length === 1) { geometry.addGroup(0, geometry.attributes.position.count, 0); }
  const originalTris = triCountOf(geometry);
  if (originalTris > GLB_MAX_TRIS) throw new Error(`모델이 너무 커요 (${originalTris.toLocaleString()} tri). ${GLB_MAX_TRIS.toLocaleString()} tri 이하로 줄여서 올려주세요.`);

  let material = materials.length === 1 ? materials[0] : materials;
  let decimated = false;
  if (originalTris > budgetTris) {
    // 데시메이션 (FR-35). 목표 정점 수는 반드시 *병합 후* 정점 수 기준으로 잡는다.
    // (예전 코드는 병합 전 non-indexed 정점 수를 써서 플랫 셰이딩 GLB의 정점을 전부 지워 0 tri 가 나왔음)
    // 위치만 남기고 병합해야 정점 수가 실제 형상 정점 수가 된다. (법선/UV 를 남기면 면마다 정점이 갈라져 3배로 늘고 O(n²) 데시메이션이 수십 배 느려짐)
    const posOnly = new THREE.BufferGeometry(); posOnly.setAttribute('position', geometry.attributes.position);
    const merged = mergeVertices(posOnly);
    const vCount = merged.attributes.position.count;
    const keep = Math.max(12, Math.ceil(vCount * budgetTris / originalTris));
    const remove = Math.max(0, vCount - keep);
    try {
      const g = new SimplifyModifier().modify(merged, remove);
      g.clearGroups(); g.deleteAttribute('normal'); g.computeVertexNormals();
      if (triCountOf(g) >= 4) {
        geometry = g; decimated = true;
        // SimplifyModifier 는 UV 를 보존하지 않으므로 단색 재질로 (여러 재질이면 첫 재질 색)
        const base = materials[0];
        material = new THREE.MeshStandardMaterial({ color: base?.color?.clone?.() ?? new THREE.Color(0xdddddd), roughness: 0.6, metalness: base?.metalness ?? 0 });
      } else console.warn('decimation produced a degenerate mesh; keeping original');
    } catch (e) { console.warn('decimation failed', e); }
  }
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const boundingRadius = normalize(geometry);
  const triCount = triCountOf(geometry);
  if (!(triCount > 0) || !isFinite(boundingRadius)) throw new Error('GLB 처리 결과가 비어 있어요.');
  const firstMap = (Array.isArray(material) ? material : [material]).find(m => m?.map)?.map;
  return { id: nextId++, tier: 'glb', name: file.name, geometry, material, boundingRadius, triCount,
    textureSize: firstMap ? `${firstMap.image?.width ?? '?'}×${firstMap.image?.height ?? '?'}` : '없음',
    decimated, originalTris, partCount: parts.length };
}

// ---------- 기본 핫초코 방울 (프로시저럴) ----------
// 위가 뾰족한 물방울. 시뮬이 rz 를 진행 방향으로 돌리므로 꼬리(위)가 항상 뒤를 향한다.
export function makeDefaultDrop() {
  const c = document.createElement('canvas'); c.width = 160; c.height = 256;
  const g = c.getContext('2d');
  g.translate(80, 0);
  const body = () => { g.beginPath(); g.moveTo(0, 14); g.bezierCurveTo(26, 96, 62, 118, 62, 176); g.arc(0, 176, 62, 0, Math.PI, false); g.bezierCurveTo(-62, 118, -26, 96, 0, 14); g.closePath(); };
  // 본체: 진한 코코아 → 밝은 우유 코코아 방사 그라데이션
  const grad = g.createRadialGradient(-22, 150, 6, 0, 168, 84);
  grad.addColorStop(0, '#a8704b'); grad.addColorStop(0.55, '#6b3e24'); grad.addColorStop(1, '#3a1d0f');
  body(); g.fillStyle = grad; g.fill();
  // 림 라이트
  g.save(); body(); g.clip(); g.strokeStyle = 'rgba(255,214,170,.55)'; g.lineWidth = 7; g.beginPath(); g.arc(4, 174, 58, 0.15, 1.35); g.stroke(); g.restore();
  // 하이라이트 두 점
  g.fillStyle = 'rgba(255,240,225,.92)'; g.beginPath(); g.ellipse(-24, 138, 9, 16, -0.5, 0, 6.283); g.fill();
  g.fillStyle = 'rgba(255,240,225,.55)'; g.beginPath(); g.ellipse(-30, 176, 5, 7, 0, 0, 6.283); g.fill();
  const asset = makeBillboard(c, '기본 핫초코 방울');
  asset.material.alphaTest = 0.2;
  return { canvas: c, asset };
}

// 이전 이름 유지 (외부 호출 호환)
export const makeDefaultSnowflake = makeDefaultDrop;

export function disposeAsset(a) {
  if (!a) return;
  a.geometry?.dispose?.();
  const mats = Array.isArray(a.material) ? a.material : [a.material];
  for (const m of mats) { m?.map?.dispose?.(); m?.dispose?.(); }
}

// ---------- 기본 마시멜로 텍스처 (assets/marshmallow.png 가 없을 때 대체) ----------
// 투명 배경 위에 둥근 원기둥 마시멜로 몇 개를 쌓은 1024x1024 캔버스. 아래쪽은 꽉 채워 바닥 틈이 보이지 않게 한다.
export function makeDefaultPileTexture() {
  const S = 1024, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const mallow = (x, y, w, h, rot, tint) => {
    g.save(); g.translate(x, y); g.rotate(rot);
    const r = Math.min(w, h) * 0.32;
    const grad = g.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
    grad.addColorStop(0, '#fffdf8'); grad.addColorStop(0.55, tint); grad.addColorStop(1, '#e6d9c8');
    g.shadowColor = 'rgba(60,30,10,.28)'; g.shadowBlur = 24; g.shadowOffsetY = 10;
    g.fillStyle = grad; g.beginPath(); g.roundRect(-w / 2, -h / 2, w, h, r); g.fill();
    g.shadowColor = 'transparent';
    // 앞면(끝단) 타원 — 살짝 어두운 크림색
    g.fillStyle = 'rgba(240,228,212,.85)'; g.beginPath(); g.ellipse(-w * 0.22, 0, w * 0.2, h * 0.42, 0, 0, 6.283); g.fill();
    // 가루 설탕 질감
    g.globalAlpha = 0.22; g.fillStyle = '#ffffff';
    for (let i = 0; i < 90; i++) { const px = (Math.random() - 0.5) * w * 0.9, py = (Math.random() - 0.5) * h * 0.85; g.fillRect(px, py, 2 + Math.random() * 3, 2 + Math.random() * 3); }
    g.globalAlpha = 1; g.restore();
  };
  // 아래줄 (꽉 채움) → 중간줄 → 윗줄 (봉긋한 실루엣)
  const rows = [
    { y: S * 0.86, n: 4, w: 300, h: 240, jitter: 10 },
    { y: S * 0.62, n: 3, w: 290, h: 230, jitter: 26 },
    { y: S * 0.40, n: 2, w: 280, h: 220, jitter: 30 }
  ];
  const tints = ['#f7efe4', '#f3e9dc', '#faf3ea'];
  rows.forEach((row, ri) => {
    for (let i = 0; i < row.n; i++) {
      const x = ((i + 0.5) / row.n) * S + (Math.random() - 0.5) * row.jitter * 2;
      const y = row.y + (Math.random() - 0.5) * row.jitter;
      mallow(x, y, row.w, row.h, (Math.random() - 0.5) * (0.15 + ri * 0.2), tints[(i + ri) % 3]);
    }
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
