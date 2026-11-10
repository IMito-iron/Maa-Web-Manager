#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
root=$(pwd)
temp=$(mktemp -d)
pid=''
cleanup(){ if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" || true; fi; rm -rf "$temp"; }
trap cleanup EXIT
export DATA_DIR="$temp/data" MAA_CONFIG_DIR="$temp/config" DATABASE_URL="file:$temp/test.db"
export DEVICE_CONFIG="$temp/device.json"
printf '%s' '{"version":1,"transport":"usb","serial":"TESTUSB","packageName":"com.hypergryph.arknights"}' > "$DEVICE_CONFIG"
export MAA_BIN="$root/scripts/fake-maa.sh" ADB_BIN="$root/scripts/fake-adb.sh"
export PUBLIC_ORIGIN=https://maa.example.com PORT=3107 LISTEN_HOST=127.0.0.1 TEST_URL=http://127.0.0.1:3107 WEB_DIR="$root/apps/web/dist"
chmod +x scripts/fake-maa.sh scripts/fake-adb.sh
(cd apps/server && ../../node_modules/.bin/prisma migrate deploy)
node apps/server/dist/main.js > "$temp/server.log" 2>&1 & pid=$!
for ((i=0;i<50;i++));do curl -fsS "$TEST_URL/api/health" >/dev/null 2>&1 && break; sleep .3;done
if ! node scripts/integration.cjs;then cat "$temp/server.log";exit 1;fi
# File API must reject a symlink to any external regular file.
ln -s /etc/passwd "$MAA_CONFIG_DIR/tasks/link.json"
[[ $(curl -s -o /dev/null -w '%{http_code}' "$TEST_URL/api/tasks/link") == 400 ]]
# Restart interrupts an active run and leaves another queued run paused.
node - <<'JS'
const base=process.env.TEST_URL+'/api/';
async function p(path,body={}){return (await fetch(base+path,{method:'POST',headers:{Origin:process.env.PUBLIC_ORIGIN,'Content-Type':'application/json','X-Maa-Request':'1'},body:JSON.stringify(body)})).json();}
(async()=>{await p('tasks',{name:'after',raw:'{"tasks":[{"type":"StartUp"}]}'});await p('tasks/slow/run');await p('tasks/after/run');await new Promise(r=>setTimeout(r,2000));})().catch(e=>{throw e});
JS
kill "$pid";wait "$pid";pid=''
node apps/server/dist/main.js >> "$temp/server.log" 2>&1 & pid=$!
for ((i=0;i<50;i++));do curl -fsS "$TEST_URL/api/health" >/dev/null 2>&1 && break;sleep .3;done
node - <<'JS'
const assert=require('node:assert/strict');
(async()=>{const base=process.env.TEST_URL+'/api/';const q=await (await fetch(base+'queue')).json();assert.equal(q.paused,true);assert(q.items.some(r=>r.task==='after'&&r.status==='queued'));const h=await(await fetch(base+'runs')).json();assert(h.items.some(r=>r.task==='slow'&&r.status==='interrupted'));console.log('PASS: symlink rejection and restart interruption with paused durable queue');})().catch(e=>{console.error(e);process.exit(1)});
JS
