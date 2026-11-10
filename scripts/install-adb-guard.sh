#!/bin/bash
# Installs the host adb guard that keeps the dedicated phone's USB device owned by the
# device container. Idempotent: safe to re-run, never restarts Docker or the stack.
#
#   sudo scripts/install-adb-guard.sh
#
# Why this exists: the host `adb` package starts a server on demand, and that server
# claims the phone. The container's adb server cannot then see the phone, and the manager
# reports a disconnected device. Two units make that failure self-healing:
#   maa-adb-guard.service       oneshot before docker.service, releases USB at boot
#   maa-adb-guard.timer         sweeps every minute for a stray host adb server
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo 'Run as root: sudo scripts/install-adb-guard.sh' >&2; exit 1; }
cd "$(dirname "$0")"

GUARD=/usr/local/bin/maa-adb-guard
UNIT_DIR=/etc/systemd/system

# The guard is installed as a self-contained copy so the units do not depend on the
# repository staying at this path.
install -m 0755 adb-host-guard.sh "$GUARD"

write_unit() {
  local name=$1
  local temp
  temp=$(mktemp "${UNIT_DIR}/.${name}.XXXXXX")
  cat >"$temp"
  chmod 0644 "$temp"
  mv -f "$temp" "${UNIT_DIR}/${name}"
}

write_unit maa-adb-guard.service <<'EOF'
[Unit]
Description=Release the USB device from any host adb server (MAA manager owns it)
Documentation=file:/usr/local/bin/maa-adb-guard
After=local-fs.target
Before=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/maa-adb-guard

[Install]
WantedBy=multi-user.target
EOF

write_unit maa-adb-guard-sweep.service <<'EOF'
[Unit]
Description=Sweep a stray host adb server that would steal the phone's USB device

[Service]
Type=oneshot
ExecStart=/usr/local/bin/maa-adb-guard
EOF

write_unit maa-adb-guard.timer <<'EOF'
[Unit]
Description=Periodically release the phone's USB device from a stray host adb server

[Timer]
OnBootSec=2min
OnUnitActiveSec=60s
AccuracySec=10s
Persistent=false
Unit=maa-adb-guard-sweep.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now maa-adb-guard.service maa-adb-guard.timer >/dev/null
# One immediate pass, so the phone is released without waiting for the timer.
systemctl start maa-adb-guard.service

echo 'Installed:'
systemctl is-enabled maa-adb-guard.service maa-adb-guard.timer
systemctl is-active maa-adb-guard.service maa-adb-guard.timer
echo
echo 'The container keeps its own adb server in a separate network namespace, so this'
echo 'touch neither the running stack nor the phone connection. Never run bare `adb` on'
echo 'the host; use: docker exec maa-manager-device-1 /opt/scrcpy/adb devices -l'
