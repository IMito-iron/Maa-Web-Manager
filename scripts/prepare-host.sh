#!/bin/bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run with sudo'; exit 1; }
modprobe binder_linux devices=binder,hwbinder,vndbinder
mkdir -p /dev/binderfs
mountpoint -q /dev/binderfs || mount -t binder binder /dev/binderfs
# Adopt the existing unit name without stopping an active mount.
cat > /etc/systemd/system/maa-binder.service <<'UNIT'
[Unit]
Description=MAA Manager Binder prerequisite
Before=docker.service
After=systemd-modules-load.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c 'modprobe binder_linux devices=binder,hwbinder,vndbinder; mkdir -p /dev/binderfs; mountpoint -q /dev/binderfs || mount -t binder binder /dev/binderfs'
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable maa-binder.service
