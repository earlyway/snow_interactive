import * as THREE from 'three';
import { Simulation } from './sim.js';
import { Renderer } from './render.js';
import { InputLayer } from './tracking.js';
import { makeBillboard, makeExtruded, makeFromGLB, makeDefaultDrop, makeDefaultPileTexture, loadImage, disposeAsset, budgetCheck } from './assets.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---------- 좌표계: 화면 높이 = 10 월드 단위, 바닥 y=-5 ----------
const view = {
  height: 10, width: 10, top: 5, ground: -5, aspect: 1,
  setViewport(w, h) { this.aspect = w / h; this.width = this.height * this.aspect; },
  screenToWorld(nx, ny) { return { x: (nx - 0.5) * this.width, y: (0.5 - ny) * this.height }; },
  // object-fit: cover 로 잘린 비디오의 정규화 좌표 → 월드 (FR-06)
  videoToWorld(nx, ny, vw, vh) {
    const va = vw / vh || this.aspect, wa = this.aspect;
    let sx = 1, sy = 1;
    if (wa > va) sy = va / wa; else sx = wa / va;
    return { x: (nx - 0.5) / sx * this.width, y: (0.5 - ny) / sy * this.height };
  }
};

// ---------- 파라미터 (FR-28) ----------
const P = {
  // 마시멜로 레이어
  level: 3.0, maxLevel: 9, jellyStiff: 1.0, jellyDamp: 1.0, jellyPush: 1.0,
  // 손 · 멜로우봇
  handRadius: 2.2, trackFps: 30, floatGravity: 6.0, pushStrength: 1.0, spinStrength: 1.0, floatRighting: 6.0,
  // 비 (선택, 기본 꺼짐)
  maxParticles: 4000, spawnRate: 0, gravity: 4.5, terminal: 7.5, wind: 0, noise: 0.4, sizeMin: 0.16, sizeMax: 0.34, tumble: 2.4, fill: 0, splash: 1.0,
  thickness: 0.16, triBudget: 500
};
const L_SLIDERS = [['level', '마시멜로 높이', 0, 9, 0.05], ['jellyStiff', '탄성 (되돌아오는 힘)', 0.2, 3, 0.05], ['jellyDamp', '감쇠 (출렁임이 멎는 속도)', 0.2, 3, 0.05], ['jellyPush', '손 출렁임 세기', 0, 3, 0.05]];
const I_SLIDERS = [['handRadius', '손 반경', 0.5, 5, 0.05], ['pushStrength', '멜로우봇 미는 힘', 0.2, 3, 0.05], ['spinStrength', '멜로우봇 회전 민감도', 0, 3, 0.05], ['floatRighting', '멜로우봇 바로 서는 힘', 0, 20, 0.5], ['floatGravity', '멜로우봇 무게 (부력 반응 속도)', 1, 15, 0.5], ['trackFps', '트래킹 fps', 10, 60, 5]];
const P_SLIDERS = [
  ['spawnRate', '초당 방울 수 (0 = 비 없음)', 0, 1200, 10], ['maxParticles', '파티클 양', 200, 12000, 100], ['gravity', '중력', 0.3, 12, 0.1],
  ['wind', '바람', -3, 3, 0.05], ['noise', '흔들림', 0, 2, 0.05], ['sizeMin', '최소 크기', 0.05, 0.6, 0.01], ['sizeMax', '최대 크기', 0.1, 1.2, 0.01],
  ['tumble', '회전 텀블링 (3D 에셋)', 0, 6, 0.1], ['splash', '스플래시', 0, 2, 0.05], ['fill', '방울이 쌓여 높이는 양', 0, 6, 0.1]
];
const A_SLIDERS = [['thickness', '압출 두께 (티어 2)', 0.03, 0.5, 0.01], ['triBudget', '인스턴스당 폴리 예산', 50, 3000, 50]];

function buildSliders(host, specs, onChange) {
  for (const [key, label, min, max, step] of specs) {
    const row = document.createElement('div'); row.className = 'row';
    const id = 'sl_' + key;
    row.innerHTML = `<label for="${id}">${label}</label><output id="${id}_o">${P[key]}</output><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${P[key]}">`;
    host.appendChild(row);
    const inp = row.querySelector('input'), out = row.querySelector('output');
    inp.addEventListener('input', () => { P[key] = parseFloat(inp.value); out.textContent = inp.value; onChange?.(key); });
  }
}
function syncSlider(key) { const i = document.getElementById('sl_' + key); if (i) { i.value = P[key]; document.getElementById('sl_' + key + '_o').textContent = typeof P[key] === 'number' ? +P[key].toFixed(2) : P[key]; } }

// ---------- 레이어 조립 ----------
const $ = s => document.querySelector(s);
const sim = new Simulation(view, P);
const gfx = new Renderer($('#gl'), view);
const input = new InputLayer({ video: $('#video'), view, params: P, onStatus: setStatus });
input.attachPointer($('#stage'));
const overlay = $('#overlay'), octx = overlay.getContext('2d');

const { asset: defaultAsset } = makeDefaultDrop();
sim.setAsset(defaultAsset, 'reset');

// 높이 설정: 시뮬 + 슬라이더 동기화
function setLevel(h) { sim.setLevel(h); P.level = sim.liquid.level; syncSlider('level'); }
setLevel(P.level);

// ---------- 상태 pill (FR-02) ----------
function setStatus(text, cls) { $('#statusText').textContent = text; $('#status').className = cls || ''; }
$('#camBtn').addEventListener('click', async () => { $('#camBtn').hidden = true; await input.requestCamera(); $('#video').classList.toggle('hidden', !($('#showVideo').checked && input.state === 'granted')); });
if (navigator.mediaDevices?.getUserMedia) { setStatus('카메라를 허용하면 손으로 마시멜로를 출렁이게 할 수 있어요', ''); $('#camBtn').hidden = false; }
else setStatus('이 브라우저는 카메라를 지원하지 않아 마우스 모드로 동작합니다', 'warn');
if (!isSecureContext) toast('카메라는 https 또는 localhost 에서만 켜집니다. 로컬 서버로 열어주세요.');

// ---------- 마시멜로 이미지: assets/marshmallow.png → 없으면 기본 그림 ----------
const PILE_SRC = 'assets/marshmallow.png';
async function imageToTexture(src, { maxDim = 2048 } = {}) {
  const img = new Image(); img.decoding = 'async';
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('이미지를 읽을 수 없어요')); img.src = src; });
  const iw = img.naturalWidth, ih = img.naturalHeight, s = Math.min(1, maxDim / Math.max(iw, ih));
  let tex;
  if (s < 1) { // 큰 이미지는 캔버스로 축소 (GPU 텍스처 크기 · 메모리 절약)
    const c = document.createElement('canvas'); c.width = Math.round(iw * s); c.height = Math.round(ih * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    tex = new THREE.CanvasTexture(c);
  } else tex = new THREE.Texture(img);
  return { tex, fill: opaqueFill(img) };
}
// 텍스처에서 불투명 픽셀이 차지하는 평균 높이 비율 (열마다 맨 위 불투명 픽셀을 찾아 평균). 알파가 없는 이미지는 1.
function opaqueFill(source) {
  const N = 128, c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d'); g.drawImage(source, 0, 0, N, N);
  const d = g.getImageData(0, 0, N, N).data;
  let sum = 0, cols = 0;
  for (let x = 0; x < N; x++) {
    let top = -1;
    for (let y = 0; y < N; y++) if (d[(y * N + x) * 4 + 3] > 128) { top = y; break; }
    if (top >= 0) { sum += 1 - top / N; cols++; }
  }
  return cols ? sum / cols : 1;
}
let pileImageFill = 1;
function applyPile({ tex, fill }, label) { gfx.setPileTexture(tex); pileImageFill = fill; applyPileMode(); $('#pileName').textContent = label; console.info('[pile]', label, 'fill', fill.toFixed(2)); }
// 2.5D 인스턴스(기본) ↔ 2D 이미지 평면. 2D 는 이미지 위쪽 투명 여백만큼 메시를 늘린다
function applyPileMode() { const mode = document.querySelector('input[name=pileMode]:checked')?.value ?? '3d'; gfx.setPileMode(mode); sim.setPileFill(mode === '2d' ? pileImageFill : 1); }
document.querySelectorAll('input[name=pileMode]').forEach(r => r.addEventListener('change', applyPileMode));
applyPileMode();
imageToTexture(PILE_SRC).then(r => applyPile(r, PILE_SRC))
  .catch(() => { const tex = makeDefaultPileTexture(); applyPile({ tex, fill: opaqueFill(tex.image) }, '기본 그림 (assets/marshmallow.png 없음)'); });
// 패널에서 이미지 교체
$('#pilePick').addEventListener('click', () => $('#pileFile').click());
$('#pileFile').addEventListener('change', async () => {
  const f = $('#pileFile').files[0]; $('#pileFile').value = ''; if (!f) return;
  const url = URL.createObjectURL(f);
  try { applyPile(await imageToTexture(url), f.name); toast('마시멜로 이미지를 바꿨어요'); }
  catch (e) { toast(e.message); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
});

// ---------- 멜로우봇 GLB: 마시멜로 위에 튜브처럼 떠오르고, 손으로 밀 수 있다 ----------
const MASCOT = { src: 'assets/glb_mallowbot_50k_huniyuan_hyperoptimizing.glb', height: 4.5 }; // 화면 높이(10)의 45%
async function loadMascot() {
  toast('멜로우봇 3D 모델을 불러오는 중… (33 MB)');
  const gltf = await new GLTFLoader().loadAsync(MASCOT.src);
  const info = gfx.setFloater(gltf.scene, { height: MASCOT.height });
  sim.setFloater(info.width / 2, info.height / 2, info.depth / 2);
  console.info('[mascot] floater', info);
  return info;
}
const mascotReady = loadMascot().catch(e => { console.warn(e); toast('멜로우봇 모델을 못 읽었어요: ' + e.message); return null; });
$('#showMascot').addEventListener('change', e => { gfx.setFloaterVisible(e.target.checked); if (!e.target.checked) sim.floater = null; else mascotReady.then(info => info && !sim.floater && sim.setFloater(info.width / 2, info.height / 2, info.depth / 2)); });

// ---------- autostart 모드 (?autostart=1): 카메라를 바로 요청. ?level= 으로 시작 높이 ----------
const Q = new URLSearchParams(location.search);
if (Q.has('level') || Q.has('pile')) setLevel(parseFloat(Q.get('level') ?? Q.get('pile')));
if (Q.get('autostart') === '1') {
  if (navigator.mediaDevices?.getUserMedia) {
    $('#camBtn').hidden = true;
    input.requestCamera().then(() => {
      $('#video').classList.toggle('hidden', !($('#showVideo').checked && input.state === 'granted'));
      if (input.state === 'granted') toast('손을 카메라 앞에 내밀어 마시멜로를 눌러보세요');
      else { $('#camBtn').hidden = false; toast('카메라 권한이 없어 마우스로 조작할 수 있어요'); }
    });
  }
}

// ---------- 패널 ----------
$('#toggle').addEventListener('click', () => { const o = $('#panel').classList.toggle('open'); $('#toggle').setAttribute('aria-expanded', o); });
buildSliders($('#lSliders'), L_SLIDERS, key => { if (key === 'level') sim.setLevel(P.level); });
buildSliders($('#iSliders'), I_SLIDERS);
buildSliders($('#pSliders'), P_SLIDERS, key => { if (key === 'sizeMin' && P.sizeMin > P.sizeMax) { P.sizeMax = P.sizeMin; syncSlider('sizeMax'); } if (key === 'maxParticles') checkBudget(sim.current); });
buildSliders($('#aSliders'), A_SLIDERS, () => rebuildPending());
$('#showVideo').addEventListener('change', e => $('#video').classList.toggle('hidden', !(e.target.checked && input.state === 'granted')));
$('#debugToggle').addEventListener('change', e => { $('#debugPane').hidden = !e.target.checked; if (!e.target.checked) octx.clearRect(0, 0, overlay.width, overlay.height); });
$('#reset').addEventListener('click', () => { sim.resetLiquid(); P.level = 0; syncSlider('level'); toast('마시멜로를 치웠어요'); });
$('#fillBtn').addEventListener('click', () => { setLevel(3.0); toast('마시멜로를 쌓았어요'); });
$('#wire').addEventListener('click', () => { gfx.setWireframe(!gfx.wire); $('#wire').textContent = gfx.wire ? '솔리드' : '와이어프레임'; });
$('#defaultAsset').addEventListener('click', () => { applyAsset(makeDefaultDrop().asset); pendingSource = null; pendingFile = null; setPending(null, '기본 방울로 돌아왔어요.'); });

// ---------- 비 에셋 파이프라인 UI (FR-30~37) ----------
let pendingSource = null, pendingAsset = null, pendingFile = null;
const fileInput = $('#file');
// 기본 경로: 클릭 → Finder 선택창. (input 값은 매번 비워서 같은 파일을 다시 골라도 change 가 뜨게 한다)
$('#pick').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { const f = fileInput.files[0]; fileInput.value = ''; if (f) ingest(f); });
// 보조 경로: 페이지 어디에나 드롭. 문서 전체에서 기본 동작을 막아야 드롭 존을 벗어나 떨어뜨려도 브라우저가 파일을 열어버리지 않는다.
let dragDepth = 0;
document.addEventListener('dragenter', e => { e.preventDefault(); if (++dragDepth === 1) document.body.classList.add('dragging'); });
document.addEventListener('dragover', e => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
document.addEventListener('dragleave', e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
document.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const f = e.dataTransfer?.files?.[0] ?? [...(e.dataTransfer?.items ?? [])].find(i => i.kind === 'file')?.getAsFile();
  if (!f) { toast('파일이 아닌 항목이에요. Finder 에서 파일을 끌어다 놓거나 "파일 선택" 을 눌러주세요'); return; }
  if (!$('#panel').classList.contains('open')) $('#toggle').click();
  ingest(f);
});
document.querySelectorAll('input[name=tier]').forEach(r => r.addEventListener('change', rebuildPending));

// 확장자 대신 내용으로 판별: GLB 는 앞 4바이트가 'glTF', .gltf(JSON) 는 외부 .bin 이 필요해 단일 GLB 로 안내
async function sniff(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const tag = String.fromCharCode(...head);
  if (tag === 'glTF') return 'glb';
  if (/\.gltf$/i.test(file.name) || (tag[0] === '{' && /gltf/i.test(file.name))) return 'gltf';
  if (/\.glb$/i.test(file.name)) return 'glb-bad';
  return 'image';
}

let ingestSeq = 0;
async function ingest(file) {
  const seq = ++ingestSeq;
  msg('');
  toast(`파일 받음: ${file.name} (${(file.size / 1024).toFixed(0)} KB)`);
  try {
    const kind = await sniff(file);
    if (seq !== ingestSeq) return;
    if (kind === 'gltf') throw new Error('.gltf 는 외부 .bin/텍스처가 필요해요. 내보낼 때 단일 파일 GLB 로 저장해주세요.');
    if (kind === 'glb-bad') throw new Error('확장자는 .glb 인데 GLB 헤더가 없어요. 파일이 손상됐거나 zip 등 다른 형식입니다.');
    if (kind === 'glb') {
      pendingSource = null; pendingFile = file;
      msg('GLB 읽는 중… 큰 모델은 데시메이션에 몇 초 걸릴 수 있어요');
      await new Promise(r => setTimeout(r, 30)); // 메시지가 그려질 틈
      const t0 = performance.now();
      const a = await makeFromGLB(file, { budgetTris: P.triBudget });
      if (seq !== ingestSeq) { disposeAsset(a); return; } // 그 사이 다른 파일이 들어옴
      msg('');
      setPending(a, `GLB ${a.partCount > 1 ? a.partCount + '개 메시 병합 · ' : ''}${Math.round(performance.now() - t0)} ms`);
      return;
    }
    pendingFile = null;
    const img = await loadImage(file);
    if (seq !== ingestSeq) return;
    pendingSource = img;
    pendingSource.assetName = file.name;
    await rebuildPending();
  } catch (e) { if (seq === ingestSeq) { msg(e.message); toast(e.message); } console.error(e); }
}

async function rebuildPending() {
  if (pendingFile) { try { setPending(await makeFromGLB(pendingFile, { budgetTris: P.triBudget })); } catch (e) { msg(e.message); } return; }
  if (!pendingSource) return;
  const tier = document.querySelector('input[name=tier]:checked').value;
  const t0 = performance.now();
  try {
    let a;
    if (tier === '2') {
      try { a = makeExtruded(pendingSource, { thickness: P.thickness, budgetTris: P.triBudget, name: pendingSource.assetName }); }
      catch (e) { a = makeBillboard(pendingSource, pendingSource.assetName); msg(`압출 실패 → 티어 1로 대체: ${e.message}`); document.querySelector('input[name=tier][value="1"]').checked = true; }
    } else a = makeBillboard(pendingSource, pendingSource.assetName);
    setPending(a, `생성 ${Math.round(performance.now() - t0)} ms`);
  } catch (e) { msg(e.message); }
}

function msg(t) { $('#msg').textContent = t; }
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 2600); }

// 미리보기 뷰어 (FR-36)
const pv = { r: new THREE.WebGLRenderer({ canvas: $('#pv'), antialias: true, alpha: true }), scene: new THREE.Scene(), cam: new THREE.PerspectiveCamera(35, 1, 0.1, 20), mesh: null };
pv.r.setPixelRatio(2); pv.r.setSize(132, 132, false); pv.r.outputColorSpace = THREE.SRGBColorSpace; pv.cam.position.set(0, 0.4, 2.4); pv.cam.lookAt(0, 0, 0);
pv.scene.add(new THREE.AmbientLight(0xbfd4ff, 1.2)); const pl = new THREE.DirectionalLight(0xffffff, 2); pl.position.set(2, 3, 4); pv.scene.add(pl);

function setPending(asset, note = '') {
  if (pendingAsset && pendingAsset !== sim.current) disposeAsset(pendingAsset);
  pendingAsset = asset;
  if (pv.mesh) pv.scene.remove(pv.mesh);
  pv.mesh = null;
  $('#apply').disabled = !asset;
  if (!asset) { $('#pvstats').textContent = note || '에셋을 올리면 여기서 미리 봅니다.'; pv.r.clear(); return; }
  pv.mesh = new THREE.Mesh(asset.geometry, asset.material); pv.scene.add(pv.mesh);
  const b = budgetCheck(asset, P.maxParticles);
  const tierName = { 1: '티어 1 · 빌보드', 2: '티어 2 · 압출', glb: 'GLB' }[asset.tier];
  $('#pvstats').innerHTML = `<b>${asset.name ?? ''}</b><br>${tierName}<br>폴리 <b>${asset.triCount.toLocaleString()}</b> tri${asset.pointCount ? ` · ${asset.pointCount}점` : ''}${asset.decimated ? ` <span class="bad">(${asset.originalTris.toLocaleString()} → 데시메이션)</span>` : ''}<br>텍스처 ${asset.textureSize}<br>총 삼각형 <b class="${b.ok ? '' : 'bad'}">${(b.total / 1e6).toFixed(2)}M</b> / 3.0M<br>${b.ok ? '예상 FPS 영향 낮음' : `<span class="bad">예산 초과 → 파티클 ${b.allowed.toLocaleString()}개로 제한됨</span>`}${note ? `<br>${note}` : ''}`;
}

$('#apply').addEventListener('click', () => {
  if (!pendingAsset) return;
  applyAsset(pendingAsset);
  pendingAsset = null; // 소유권이 sim 으로 넘어감
  if (P.spawnRate <= 0) { P.spawnRate = 220; syncSlider('spawnRate'); }
  toast('새 에셋이 비처럼 내리기 시작했어요');
});

function applyAsset(asset) {
  checkBudget(asset);
  const dropped = sim.setAsset(asset, $('#policy').value);
  for (const id of dropped) { gfx.dropMesh(id); }
  gfx.ensureMesh(asset);
  if (gfx.wire) gfx.setWireframe(true);
}
function checkBudget(asset) { // NFR-07
  if (!asset) return;
  const b = budgetCheck(asset, P.maxParticles);
  if (!b.ok) { P.maxParticles = b.allowed; syncSlider('maxParticles'); toast(`폴리 예산 초과 — 파티클을 ${b.allowed.toLocaleString()}개로 제한했어요`); }
}

// ---------- 메인 루프: 고정 스텝 시뮬 + 가변 렌더 ----------
const FIXED = 1 / 120; let acc = 0, last = performance.now();
let fpsAcc = 0, fpsN = 0, fps = 60, lowSince = null, frameT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min(0.1, (now - last) / 1000); last = now;
  const interactors = input.update(now);
  acc += dt; let steps = 0;
  while (acc >= FIXED && steps < 6) { sim.step(FIXED, interactors); acc -= FIXED; steps++; }
  if (steps === 6) acc = 0;
  const draws = gfx.draw(sim);
  if (pv.mesh) { pv.mesh.rotation.y += 0.012; pv.mesh.rotation.x = 0.25; pv.r.render(pv.scene, pv.cam); }

  // FPS & 자동 스케일링 (NFR-06)
  fpsAcc += now - frameT; frameT = now; fpsN++;
  if (fpsAcc >= 500) {
    fps = 1000 / (fpsAcc / fpsN); fpsAcc = 0; fpsN = 0;
    if (Math.abs(P.level - sim.liquid.level) > 1e-3) { P.level = sim.liquid.level; syncSlider('level'); } // 비가 쌓여 높이가 바뀐 경우
    if (fps < 50) {
      if (lowSince == null) lowSince = now;
      else if (now - lowSince > 2000) {
        lowSince = now;
        if (sim.active.size > 0 && P.maxParticles > 600) { P.maxParticles = Math.floor(P.maxParticles * 0.8); syncSlider('maxParticles'); toast(`FPS ${fps.toFixed(0)} — 파티클을 ${P.maxParticles}개로 줄였어요`); }
        else if (sim.current?.tier === 2 && pendingSource) { applyAsset(makeBillboard(pendingSource, pendingSource.assetName)); toast('FPS 부족 — 티어 2 → 티어 1 로 자동 다운그레이드'); }
      }
    } else lowSince = null;
    if (!$('#debugPane').hidden) {
      const s = input.stats, t = sim.stats;
      $('#debugPane').innerHTML = `FPS <b>${fps.toFixed(0)}</b> · 시뮬 스텝 ${steps} · 드로우콜 <b>${draws}</b><br>마시멜로 높이 <b>${t.level.toFixed(2)}</b> · 최대 출렁임 ${t.wobble.toFixed(2)}<br>인스턴스 <b>${sim.active.size}</b> (낙하 ${t.falling} · 파편 ${t.debris}) · 인터랙터 ${interactors.length}<br>손 ${s.hands}개 · 신뢰도 ${s.handScore.toFixed(2)} · 멜로우봇 잠김 ${((sim.floater?.submerged ?? 0) * 100).toFixed(0)}% · 눌림 ${(sim.floater?.pressed ?? 0).toFixed(2)}<br>트래킹 ${s.trackMs.toFixed(1)} ms/프레임 · 카메라 ${input.state}`;
    }
  }
  if (!$('#debugPane').hidden) drawOverlay(interactors);
}
requestAnimationFrame(frame);

// 디버그 오버레이 (FR-27): 랜드마크 · 인터랙터 반경 · 젤리 격자
function drawOverlay(interactors) {
  const w = overlay.width = innerWidth, h = overlay.height = innerHeight;
  octx.clearRect(0, 0, w, h);
  const toScreen = (x, y) => [(x / view.width + 0.5) * w, (0.5 - y / view.height) * h];
  octx.lineWidth = 1;
  for (const I of interactors) {
    const [sx, sy] = toScreen(I.x, I.y);
    octx.strokeStyle = 'rgba(255,170,110,.8)';
    octx.beginPath(); octx.arc(sx, sy, I.radius / view.height * h, 0, 6.283); octx.stroke();
    octx.strokeStyle = 'rgba(255,255,255,.5)'; octx.beginPath(); octx.arc(sx, sy, I.radius * 0.8 / view.height * h, 0, 6.283); octx.stroke(); // 젤리 접촉 반경
  }
  // 윗면 (평균 높이 점선 + 파문 포함 기준면 실선) + 젤리 격자
  { const L = sim.liquid, W = view.width, J = sim.jelly, p = [0, 0];
    octx.strokeStyle = 'rgba(241,220,195,.9)'; octx.setLineDash([]); octx.beginPath();
    for (let b = 0; b < L.wave.length; b++) { const [sx, sy] = toScreen(-W / 2 + (b + 0.5) / L.wave.length * W, sim.surfaceAt(b)); b ? octx.lineTo(sx, sy) : octx.moveTo(sx, sy); }
    octx.stroke();
    octx.setLineDash([3, 3]); octx.strokeStyle = 'rgba(241,220,195,.45)'; octx.beginPath();
    const [, ly] = toScreen(0, view.ground + L.level); octx.moveTo(0, ly); octx.lineTo(w, ly); octx.stroke(); octx.setLineDash([]);
    if (L.level > 0.02) {
      octx.strokeStyle = 'rgba(255,255,255,.22)';
      for (let r = 1; r < J.rows; r++) { octx.beginPath(); for (let c = 0; c < J.cols; c += 2) { sim.jellyPos(c, r, p); const [sx, sy] = toScreen(p[0], p[1]); c ? octx.lineTo(sx, sy) : octx.moveTo(sx, sy); } octx.stroke(); }
    }
  }
  octx.fillStyle = 'rgba(255,200,150,.9)';
  for (const hd of input.lastHands) for (const lm of hd.landmarks) { const p = input.lmToWorld(lm); const [sx, sy] = toScreen(p.x, p.y); octx.fillRect(sx - 2, sy - 2, 4, 4); }
  // 멜로우봇 충돌 타원
  if (sim.floater) { const F = sim.floater, [cx, cy] = toScreen(F.x, F.y); octx.strokeStyle = 'rgba(255,230,200,.8)'; octx.beginPath(); octx.ellipse(cx, cy, F.halfW * 0.92 / view.height * h, F.halfH * 0.95 / view.height * h, 0, 0, 6.283); octx.stroke(); }
}

addEventListener('resize', () => gfx.resize());
window.mallow = window.cocoa = window.snow = { sim, gfx, P, input, view }; // 콘솔/자동 테스트용
