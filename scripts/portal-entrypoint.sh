#!/bin/bash
set -euo pipefail
cd /app/apps/server
# Legacy portal.db is retained for rollback only; no application authentication.
exec node dist/portal.js
