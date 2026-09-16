#!/bin/bash
# Hot Chocolate Rain 런처 — 더블클릭 한 번으로 로컬 서버를 띄우고 Chrome 에서 autostart 모드로 엽니다.
#   · 핫초코가 조금 고인 상태로 시작 (?autostart=1&level=0.8)
#   · 카메라 권한을 바로 요청 → 손을 내밀면 방울과 고인 핫초코가 손으로 빨려 들어갑니다
#   · 이 창을 닫거나 Ctrl+C 를 누르면 서버가 종료됩니다
#   · 문제가 생기면 같은 폴더의 start.log 를 확인하세요
set -u
DIR="$(cd "$(dirname "$0")" && pwd)" || { echo "폴더로 이동 실패"; read -r -p "엔터를 누르면 닫힙니다"; exit 1; }
cd "$DIR" || exit 1
LOG="$DIR/start.log"
exec > >(tee -a "$LOG") 2>&1
echo "=== $(date '+%F %T') 시작 ($DIR) ==="

LEVEL="${LEVEL:-0.8}"        # 시작 시 고여 있을 핫초코 수위 (월드 단위, 화면 높이 = 10)
PORT="${PORT:-5173}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

fail() { echo; echo "❌ $1"; echo "   (자세한 내용: $LOG)"; read -r -p "엔터를 누르면 닫힙니다 "; exit 1; }

# ---- 폴더 접근 권한 확인 (macOS: 바탕화면/문서/다운로드는 앱별 허용 필요) ----
# 처음이면 여기서 "Terminal이 데스크탑 폴더에 접근하려고 합니다" 팝업이 뜹니다 → 허용
if ! cat "$DIR/index.html" >/dev/null 2>&1; then
  echo
  echo "⚠️  Terminal 이 이 폴더($DIR)를 읽을 권한이 없어요."
  echo "   시스템 설정 → 개인정보 보호 및 보안 → 파일 및 폴더 → Terminal → '데스크탑 폴더' 를 켜고 다시 실행하세요."
  echo "   (설정 창을 열어드릴게요)"
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders" 2>/dev/null
  tccutil reset SystemPolicyDesktopFolder com.apple.Terminal >/dev/null 2>&1   # 다음 실행 때 허용 팝업이 다시 뜨도록
  fail "폴더 접근 권한을 허용한 뒤 start.command 를 다시 더블클릭해주세요."
fi

# ---- 서버 런타임 찾기: python3 → node 순 ----
SERVER_CMD=()
for PY in /opt/homebrew/bin/python3 /usr/local/bin/python3 "$(command -v python3 2>/dev/null)" /usr/bin/python3; do
  [ -n "$PY" ] && [ -x "$PY" ] || continue
  if "$PY" -c 'import http.server' >/dev/null 2>&1; then SERVER_CMD=("$PY" -m http.server --bind 127.0.0.1); echo "런타임: $PY"; break; fi
done
if [ ${#SERVER_CMD[@]} -eq 0 ]; then
  NODE="$(command -v node 2>/dev/null || true)"
  if [ -n "$NODE" ]; then
    cat > "$DIR/.serve.mjs" <<'JS'
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = process.cwd(), port = +process.argv[2];
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.glb':'model/gltf-binary', '.wasm':'application/wasm' };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, path.normalize(p)); if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'Content-Type': mime[path.extname(f)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(d); });
}).listen(port, '127.0.0.1');
JS
    SERVER_CMD=("$NODE" "$DIR/.serve.mjs"); echo "런타임: $NODE (python3 없음 → node 서버)"
  else
    fail "python3 도 node 도 없어요. 터미널에서 'xcode-select --install' 을 실행해 Python 을 설치한 뒤 다시 열어주세요."
  fi
fi

# ---- 빈 포트 찾기 (5173 부터 위로) ----
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
while port_busy "$PORT"; do PORT=$((PORT+1)); done

"${SERVER_CMD[@]}" "$PORT" >>"$LOG" 2>&1 &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null; echo; echo "서버를 종료했습니다."; }
trap 'cleanup; exit 0' INT TERM HUP
trap 'cleanup' EXIT

# ---- 서버 준비 대기 (최대 30초; 권한 팝업이 떠 있으면 그동안 기다림) ----
READY=0
for _ in $(seq 1 300); do
  if curl -fs "http://127.0.0.1:$PORT/index.html" >/dev/null 2>&1; then READY=1; break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.1
done
[ "$READY" = 1 ] || fail "서버가 뜨지 않았어요 (포트 $PORT)."

URL="http://localhost:$PORT/?autostart=1&level=$LEVEL"
echo
echo "✅ Hot Chocolate Rain  →  $URL"
echo "   손을 카메라 앞에 내밀면 핫초코가 손으로 빨려 들어가고, 떠 있는 멜로우봇을 밀 수 있어요."
echo "   종료: Ctrl+C 또는 이 창 닫기"
echo

if [ -d "/Applications/Google Chrome.app" ]; then open -a "Google Chrome" "$URL" || open "$URL"
else open "$URL"; fi

wait "$SERVER_PID"
