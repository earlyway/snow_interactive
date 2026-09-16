# Hot Chocolate Rain — 카메라 인터랙션 + 커스텀 3D 에셋 파티클

핫초코 비가 내려 화면 아래에 차오르고, 멜로우봇 3D 모델이 튜브처럼 수면에 떠오릅니다. 카메라 앞에 손을 내밀면 방울과 고인 핫초코가 손으로 빨려 들어가고, 멜로우봇을 손으로 눌러 상하좌우로 밀 수 있는 인터랙티브.
이전 버전(눈 파티클 · 적설 · 손으로 치우기)은 `backup_snow_2026-09-16.zip` 에 통째로 보관되어 있습니다.

## 실행
**가장 빠른 방법:** `start.command` 를 더블클릭 (macOS). 빈 포트를 찾아 로컬 서버를 띄우고 Chrome 에서 `?autostart=1` 모드로 엽니다 — 핫초코가 조금 고인 상태로 시작하고 카메라 권한을 바로 묻습니다. 허용하면 손을 내밀어 핫초코를 빨아들일 수 있습니다. 터미널 창을 닫으면 서버가 종료됩니다.
**처음 실행 시** macOS 가 "Terminal 이 데스크탑 폴더에 접근하려고 합니다" 팝업을 띄우면 **허용**을 눌러야 합니다. 거부하면 서버가 폴더를 읽지 못해 Chrome 에 '연결할 수 없음' 페이지만 뜹니다. 이미 거부했다면 시스템 설정 → 개인정보 보호 및 보안 → 파일 및 폴더 → Terminal → 데스크탑 폴더를 켜세요(런처가 감지해서 설정 창을 열어줍니다). 실패 원인은 같은 폴더의 `start.log` 에 남습니다.
`LEVEL=2 ./start.command` 처럼 시작 수위(0~9)를 바꿀 수 있고, `?autostart=1` 없이 열면 빈 화면 + '카메라 허용' 버튼으로 시작합니다.

카메라(getUserMedia)는 `https` 또는 `localhost` 에서만 켜집니다. 파일을 더블클릭해서 열면 마우스 모드만 동작합니다.

```bash
cd snow_interactive
python3 -m http.server 5173
# → http://localhost:5173  (Chrome / Edge 권장)
```

의존성은 전부 CDN(three@0.160, @mediapipe/tasks-vision@0.10.14)에서 로드되므로 빌드 단계가 없습니다.

## 인터랙션
| 입력 | 효과 |
|---|---|
| 손 (카메라) | 손바닥 중심에 **흡입 인터랙터**(`kind: 'suck'`). 반경 안의 방울이 손으로 끌려 들어가 코어에 닿으면 사라진다. 손이 수면에서 `suckReach` 안에 있으면 손 아래 수면에서 방울이 솟아올라 손으로 빨려가고, 그만큼 수위가 내려간다. 펼친 손은 넓게·약하게, 주먹은 좁게·세게. |
| 마우스 | 카메라가 없을 때 손 대신. 커서가 화면 안에 있는 동안 계속 빨아들인다. |
| 손/마우스 → 멜로우봇 | 손 원(반경 = 흡입 반경 × 0.45)이 멜로우봇 타원에 겹치면 겹친 만큼 밀어낸다. 위에서 누르면 잠기고 손을 떼면 부력으로 튀어 오르며, 한쪽을 누르면 기울어진다. |

## 구조 (4 레이어 분리)
| 파일 | 레이어 | 노출 인터페이스 |
|---|---|---|
| `tracking.js` | 입력 (카메라 → 손 랜드마크 → Interactor, 마우스 fallback) | `Interactor { source, kind: 'suck', x, y, vx, vy, radius, strength }` |
| `sim.js` | 시뮬레이션 (파티클 풀, 고정 스텝, 액체 수위 + 1D 파동, 흡입, 부력 강체) | `step(dt, interactors[])`, `setAsset(asset, policy)`, `setLevel(h)`, `setFloater(halfW, halfH)`, `liquid { level, wave[] }`, `floater { x, y, ang, submerged }` |
| `render.js` | 렌더 (슬롯별 InstancedMesh, 액체 스트립 메시 + 크림 띠, 멜로우봇 GLB, 조명) | `draw(sim)`, `setFloater(object3d, { height })` |
| `assets.js` | 에셋 (이미지/GLB → ParticleAsset, 기본 방울 `makeDefaultDrop`) | `ParticleAsset { geometry, material, boundingRadius, triCount }` |
| `app.js` | 조립, 파라미터 UI, 미리보기, 자동 스케일링 | — |

### 액체 모델 (`sim.js`)
- `liquid.level` = 바닥에서의 평균 수위. 방울이 수면에 닿으면 `volumeOf(i)` (= `P.fill × 크기`) 만큼 오르고, `P.maxLevel` 에서 멈춘다. `P.evaporate` 로 서서히 줄일 수 있다.
- `liquid.wave[BINS]` = 빈별 수면 변위. 스프링 격자(이웃 확산 + 복원 + 감쇠)로 파문이 퍼진다. 착지·gust·흡입이 `wvel` 에 임펄스를 준다.
- 착지 시 `P.splash` 비율로 작은 파편(DEBRIS)이 튀어 오르고 곧 사라진다.
- 렌더는 `surfaceAt(b)` 를 그대로 스트립 메시 윗줄 정점에 옮긴다. 액체(z −1.2, depthWrite on)는 멜로우봇 GLB(z < −1.2) 앞, 파티클(z −1~1) 뒤에 있어 잠긴 부분이 가려진다.

### 멜로우봇 부력 (`sim.js` stepFloater)
- `assets/glb_mallowbot_50k_huniyuan_hyperoptimizing.glb` (246,502 tri, 33 MB) 를 화면 높이의 45% 로 맞춰 띄운다. 2D PNG 마스코트와 8k GLB 는 더 이상 쓰지 않는다(파일만 남아 있음).
- 잠긴 비율 `submerged` = (수면 − 바닥면) / 높이. 약 34% 잠김이 평형이라 그 아래면 중력, 위면 부력이 우세 → 차오르면 떠오르고 눌렀다 놓으면 튀어 오른다. 액체 저항은 잠길수록 크다.
- **자유 회전**: 방향은 쿼터니언 `q`, 각속도 `w`. 손이 친 접촉점(중심→손 방향의 타원 표면 + 앞면 깊이)과 힘의 외적 τ = r × f 로 3축 토크가 들어가 옆을 치면 y축으로 돌고, 위를 누르면 앞으로 구른다(`spinStrength`). 부력 복원 토크(`floatRighting`, 잠길수록 셈)가 위·정면으로 서서히 되돌리고, 파문 기울기가 목표 '위' 방향을 살짝 흔든다. 렌더는 바운딩 구 반경만큼 뒤에 두어 어떤 방향이든 액체 평면을 뚫지 않는다.
- 바닥, 화면 상단(천장), 좌우 벽에 걸려 화면 밖으로 나가지 않는다.
- 수면 위 부분에 맞은 방울은 작은 파편을 튀기며 사라진다.

### 흡입 (`sim.js` step 내)
- 반경 `R` 안의 방울: 중심 방향 가속 `strength × suckStrength × (2 + 14·fall²)` + 약한 소용돌이 + 속도 감쇠. `d < 0.16R` 이면 흡수(`stats.absorbed`).
- 손이 수면 위 `suckReach` 안: `drawRate × (0.25 + 0.75·near²)` 개/초로 손 아래 수면에서 방울을 `emit`. 멀수록 넓게 모여 오르고, 각 방울만큼 수위가 내려간다(`stats.drawn`).

## 커스텀 에셋
기본 방울 대신 PNG/JPG/SVG(티어 1 빌보드 · 티어 2 압출) 또는 GLB 를 올리면 그 모양이 비처럼 내리고 똑같이 빨려 들어갑니다. 티어 1 은 진행 방향으로 회전하고(꼬리가 뒤), 3D 에셋은 텀블링합니다. 파이프라인 세부(마스크 · 외곽 추적 · 데시메이션 · 폴리 예산)는 `assets.js` 주석 참고.

## 파라미터 (설정 패널)
- **비**: 파티클 양, 초당 방울 수, 중력, 바람, 흔들림, 크기, 텀블링, 스플래시
- **핫초코**: 차오르는 속도 `fill`, 최대 수위 `maxLevel`, 줄어드는 속도 `evaporate`
- **손 흡입 · 멜로우봇**: 흡입 반경 `suckRadius`, 흡입 세기 `suckStrength`, 수면에서 끌어올리는 거리 `suckReach`, 끌어올리는 방울/초 `drawRate`, 멜로우봇 미는 힘 `pushStrength`, 회전 민감도 `spinStrength`, 바로 서는 힘 `floatRighting`, 무게 `floatGravity`, 트래킹 fps
- 버튼: 핫초코 비우기 / 채우기, 디버그 오버레이(수면 · 인터랙터 · 멜로우봇 충돌 타원 · 랜드마크 · 통계)
- 눈 인식(깜빡임 → 바람) 기능은 2026-09-16 에 제거됨. 얼굴 모델을 로드하지 않아 트래킹이 더 가볍다.

콘솔에서 `cocoa.sim`, `cocoa.P` 로 접근할 수 있습니다.
