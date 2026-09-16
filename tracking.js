// 입력 레이어 — 카메라/랜드마크/마우스 → Interactor { source, kind, x, y, vx, vy, radius, strength }
// 시뮬은 Interactor 배열만 받는다. 손·눈·마우스 구분은 여기서 끝난다.
//   손/마우스 → kind 'suck' (핫초코 흡입 + 멜로우봇 밀기)
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export class InputLayer {
  constructor({ video, view, params, onStatus }) {
    this.video = video; this.view = view; this.P = params; this.onStatus = onStatus;
    this.state = 'idle'; // idle | requesting | granted | denied
    this.hand = null;
    this.interactors = [];
    this.persistent = []; // 마우스 등 유지형
    this.prevPalm = new Map();
    this.lastTrack = 0; this.lastHands = [];
    this.stats = { hands: 0, handScore: 0, trackMs: 0 };
  }

  // ----- 마우스/터치 fallback (FR-26) -----
  attachPointer(el) {
    let last = null;
    const move = (e) => {
      const r = el.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width, ny = (e.clientY - r.top) / r.height;
      const { x, y } = this.view.screenToWorld(nx, ny);
      const t = performance.now();
      let vx = 0, vy = 0;
      if (last) { const dt = Math.max((t - last.t) / 1000, 1e-3); vx = (x - last.x) / dt; vy = (y - last.y) / dt; }
      last = { x, y, t };
      this.mouse = { source: 'mouse', kind: 'suck', x, y, vx, vy, radius: this.P.suckRadius, strength: 1, t };
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerdown', move);
    el.addEventListener('pointerleave', () => { this.mouse = null; last = null; });
  }

  // ----- 카메라 (FR-01, FR-02) -----
  async requestCamera() {
    this.state = 'requesting'; this.onStatus?.('카메라 권한을 확인하는 중', 'warn');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false });
      this.video.srcObject = stream; await this.video.play();
      this.state = 'granted';
      this.onStatus?.('인식 모델을 불러오는 중', 'warn');
      await this.loadModels();
      this.onStatus?.('손 인식 중', 'live');
    } catch (e) {
      console.warn(e);
      this.state = 'denied';
      this.onStatus?.('카메라 없이 마우스로 빨아들이기', 'warn');
    }
  }

  async loadModels() {
    const fs = await FilesetResolver.forVisionTasks(WASM);
    this.hand = await HandLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' }, runningMode: 'VIDEO', numHands: 2 });
  }

  // 랜드마크(정규화, 미러링 전) → 월드 좌표 (FR-06)
  lmToWorld(lm) {
    return this.view.videoToWorld(1 - lm.x, lm.y, this.video.videoWidth, this.video.videoHeight);
  }

  // ----- 매 프레임 호출. 트래킹은 P.trackFps 로 다운샘플 (FR-03) -----
  update(now) {
    const out = [];
    if (this.mouse) { // 포인터가 화면 안에 있는 동안 계속 빨아들인다 (가만히 있어도 OK)
      this.mouse.radius = this.P.suckRadius; this.mouse.strength = 1; out.push(this.mouse);
    }
    if (this.state === 'granted' && this.hand && this.video.readyState >= 2 && now - this.lastTrack >= 1000 / this.P.trackFps) {
      const t0 = performance.now();
      this.track(now);
      this.stats.trackMs = performance.now() - t0;
      this.lastTrack = now;
    }
    // 손 인터랙터 (마지막 트래킹 결과 유지)
    for (const h of this.lastHands) out.push(...h.interactors);
    this.interactors = out;
    return out;
  }

  track(now) {
    const dtSec = Math.max((now - (this.lastTrackTime ?? now - 33)) / 1000, 1e-3);
    this.lastTrackTime = now;
    // --- 손 (FR-05~08) ---
    const hr = this.hand.detectForVideo(this.video, now);
    const hands = [];
    hr.landmarks?.forEach((lms, i) => {
      const score = hr.handednesses?.[i]?.[0]?.score ?? 0.5;
      // 저조도 신뢰도 게이팅 (NFR-05): score < 0.6 이면 힘을 줄이고, 0.4 미만은 무시
      if (score < 0.4) return;
      const gate = Math.min(1, (score - 0.4) / 0.4);
      const label = hr.handednesses?.[i]?.[0]?.categoryName ?? String(i);
      const palmIdx = [0, 5, 9, 13, 17];
      let px = 0, py = 0;
      for (const k of palmIdx) { const w = this.lmToWorld(lms[k]); px += w.x; py += w.y; }
      px /= palmIdx.length; py /= palmIdx.length;
      const prev = this.prevPalm.get(label);
      const vx = prev ? (px - prev.x) / dtSec : 0, vy = prev ? (py - prev.y) / dtSec : 0;
      this.prevPalm.set(label, { x: px, y: py });
      // 펼침 정도 = 손가락 끝과 손목 거리 → 펼친 손은 넓게, 주먹은 좁고 세게 빨아들인다
      const wrist = this.lmToWorld(lms[0]);
      let spread = 0; for (const k of [8, 12, 16, 20]) { const t = this.lmToWorld(lms[k]); spread += Math.hypot(t.x - wrist.x, t.y - wrist.y); }
      spread /= 4;
      const open = Math.min(1, Math.max(0, (spread - 0.6) / 0.9));
      const R = this.P.suckRadius * (0.75 + 0.5 * open);
      const inter = [{ source: 'hand', kind: 'suck', x: px, y: py, vx, vy, radius: R, strength: gate * (1.25 - 0.35 * open), open }];
      hands.push({ label, score, landmarks: lms, interactors: inter, open });
    });
    this.lastHands = hands;
    this.stats.hands = hands.length; this.stats.handScore = hands[0]?.score ?? 0;
  }
}
