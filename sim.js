// 시뮬레이션 레이어 — 하단 마시멜로 레이어(높이 level + 1D 파문 + 2D 젤리 격자) + 떠 있는 멜로우봇 + (선택) 비 파티클.
// 렌더/입력을 모르며, Interactor[] 와 ParticleAsset 만 받는다.
//   Interactor.kind : 'hand'  손/마우스 — 마시멜로를 눌러 출렁이게 하고, 떠 있는 멜로우봇(floater)을 밀 수 있다
export const MAX = 24000;
export const BINS = 160;      // 폭 방향 열 수 (파문 빈 = 젤리 격자 열)
export const JROWS = 7;       // 젤리 격자 행 수 (0 = 바닥에 고정, JROWS-1 = 윗면)
const FREE = 0, FALL = 1, DEBRIS = 3;
export const STATE = { FREE, FALL, DEBRIS };

export class Simulation {
  constructor(view, params) {
    this.view = view; this.P = params;
    const f = () => new Float32Array(MAX);
    this.x = f(); this.y = f(); this.vx = f(); this.vy = f();
    this.rx = f(); this.ry = f(); this.rz = f(); this.ax = f(); this.ay = f(); this.az = f();
    this.s = f(); this.life = f(); this.seed = f();
    this.state = new Uint8Array(MAX); this.slot = new Int32Array(MAX);
    this.free = []; for (let i = MAX - 1; i >= 0; i--) this.free.push(i);
    this.active = new Set();
    // ---- 레이어 높이: level = 바닥에서의 평균 높이(월드), wave/wvel = 빈별 윗면 변위(파문) ----
    this.liquid = { level: 0, wave: new Float32Array(BINS), wvel: new Float32Array(BINS) };
    // ---- 젤리 격자 (Live2D 식 메시 변형): 정점별 변위 dx/dy 와 속도. 행 0 은 바닥에 고정 ----
    const n = BINS * JROWS, g = () => new Float32Array(n);
    this.jelly = { cols: BINS, rows: JROWS, dx: g(), dy: g(), vx: g(), vy: g() };
    // 텍스처 위쪽 투명 여백 보정: 메시를 이만큼 늘려 '보이는' 마시멜로 윗선이 부력 기준면(surfaceAt)에 오게 한다. 렌더/앱이 setPileFill 로 설정
    this.pileScale = 1;
    // ---- 떠 있는 물체 (멜로우봇 GLB): 부력 강체. halfW/halfH 는 월드 반폭/반높이, 렌더가 setFloater 로 켠다 ----
    this.floater = null; // { x, y, vx, vy, q[4] 방향 쿼터니언, w[3] 각속도, halfW, halfH, halfD, submerged, pressed }
    this.assets = new Map(); // slotId -> ParticleAsset
    this.current = null;
    this.spawnAcc = 0; this.t = 0;
    this.stats = { falling: 0, debris: 0, level: 0, wobble: 0 };
  }

  setAsset(asset, policy) {
    const dropped = [];
    if (policy === 'reset') { this.resetAll(); dropped.push(...this.assets.keys()); this.assets.clear(); }
    this.assets.set(asset.id, asset);
    this.current = asset;
    const ids = [...this.assets.keys()];
    while (ids.length > 2) { const old = ids.shift(); dropped.push(old); this.assets.delete(old); }
    if (dropped.length) for (const i of [...this.active]) if (dropped.includes(this.slot[i])) this.recycle(i);
    return dropped;
  }

  resetAll() { for (const i of [...this.active]) this.recycle(i); this.resetLiquid(); }
  resetLiquid() {
    this.liquid.level = 0; this.liquid.wave.fill(0); this.liquid.wvel.fill(0);
    const J = this.jelly; J.dx.fill(0); J.dy.fill(0); J.vx.fill(0); J.vy.fill(0);
  }
  setLevel(h) { this.liquid.level = Math.max(0, Math.min(this.P.maxLevel, h)); }
  // fill = 텍스처에서 불투명 픽셀이 차지하는 평균 높이 비율 (0.3~1). 메시 높이 = 기준 높이 / fill
  setPileFill(fill) { this.pileScale = 1 / Math.max(0.3, Math.min(1, fill)); }

  recycle(i) { this.state[i] = FREE; this.active.delete(i); this.free.push(i); }

  // 떠 있는 물체 등록. 처음엔 바닥에 앉아 있다가 마시멜로가 높아지면 떠오른다.
  setFloater(halfW, halfH, halfD = halfW) {
    this.floater = { x: 0, y: this.view.ground + halfH, vx: 0, vy: 0, q: [0, 0, 0, 1], w: [0, 0, 0], halfW, halfH, halfD, submerged: 0, pressed: 0 };
  }
  // 쿼터니언 유틸: q 로 벡터 회전, 각속도 적분
  static rotVec(q, v) {
    const [x, y, z, w] = q, [vx, vy, vz] = v;
    const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
    return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
  }
  static integrateQ(q, w, dt) {
    const [x, y, z, s] = q, [wx, wy, wz] = w, h = 0.5 * dt;
    const nx = x + h * (wx * s + wy * z - wz * y), ny = y + h * (wy * s + wz * x - wx * z), nz = z + h * (wz * s + wx * y - wy * x), ns = s - h * (wx * x + wy * y + wz * z);
    const n = Math.hypot(nx, ny, nz, ns) || 1; q[0] = nx / n; q[1] = ny / n; q[2] = nz / n; q[3] = ns / n;
  }
  // 물체 타원 안인가 (x,y 월드)
  inFloater(x, y) { const F = this.floater; if (!F) return false; const dx = (x - F.x) / (F.halfW * 0.92), dy = (y - F.y) / (F.halfH * 0.95); return dx * dx + dy * dy < 1; }

  stepFloater(dt, interactors) {
    const F = this.floater; if (!F) return;
    const P = this.P, W = this.view.width, G = this.view.ground;
    // 잠긴 비율: 바닥(y - halfH) 부터 윗면까지 / 전체 높이. 튜브처럼 1/3 정도 잠긴 상태가 평형.
    const surf = this.surfaceAtX(F.x), REST = 0.34;
    const sub = Math.max(0, Math.min(1, (surf - (F.y - F.halfH)) / (2 * F.halfH)));
    F.submerged = sub;
    const g = P.floatGravity;
    F.vy += (-g + g * (sub / REST)) * dt;                  // 중력 vs 부력
    F.vy -= F.vy * (0.4 + 5.5 * sub) * dt;                   // 저항 (잠길수록 큼)
    F.vx -= F.vx * (0.8 + 3.5 * sub) * dt;
    // ---- 회전: 복원 토크(위·정면으로 서서히 되돌아옴) + 파문 기울기 + 감쇠 ----
    const up = Simulation.rotVec(F.q, [0, 1, 0]), fwd = Simulation.rotVec(F.q, [0, 0, 1]);
    const hl = this.surfaceAtX(F.x - F.halfW * 0.6), hr = this.surfaceAtX(F.x + F.halfW * 0.6);
    const tilt = sub > 0.02 ? Math.atan2(hr - hl, F.halfW * 1.2) * 0.8 : 0;
    const tUp = [-Math.sin(tilt), Math.cos(tilt), 0]; // 파문에 맞춰 살짝 기운 목표 '위' 방향
    const R = P.floatRighting * (0.4 + sub);                        // 잠길수록 부력 복원이 세다
    F.w[0] += ((up[1] * tUp[2] - up[2] * tUp[1]) * R + (fwd[1] * 1 - fwd[2] * 0) * R * 0.35) * dt;
    F.w[1] += ((up[2] * tUp[0] - up[0] * tUp[2]) * R + (fwd[2] * 0 - fwd[0] * 1) * R * 0.35) * dt;
    F.w[2] += ((up[0] * tUp[1] - up[1] * tUp[0]) * R) * dt;
    const wd = (0.6 + 2.6 * sub) * dt; F.w[0] -= F.w[0] * wd; F.w[1] -= F.w[1] * wd; F.w[2] -= F.w[2] * wd;
    // ---- 손/마우스로 밀기: 손 원(반경 = 손 반경의 절반)이 물체 타원에 겹치면 겹친 만큼 밀어낸다 ----
    F.pressed = 0;
    for (const I of interactors) {
      if (I.kind !== 'hand') continue;
      const pr = I.radius * 0.45;
      const dx = F.x - I.x, dy = F.y - I.y;
      const nx = dx / (F.halfW * 0.92 + pr), ny = dy / (F.halfH * 0.95 + pr);
      const d = Math.hypot(nx, ny);
      if (d >= 1 || d < 1e-4) continue;
      const pen = 1 - d, ux = nx / d, uy = ny / d;      // 손 → 물체 중심 방향
      F.pressed = Math.max(F.pressed, pen);
      const K = P.pushStrength * I.strength;
      F.vx += (ux * 18 * pen + I.vx * 0.6) * K * dt * 6; F.vy += (uy * 18 * pen + I.vy * 0.6) * K * dt * 6;
      F.x += ux * pen * 0.35 * K * dt * 6; F.y += uy * pen * 0.35 * K * dt * 6; // 관통 방지용 위치 보정
      // 접촉점 토크: 접촉점 r = 중심→손 방향의 타원 표면 + 앞면(카메라 쪽) 깊이. 힘 f 는 화면 평면 안. τ = r × f
      const cx = Math.max(-1, Math.min(1, -dx / F.halfW)), cy = Math.max(-1, Math.min(1, -dy / F.halfH));
      const r = [cx * F.halfW, cy * F.halfH, F.halfD * 0.7], f = [(ux * 18 * pen + I.vx * 0.6) * K, (uy * 18 * pen + I.vy * 0.6) * K, 0];
      const spin = P.spinStrength * dt * 6 / (F.halfW * F.halfH);
      F.w[0] += (r[1] * f[2] - r[2] * f[1]) * spin; F.w[1] += (r[2] * f[0] - r[0] * f[2]) * spin; F.w[2] += (r[0] * f[1] - r[1] * f[0]) * spin;
    }
    const wmax = 9; for (let k = 0; k < 3; k++) F.w[k] = Math.max(-wmax, Math.min(wmax, F.w[k]));
    F.x += F.vx * dt; F.y += F.vy * dt; Simulation.integrateQ(F.q, F.w, dt);
    // 바닥 / 천장(화면 상단) / 좌우 벽
    if (F.y - F.halfH < G) { F.y = G + F.halfH; if (F.vy < 0) F.vy *= -0.15; }
    const top = this.view.top - 0.05;
    if (F.y + F.halfH > top) { F.y = top - F.halfH; if (F.vy > 0) F.vy *= -0.2; }
    const lim = W / 2 - F.halfW * 0.8;                 // 몸통 대부분이 화면 안에 남도록
    if (F.x < -lim) { F.x = -lim; F.vx = Math.abs(F.vx) * 0.3; } else if (F.x > lim) { F.x = lim; F.vx = -Math.abs(F.vx) * 0.3; }
    // 물체가 윗면을 오르내리면 파문 + 젤리 윗줄이 함께 눌린다
    if (sub > 0 && sub < 1 && Math.abs(F.vy) > 0.05) {
      const b0 = this.binOf(F.x - F.halfW * 0.8), b1 = this.binOf(F.x + F.halfW * 0.8);
      const J = this.jelly, topRow = (J.rows - 1) * J.cols;
      for (let b = b0; b <= b1; b++) { this.liquid.wvel[b] -= F.vy * 0.9 * dt; J.vy[topRow + b] += F.vy * 0.6 * dt * 6; }
      this.splashAt(F.x - F.halfW * 0.9, F.vy * 0.5 * dt * 30); this.splashAt(F.x + F.halfW * 0.9, F.vy * 0.5 * dt * 30);
    }
  }

  binOf(x) { const W = this.view.width; return Math.min(BINS - 1, Math.max(0, Math.floor((x + W / 2) / W * BINS))); }
  // 빈 b 의 윗면 높이 (월드 y) — 파문 포함, 젤리 변위 제외 (멜로우봇 부력 기준면)
  surfaceAt(b) { return this.view.ground + this.liquid.level + this.liquid.wave[b]; }
  surfaceAtX(x) { return this.surfaceAt(this.binOf(x)); }
  // 방울 하나가 높이에 더하는 양 (지름 비례, 화면 폭이 넓을수록 얇게 퍼짐)
  volumeOf(i) { return this.P.fill * this.s[i] * 0.0025 * (10 / this.view.width); }

  // ---- 젤리 격자: 정점 (c 열, r 행) 의 정지 위치 / 변위 포함 실제 위치. 바닥은 화면 아래(ground - 0.5), 윗줄은 파문 포함 윗면 ----
  jellyBottom() { return this.view.ground - 0.5; }
  jellyRest(c, r, out) {
    const J = this.jelly, W = this.view.width, bottom = this.jellyBottom();
    out[0] = -W / 2 + (c / (J.cols - 1)) * W;
    out[1] = bottom + (r / (J.rows - 1)) * (this.surfaceAt(c) - bottom) * this.pileScale;
    return out;
  }
  jellyPos(c, r, out) {
    this.jellyRest(c, r, out); const i = r * this.jelly.cols + c;
    out[0] += this.jelly.dx[i]; out[1] += this.jelly.dy[i];
    return out;
  }

  // 열 c, 높이 비율 f(0 바닥~1 윗면) 위치의 젤리 변위 (행 사이 선형 보간). 2.5D 마시멜로 인스턴스가 쓴다
  jellyDisp(c, f, out) {
    const J = this.jelly, rf = Math.max(0, Math.min(1, f)) * (J.rows - 1), r0 = Math.floor(rf), r1 = Math.min(J.rows - 1, r0 + 1), t = rf - r0;
    const i0 = r0 * J.cols + c, i1 = r1 * J.cols + c;
    out[0] = J.dx[i0] * (1 - t) + J.dx[i1] * t; out[1] = J.dy[i0] * (1 - t) + J.dy[i1] * t;
    return out;
  }

  // 젤리 스텝: 정지 위치로 되돌리는 스프링 + 이웃 결합(라플라시안) + 감쇠. 손이 닿은 정점은 손 반대쪽으로 밀리고 손 속도를 얻는다.
  stepJelly(dt, interactors) {
    const J = this.jelly, P = this.P, C = J.cols, R = J.rows, { dx, dy, vx, vy } = J;
    if (this.liquid.level <= 0.02) return;
    const k = 120 * P.jellyStiff, kn = 240, damp = 3.2 * P.jellyDamp;
    for (let r = 1; r < R; r++) {
      const w = r / (R - 1);
      for (let c = 0; c < C; c++) {
        const i = r * C + c, l = c > 0 ? i - 1 : i, rr = c < C - 1 ? i + 1 : i, d = i - C, u = r < R - 1 ? i + C : i;
        vx[i] += (-k * dx[i] + kn * (dx[l] + dx[rr] + dx[d] + dx[u] - 4 * dx[i]) * (0.5 + 0.5 * w) - damp * vx[i]) * dt;
        vy[i] += (-k * dy[i] + kn * (dy[l] + dy[rr] + dy[d] + dy[u] - 4 * dy[i]) * (0.5 + 0.5 * w) - damp * vy[i]) * dt;
      }
    }
    // ---- 손/마우스 접촉 ----
    const p = [0, 0];
    for (const I of interactors) {
      if (I.kind !== 'hand' || P.jellyPush <= 0) continue;
      const Rh = I.radius * 0.8, K = P.jellyPush * I.strength;
      const surf = this.surfaceAtX(I.x), bottom = this.jellyBottom(), meshTop = bottom + (surf - bottom) * this.pileScale;
      if (I.y - Rh > meshTop + 0.3) continue;                    // 손이 마시멜로 위 공중에 있으면 무시
      const c0 = this.binOf(I.x - Rh), c1 = this.binOf(I.x + Rh);
      for (let r = 1; r < R; r++) {
        const w = r / (R - 1);
        for (let c = c0; c <= c1; c++) {
          const i = r * C + c; this.jellyPos(c, r, p);
          const ddx = p[0] - I.x, ddy = p[1] - I.y, d2 = ddx * ddx + ddy * ddy;
          if (d2 > Rh * Rh) continue;
          const d = Math.sqrt(d2) || 1e-3, fall = 1 - d / Rh, push = fall * fall * K * w;
          vx[i] += ((ddx / d) * 9 * push + I.vx * 0.45 * push) * dt * 6;
          vy[i] += ((ddy / d) * 9 * push + I.vy * 0.45 * push) * dt * 6;
        }
      }
      // 손이 윗면 근처에 있으면 파문도 눌러서 멜로우봇이 기울어지게
      const gap = I.y - surf;
      if (Math.abs(gap) < Rh) {
        const near = 1 - Math.abs(gap) / Rh, wv = this.liquid.wvel;
        for (let c = c0; c <= c1; c++) { const fx = 1 - Math.abs((c + 0.5) / BINS * this.view.width - this.view.width / 2 - I.x) / Rh; if (fx > 0) wv[c] -= 2.2 * near * fx * K * dt; }
      }
    }
    // ---- 적분 + 변위 제한 (바닥 가까울수록 작게) ----
    let wob = 0;
    for (let r = 1; r < R; r++) {
      const lim = 0.12 + 0.55 * (r / (R - 1));
      for (let c = 0; c < C; c++) {
        const i = r * C + c;
        dx[i] += vx[i] * dt; dy[i] += vy[i] * dt;
        const m = Math.hypot(dx[i], dy[i]);
        if (m > lim) { const s = lim / m; dx[i] *= s; dy[i] *= s; vx[i] *= 0.5; vy[i] *= 0.5; }
        if (m > wob) wob = m;
      }
    }
    this.stats.wobble = wob;
  }

  // 비 방울 스폰 (화면 위) — 기본은 꺼져 있고, 비 설정에서 켤 수 있다
  spawn() {
    if (!this.current || !this.free.length) return;
    const i = this.free.pop(); const P = this.P, W = this.view.width;
    this.state[i] = FALL; this.active.add(i); this.slot[i] = this.current.id;
    this.x[i] = (Math.random() - 0.5) * (W + 1); this.y[i] = this.view.top + 0.6 + Math.random() * 2.5;
    this.vx[i] = (Math.random() - 0.5) * 0.3 + P.wind * 0.5; this.vy[i] = -1.5 - Math.random() * 2;
    this.s[i] = P.sizeMin + Math.random() * (P.sizeMax - P.sizeMin);
    this.initSpin(i);
    this.seed[i] = Math.random() * 100; this.life[i] = 0;
  }
  initSpin(i) {
    const P = this.P, tum = this.current?.tier === 1 ? 0 : P.tumble;
    this.rx[i] = Math.random() * 6.28; this.ry[i] = Math.random() * 6.28; this.rz[i] = 0;
    this.ax[i] = (Math.random() - 0.5) * tum; this.ay[i] = (Math.random() - 0.5) * tum; this.az[i] = (Math.random() - 0.5) * tum * 0.6;
  }
  // 윗면에서 위로 튀는 작은 파편 (착지 스플래시)
  emit(x, y, vx, vy, size, life, slotId = this.current?.id) {
    if (!this.free.length || slotId == null) return -1;
    const i = this.free.pop();
    this.state[i] = life > 0 ? DEBRIS : FALL; this.active.add(i); this.slot[i] = slotId;
    this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy; this.s[i] = size;
    this.initSpin(i); this.seed[i] = Math.random() * 100; this.life[i] = life;
    return i;
  }
  // 윗면 파문 임펄스 (음수 = 아래로 눌림)
  splashAt(x, impulse) {
    const b = this.binOf(x), w = this.liquid.wvel;
    w[b] += impulse; if (b > 0) w[b - 1] += impulse * 0.6; if (b < BINS - 1) w[b + 1] += impulse * 0.6; if (b > 1) w[b - 2] += impulse * 0.25; if (b < BINS - 2) w[b + 2] += impulse * 0.25;
  }

  // 고정 시간 스텝
  step(dt, interactors) {
    const P = this.P, W = this.view.width, G = this.view.ground, L = this.liquid; this.t += dt;
    // 스폰
    this.spawnAcc += P.spawnRate * dt;
    while (this.spawnAcc >= 1) { this.spawnAcc -= 1; if (this.active.size < P.maxParticles) this.spawn(); }

    // ---- 파문 (1D 스프링 격자) ----
    { const h = L.wave, v = L.wvel, k = 260, tension = 14, damp = 3.0;
      for (let b = 0; b < BINS; b++) {
        const l = h[b > 0 ? b - 1 : b], r = h[b < BINS - 1 ? b + 1 : b];
        v[b] += ((l + r - 2 * h[b]) * k - h[b] * tension - v[b] * damp) * dt;
      }
      for (let b = 0; b < BINS; b++) { h[b] += v[b] * dt; if (h[b] > 0.35) h[b] = 0.35; else if (h[b] < -0.35) h[b] = -0.35; }
    }

    let nf = 0, nd = 0;
    for (const i of this.active) {
      const st = this.state[i];
      const asset = this.assets.get(this.slot[i]); if (!asset) { this.recycle(i); continue; }
      const r = this.s[i] * asset.boundingRadius;
      if (st === FALL) nf++; else nd++;
      // 물리: 중력, 흔들림, 바람, 드래그
      this.vy[i] -= P.gravity * dt;
      this.vx[i] += (P.wind + P.noise * Math.sin(this.t * 1.3 + this.seed[i]) * 0.5) * dt;
      this.vx[i] -= this.vx[i] * 0.6 * dt; this.vy[i] -= this.vy[i] * 0.15 * dt;
      if (this.vy[i] < -P.terminal) this.vy[i] = -P.terminal;
      this.x[i] += this.vx[i] * dt; this.y[i] += this.vy[i] * dt;
      // 방향: 빌보드는 진행 방향으로, 3D 는 텀블
      if (asset.tier === 1) { const target = Math.atan2(this.vy[i], this.vx[i]) + Math.PI / 2; let da = target - this.rz[i]; da = Math.atan2(Math.sin(da), Math.cos(da)); this.rz[i] += da * Math.min(1, 12 * dt); }
      else { this.rx[i] += this.ax[i] * dt; this.ry[i] += this.ay[i] * dt; this.rz[i] += this.az[i] * dt; }
      if (this.x[i] < -W / 2 - 0.5) this.x[i] += W + 1; else if (this.x[i] > W / 2 + 0.5) this.x[i] -= W + 1;
      if (st === DEBRIS) { this.life[i] -= dt; if (this.life[i] <= 0) { this.recycle(i); continue; } }
      if (this.y[i] > this.view.top + 4) { this.recycle(i); continue; }
      // ---- 멜로우봇에 맞음 (윗면 위 부분만): 작은 튐 + 회수 ----
      if (st === FALL && this.floater && this.y[i] > this.surfaceAtX(this.x[i]) && this.inFloater(this.x[i], this.y[i])) {
        if (P.splash > 0 && Math.random() < 0.5 && this.active.size < P.maxParticles) this.emit(this.x[i], this.y[i], (Math.random() - 0.5) * 1.5 + this.vx[i] * 0.3, 0.6 + Math.random() * 1.2, this.s[i] * 0.4, 0.25 + Math.random() * 0.3, this.slot[i]);
        this.recycle(i); continue;
      }
      // ---- 착지: 윗면 (또는 바닥) ----
      const b = this.binOf(this.x[i]);
      const surf = this.surfaceAt(b);
      if (this.y[i] - r * 0.4 <= surf && this.vy[i] < 0) {
        const vol = this.volumeOf(i);
        if (st === FALL && L.level < P.maxLevel) L.level = Math.min(P.maxLevel, L.level + vol);
        const speed = Math.min(6, -this.vy[i]);
        this.splashAt(this.x[i], -speed * this.s[i] * 0.45 * P.splash);
        if (st === FALL && P.splash > 0 && this.active.size < P.maxParticles && Math.random() < 0.35 * P.splash) {
          const n = 1 + (Math.random() < 0.4 ? 1 : 0);
          for (let k = 0; k < n; k++) this.emit(this.x[i] + (Math.random() - 0.5) * 0.2, surf + 0.05, (Math.random() - 0.5) * 1.6 + this.vx[i] * 0.3, 0.8 + Math.random() * speed * 0.45, this.s[i] * (0.3 + Math.random() * 0.35), 0.35 + Math.random() * 0.4, this.slot[i]);
        }
        this.recycle(i); continue;
      }
      if (this.y[i] < G - 1) { this.recycle(i); continue; }
    }

    this.stepFloater(dt, interactors);
    this.stepJelly(dt, interactors);
    this.stats.falling = nf; this.stats.debris = nd; this.stats.level = L.level;
  }
}
