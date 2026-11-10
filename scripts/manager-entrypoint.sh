#!/bin/bash
set -euo pipefail
mkdir -p /data/logs /data/cache /config/tasks /config/profiles
if [ ! -e /config/profiles/default.json ]; then
  printf '%s' '{"connection":{"preset":"ADB"},"instance_options":{"touch_mode":"ADB","kill_adb_on_exit":false}}' > /config/profiles/default.json
fi
cd /app/apps/server
# Lock remains inherited through the process lifetime. A second manager cannot migrate or dispatch.
exec 9>/data/executor.lock
flock -n 9 || { echo 'Another manager owns the executor lock' >&2; exit 1; }
node /app/scripts/install-maa-resource.cjs
/app/node_modules/.bin/prisma migrate deploy
exec node dist/main.js
