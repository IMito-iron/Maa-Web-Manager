#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo 'Linux x86_64 required'; exit 1; }
docker compose version >/dev/null
[[ -f .env ]] || { echo 'Copy .env.example to .env and set PUBLIC_ORIGIN (see docs/configuration.md)'; exit 1; }
[[ -f config/devices.json ]] || { echo 'Create config/devices.json from config/devices.example.json (USB) or config/devices.tcp.example.json (network ADB)'; exit 1; }
# The device configuration decides which host resources are needed; validated by the same policy the
# manager uses, so a file deploy.sh accepts is one the containers accept.
transport=$(python3 - <<'PY'
import json,re,sys
c=json.load(open('config/devices.json'))
if c.get('version') not in (1,2): sys.exit('config/devices.json: version must be 1 or 2')
t=c.get('transport')
if t=='usb':
    s=c.get('serial','')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}',s) or s.startswith('REPLACE_'): sys.exit('config/devices.json: set "serial" to the phone serial shown by `adb devices`')
elif t=='tcp' and c['version']==2:
    if not re.fullmatch(r'[A-Za-z0-9.-]+:\d{1,5}',c.get('address','')): sys.exit('config/devices.json: set "address" to host:port')
else: sys.exit('config/devices.json: transport must be "usb", or "tcp" with version 2')
print(t)
PY
)
compose_files=${COMPOSE_FILE:-$(sed -n 's/^COMPOSE_FILE=//p' .env | tail -1)}
if [[ $transport == usb ]]; then
  [[ -d /dev/bus/usb ]] || { echo 'USB bus unavailable on this host; use a network ADB device (transport "tcp") instead'; exit 1; }
  [[ $compose_files == *compose.usb.yaml* ]] || { echo 'USB phone configured: add compose.usb.yaml to COMPOSE_FILE in .env'; exit 1; }
fi
if [[ ! -f vendor/maa-runtime.tar.gz ]]; then python3 scripts/fetch-runtime.py; fi
[[ $(df -Pk . | awk 'NR==2 {print $4}') -gt 8388608 ]] || { echo 'At least 8 GiB free disk required'; exit 1; }
docker compose config --quiet
if [[ $compose_files == *compose.proxy.yaml* ]]; then
  network=$(sed -n 's/^PROXY_NETWORK=//p' .env | tail -1); network=${network:-proxy}
  docker network inspect "$network" >/dev/null 2>&1 || { echo "Reverse-proxy network '$network' does not exist (compose.proxy.yaml)"; exit 1; }
fi
python3 scripts/prepare-data.py
docker compose build
# A USB phone must be released by any host adb server so the device container can claim it.
if [[ $transport != usb ]]; then
  :
elif [[ -x /usr/local/bin/maa-adb-guard ]]; then
  /usr/local/bin/maa-adb-guard || true
else
  adb kill-server >/dev/null 2>&1 || true
  echo 'WARNING: host adb guard not installed; a stray host `adb` will steal the USB device.'
  echo '         Install it once with: sudo scripts/install-adb-guard.sh'
fi
docker compose up -d
docker compose ps
if [[ $compose_files == *compose.proxy.yaml* ]]; then
  echo 'Point your reverse proxy (WebSocket + access list) to http://maa-manager-gateway:8080.'
else
  echo "Open $(sed -n 's/^PUBLIC_ORIGIN=//p' .env | tail -1) — the queue starts paused; press 恢复派发 to enable schedules."
fi
