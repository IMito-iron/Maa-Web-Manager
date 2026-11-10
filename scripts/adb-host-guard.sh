#!/bin/bash
# Release the USB device from any *host* adb server so the device container can own it.
#
# The host `adb` package auto-starts a server whenever the `adb` command runs, and that
# server claims the phone's USB device, which the container's adb server then cannot get.
# The container runs its own server inside its own network namespace, so killing the
# host's listener never touches it.
#
# Installed and scheduled by scripts/install-adb-guard.sh (boot + periodic sweep).
set -euo pipefail
ADB=${ADB_BIN:-/usr/bin/adb}
[[ -x "$ADB" ]] || exit 0

# Do nothing when no host adb server is listening: running `adb kill-server` then would
# spawn a server just to kill it. Only this network namespace is visible here, so the
# container's own adb server is never considered.
if ! ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE ':5037$'; then
  exit 0
fi

"$ADB" kill-server >/dev/null 2>&1 || true
echo "maa-adb-guard: released the USB device from the host adb server" >&2
