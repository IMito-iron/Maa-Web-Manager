# Classic UI real-service integration (Windows)

This explicit opt-in harness launches the actual compiled Manager and Portal, a loopback-only ephemeral TLS gateway, and a separate headless Chrome context. It uses a new SQLite/config directory for every run, the existing DevicePort boundary with a Fake device, and Node as a version-only Fake CLI. No real USB/ADB/Core or external service is used. Task execution is an error.

```powershell
npm ci --ignore-scripts
npm run generate -w @maa/server
npm run build
npm run test -w @maa/web
$env:CLASSIC_CHROME='C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:CLASSIC_OPENSSL=(Get-Command openssl).Source
npm run test:integration -w @maa/web
```

Both executable paths must resolve to explicit absolute local paths. No administrator, Docker changes or system certificate installation is needed. Prisma generation may download its pinned official platform engine.

The Windows-only preload narrows Portal to loopback, uses a per-run Named Pipe, remaps hardcoded /stats and /control-state into the private test tree, and skips chmod only for that pipe (no POSIX claim). Application API/Store/Engine code is unchanged. The production entries never import this preload.

The fixture Schedule is in 2099. Only the isolated empty queue is temporarily resumed for ready/unready checks; final state must be paused with Run count zero. The harness never resumes any existing Manager. Cleanup only targets child handles created and recorded by this run; all prior failure evidence is retained.

Evidence is under repository .cache/classic-integration/<UUID>/, including result.json, source/build SHA256, logs, screenshots, synthetic SQLite and ephemeral TLS keys. It is all Git-ignored and must not be committed or copied into production releases. The committed reports contain a result digest and summary only. This is not a production accepted receipt or Linux Unix Socket validation.
