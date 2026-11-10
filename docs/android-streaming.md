# Android 低延迟画面（low-latency streaming）

## Chain before (unchanged, now 兼容模式)

phone (scrcpy-server, H.264 HW, `--max-fps=30 --video-bit-rate=4M --max-size=1920`) → USB or network ADB →
device container **scrcpy client** (software decode, Mesa GL) → **Xvfb** 1920×1080 → **x11vnc**
(screen-scrape, re-encode per VNC client) → websockify → display-proxy → Portal → gateway → reverse
proxy → browser noVNC. Input: noVNC → x11vnc (`viewonly`/`noviewonly` toggled from
`control.json`) → X events → scrcpy client → scrcpy control socket → phone.

* The 30 fps cap is scrcpy's `--max-fps=30` in `device-supervisor.cjs`; the browser never sees
  encoded video, only VNC rectangles re-encoded from a 1920×1080 framebuffer.
* Remote viewers drop below 10 fps because every VNC update is a large re-encoded rectangle set:
  on an emulated 80 ms RTT / 4 Mbit/s / 0.5 % loss link noVNC delivered 4.6 visible updates/s while
  the same content over WebRTC delivered 14.7 (15 tier) and 25.3 (30 tier) fps. The bottleneck is
  the VNC transport's bandwidth/RTT sensitivity, not capture (the phone produced 26–30 fps).
* The device container spends ~0.5–3.3 CPU cores on decode + software GL + x11vnc.

## Chain now (观看模式 / 控制模式)

phone scrcpy-server (one per **tier**, not per viewer; `maa-media-scrcpy-server-5.0.1.jar`) →
adb smart socket through `device:5037` (no `adb forward`) → **media** service (Go, pion/webrtc):

* tiers `p15` (1.5 Mbit/s), `p30` (3 Mbit/s), `p60` (5 Mbit/s), long edge 1280; the tier sets the
  encoder's `max_fps`/bit rate, so 15 fps really is a 15 fps encode;
* each tier starts on its first subscriber and stops 15 s after the last one leaves;
* RTP packetised once per frame and written to every WebRTC viewer of that tier; RTP timestamps are
  taken from frame arrival (a still screen produces no frames for seconds; encoder-duration
  timestamps made Chrome's jitter buffer grow to 300–500 ms, arrival timestamps keep it at ~8 ms);
* key frames on join/PLI through scrcpy `RESET_VIDEO`, rate-limited to 1/s per tier;
* fallback: H.264 Annex-B over the same WebSocket, decoded with WebCodecs, bounded per-viewer queue
  that drops to the next key frame (a slow viewer never slows the others).

Signalling, stats and the fallback video use `wss://…/media/ws` (Portal → `media:8090/ws`).
Media uses ICE on `MEDIA_ICE_PORT` (8189 udp+tcp, single-port muxes), advertising
`MEDIA_HOST_IPS` (LAN), STUN-learnt srflx candidates (hole punching) and the public IPv4 at the
mux port (works only with a router port-forward of 8189).

## Input and authority

* Input is scrcpy's own control socket of the tier the controller watches (`INJECT_TOUCH_EVENT`,
  keycodes BACK/HOME/APP_SWITCH only), sent over a WebRTC data channel (ordered) or the WebSocket.
  Coordinates are normalised to the picture; moves are coalesced per animation frame, down/up/cancel
  are never reordered or dropped.
* Watching needs no lease. Control requires **both** Manager `GET /api/control` with the browser's
  lease cookie (Portal forwards it as `X-Control-Token`, client headers are never forwarded) →
  `owned && !running`, **and** a fresh (`< 2.5 s`) `control.json` with `held` — re-checked every
  300 ms. One controller at a time; a newer connection of the same lease replaces the older one.
* On revocation, expiry, disconnect, tier switch, rotation, or 3 s of silence while a finger is down
  the service lifts every finger (`ACTION_UP`) and stops accepting input.
* The instance never changes device state: `power_on=false cleanup=false stay_awake=false
  show_touches=false`, no audio, no clipboard; the noVNC mirror's `--turn-screen-off` is untouched.

## Files

* `apps/media/` — service (`adb.go`, `scrcpy.go`, `hub.go`, `control.go`, `session.go`, `main.go`),
  tests (`media_test.go`), isolated fixtures (`tools/fakeadb`, `tools/probe`).
* `apps/web/src/AndroidPanel.tsx`, `mediaClient.ts`, `streamInput.ts` — UI; `DevicePanel.tsx` only
  gained the mode bar slot.
* `apps/server/src/portal.ts` — `/media/ws` upgrade and `/media/stats`.
* `apps/media/tools/probe` — a headless viewer that measures frame rate and latency against a running
  media service.

Replacing the transport means touching `session.go`/`mediaClient.ts`; replacing capture means a new
`Device`/`Capture` implementation in `hub.go` (the hub is tested against a fake).
