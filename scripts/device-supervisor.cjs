// Fail-closed display supervisor. The same pure policy is used by the manager.
//
// Two device-level facts drive this file:
//  1. ADB in this container has no libudev, /run/udev does not exist, and kernel uevents
//     never reach this network namespace, so ADB's libusb hotplug callbacks never fire.
//     A phone that (re)appears after the adb server started is therefore invisible until
//     that server restarts. We own the server here and restart it when /sys/bus/usb/devices
//     changes, which *is* readable from inside the container.
//  2. The panel is an LCD. `screen_brightness 0` only reaches the backlight minimum, so a
//     dark panel needs scrcpy's display power off (`--turn-screen-off`), with `--stay-awake`
//     keeping the device awake so SurfaceFlinger keeps compositing and `screencap` stays
//     usable by MAA's OCR. The strategy is verified, never assumed.
const fs = require('node:fs');
const net = require('node:net');
const {execFileSync, spawn} = require('node:child_process');
const {parseDeviceConfig, resolveDevice, connectCommands, usbEntries, displaySize, displayControlCommand,
  darkStrategy, screenOffRequest, captureResetRequest, windowNeedsFit, frameStats, screenshotUsable, videoSize} = require('/opt/device-policy.js');
const {readUsbRecords} = require('/opt/usb-sysfs.js');
const configPath = process.env.DEVICE_CONFIG || '/device-config/devices.json';
const controlPath = process.env.CONTROL_STATE || '/control-state/control.json';
const statsPath = process.env.STATS_PATH || '/stats/display.json';
const scrcpyLogPath = process.env.SCRCPY_LOG || '/stats/scrcpy.log';
const adbBin = process.env.ADB_BIN || '/opt/scrcpy/adb';
const scrcpyBin = process.env.SCRCPY_BIN || '/opt/scrcpy/scrcpy';
const adbPort = Number(process.env.ADB_PORT || 5037);
// xdotool needs the display in its environment: the shortcuts that drive scrcpy's screen-off and
// capture-reset are injected through it, and a missing DISPLAY makes every call fail silently.
process.env.DISPLAY = process.env.DISPLAY || ':99';

/** The X screen scrcpy draws into; the browser matches this ratio to avoid dead padding. */
function canvasSize() {
  const match = /^(\d+)x(\d+)$/.exec(process.env.XVFB_SIZE || '');
  if (!match) return null;
  const width = Number(match[1]), height = Number(match[2]);
  return width > 0 && height > 0 ? {width, height} : null;
}
const canvas = canvasSize();

let displayPolicy;
let child;
let adbChild;
let active = null;
let lastScreenOff = 0;
let lastUsbSignature = null;
let adbRestarts = 0;
let lastAdbRestartAt = null;
let darkFallback = null;
let lastScreenOffAt = 0;
let lastCaptureResetAt = 0;
// The scrcpy window as last measured (and the canvas it was forced to cover).
let windowState = null;
let darkState = {requested: null, mode: null, reason: null, verified: null, mean: null, blackFraction: null};
let scrcpyLogTail = '';
// scrcpy's EGL/GL initialisation fails if it races a freshly started Xvfb (this container
// has no DRI3), and a scrcpy that failed that way runs on without ever rendering: no FPS
// output and a blank mirror. Both a settle gate and a watchdog cover that.
const bootAt = Date.now();
const START_SETTLE_MS = 6000;
// A stalled mirror on this device has been observed to start streaming again on its own
// after a while, so be patient before touching it, and do not keep restarting an instance
// that may be about to recover. The state is published either way.
const RENDER_DEADLINE_MS = 60000;
// An in-place restart keeps the X server warm. Restarting the whole container would
// recreate it cold and hit the very race being recovered from.
const MAX_RENDER_RECOVERIES = 1;
// How often to keep asking for a capture reset while the mirror is still frameless. It must be
// longer than a reset takes to take effect (measured 15-30s): asking again too soon restarts the
// encoder before it has come back, which is why a 30s cadence never converged.
const RENDER_RESET_MS = 120000;
let renderResetAt = 0;
let scrcpyStartedAt = 0;
let renderRecoveries = 0;
let renderHealthy = null;
let inPlaceRestart = false;
let vncReady = false;
// The video size is remembered separately from the log tail: once FPS lines flood the tail,
// the single "Texture: WxH" line scrolls out of it.
let lastVideo = null;

/**
 * A real readiness probe for the X/VNC stack, instead of guessing with a timer: x11vnc
 * answers with its RFB banner only once it can actually read the X server. Starting scrcpy
 * before that is what leaves it running with no GL context and therefore no frames.
 */
function probeVnc() {
  return new Promise(resolve => {
    const socket = net.connect({host: '127.0.0.1', port: Number(process.env.VNC_PORT || 5901)});
    const settle = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(2000);
    socket.on('data', chunk => settle(String(chunk).startsWith('RFB ')));
    socket.on('error', () => settle(false));
    socket.on('timeout', () => settle(false));
  });
}

async function waitForVnc() {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await probeVnc()) { console.error('X/VNC stack is ready'); return true; }
    await sleep(1000);
  }
  console.error('X/VNC stack did not answer; starting scrcpy anyway');
  return true;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => Date.now();

function publish(address) {
  const status = JSON.stringify({
    connected: !!child && !!address && address === active,
    address: active,
    checkedAt: now(),
    transport: transport(),
    usb: transport() === 'usb' ? usbFacts() : null,
    adb: {restarts: adbRestarts, lastRestartAt: lastAdbRestartAt, pid: adbChild?.pid ?? null},
    dark: {...darkState, fallback: darkFallback, lastScreenOffAt, lastCaptureResetAt},
    window: windowState,
    // Whether the mirror is actually producing frames; "started" is not "rendering".
    render: {healthy: renderHealthy, startedAt: scrcpyStartedAt || null, recoveries: renderRecoveries},
    canvas,
    video: lastVideo,
  });
  try {
    fs.writeFileSync(`${statsPath}.tmp`, status);
    fs.chmodSync(`${statsPath}.tmp`, 0o644);
    fs.renameSync(`${statsPath}.tmp`, statsPath);
  } catch (e) { console.error('Cannot publish display state:', e.message); }
}

// ---- device binding -------------------------------------------------------------------

function config() {
  const fd = fs.openSync(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > 16384) throw Error('Invalid configuration');
    return parseDeviceConfig(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}

function usbRecords() { try { return readUsbRecords(); } catch { return []; } }

/** Configured transport, or null while the configuration is unreadable. */
function transport() { try { return config().transport; } catch { return null; } }

/** The USB function the configured phone currently exposes, for diagnostics and messaging. */
function usbFacts() {
  try {
    const facts = usbEntries(usbRecords(), config().serial);
    return {present: facts.present, adbCapable: facts.adbCapable, vid: facts.vid, pid: facts.pid};
  } catch { return {present: false, adbCapable: false, vid: null, pid: null}; }
}

/** One poll through the manager's own policy, so both sides agree on what "bound" means. */
function binding() {
  const parsed = config();
  displayPolicy = parsed.display;
  const output = execFileSync(adbBin, ['devices', '-l'], {encoding: 'utf8', timeout: 4000, maxBuffer: 65536});
  return resolveDevice(output, parsed, parsed.transport === 'usb' ? usbFacts() : null);
}

// ---- network ADB (transport "tcp") --------------------------------------------------------
// The ADB server in this container is the only place a network transport is opened, always to the
// one configured "host:port". Backoff keeps an absent emulator from being hammered.
let connectBackoffMs = 2000;
let nextConnectAt = 0;
function ensureNetworkTransport(bound) {
  let parsed;
  try { parsed = config(); } catch { return; }
  const commands = connectCommands(parsed, bound);
  if (!commands) { connectBackoffMs = 2000; return; }
  if (now() < nextConnectAt) return;
  for (const args of commands) {
    try {
      const out = execFileSync(adbBin, args, {encoding: 'utf8', timeout: 8000, maxBuffer: 65536}).trim();
      if (args[0] === 'connect') console.error(`adb connect ${parsed.serial}: ${out.slice(0, 200)}`);
    } catch (e) { console.error(`adb ${args[0]} ${parsed.serial} failed:`, e.message); }
  }
  nextConnectAt = now() + connectBackoffMs;
  connectBackoffMs = Math.min(connectBackoffMs * 2, 30000);
}

/** Stable description of the USB topology; any change means the phone was replugged. */
function usbSignature() {
  return JSON.stringify(usbRecords().map(record => [
    record.vid, record.pid, record.serial,
    (record.interfaces || []).map(i => [i.class, i.subClass, i.protocol]).sort(),
  ]).sort());
}

// ---- adb server ownership -------------------------------------------------------------

function startAdbServer() {
  if (adbChild) return;
  // The server is started directly, so it must not inherit a client socket override.
  const env = {...process.env};
  delete env.ADB_SERVER_SOCKET;
  const spawned = spawn(adbBin, ['-a', '-P', String(adbPort), 'nodaemon', 'server'],
    {stdio: ['ignore', 'pipe', 'pipe'], env});
  adbChild = spawned;
  let tail = '';
  const keep = chunk => { tail = (tail + chunk.toString()).slice(-4096); };
  spawned.stdout.on('data', keep);
  spawned.stderr.on('data', keep);
  spawned.on('error', e => { console.error('adb server error:', e.message); adbChild = null; });
  spawned.on('close', () => {
    if (adbChild !== spawned) return;
    adbChild = null;
    if (tail.trim()) console.error('adb server exited:', tail.trim().slice(-512));
  });
}

async function waitForAdb() {
  for (let attempt = 0; attempt < 20; attempt++) {
    try { execFileSync(adbBin, ['version'], {timeout: 2000, stdio: 'ignore'}); return true; }
    catch { await sleep(500); }
  }
  console.error('adb server did not become ready');
  return false;
}

/**
 * The whole point of owning the server: force a fresh libusb enumeration without
 * restarting the container, so a replugged phone is picked up within seconds.
 */
async function restartAdbServer(reason) {
  if (now() - (lastAdbRestartAt ?? 0) < 5000) return;
  lastAdbRestartAt = now();
  adbRestarts++;
  console.error(`Restarting adb server (${reason}) #${adbRestarts}`);
  const previous = adbChild;
  adbChild = null;
  if (previous) {
    previous.removeAllListeners('close');
    previous.kill('SIGTERM');
    await sleep(400);
    if (previous.exitCode === null) previous.kill('SIGKILL');
  }
  try { execFileSync(adbBin, ['kill-server'], {timeout: 4000, stdio: 'ignore'}); } catch {}
  startAdbServer();
  await waitForAdb();
}

// ---- darkness -------------------------------------------------------------------------

const adbShell = (address, args, options = {}) =>
  execFileSync(adbBin, ['-s', address, 'shell', ...args], {timeout: 10000, maxBuffer: 2097152, ...options});

/** Scrcpy keeps the device awake; an Asleep device returns black frames from screencap. */
function ensureAwake(address) {
  try {
    const power = adbShell(address, ['dumpsys', 'power'], {encoding: 'utf8'});
    if (/mWakefulness=Asleep/.test(power)) adbShell(address, ['input', 'keyevent', '224']);
  } catch (e) { console.error('Wake check failed:', e.message); }
}

/** Fallback strategy only: lowers the backlight to its minimum. Cannot darken an LCD. */
function ensureBrightness(address) {
  if (!displayPolicy?.dark || !address) return;
  dimBacklight(address);
}

/** The backlight itself, regardless of policy: instant, and safe for MAA's screencap. */
function dimBacklight(address) {
  if (!address) return;
  try {
    adbShell(address, ['settings', 'put', 'system', 'screen_brightness_mode', '0']);
    adbShell(address, ['settings', 'put', 'system', 'screen_brightness', String(displayPolicy?.brightness ?? 0)]);
  } catch (e) { console.error('Backlight change failed:', e.message); }
}

/**
 * Apply the screen-off request from the console. Dropping the backlight is instant; what actually
 * darkens this LCD is scrcpy's own display power-off, which keeps the framebuffer compositing so
 * MAA still reads the screen. scrcpy exposes it as the MOD+o shortcut, so it is driven with
 * xdotool against the scrcpy window (no mirror restart, no jar, no adb sleep).
 */
function applyScreenOff() {
  if (!active || !child) { console.error('Screen-off requested but no mirror is running'); return; }
  dimBacklight(active);
  screenOffShortcut();
  publish(active);
}

/** scrcpy's shortcuts, driven through xdotool against the scrcpy window on :99. */
function scrcpyShortcut(combo) {
  try {
    const ids = execFileSync('xdotool', ['search', '--onlyvisible', '--class', 'scrcpy'],
      {timeout: 3000, maxBuffer: 65536, encoding: 'utf8'}).trim().split('\n').filter(Boolean);
    if (!ids.length) { console.error(`Shortcut ${combo}: no scrcpy window on :99`); return false; }
    for (const id of ids) {
      execFileSync('xdotool', ['windowfocus', '--sync', id], {timeout: 3000, stdio: 'ignore'});
    }
    // SDL must observe the FocusIn before the key arrives, otherwise it drops it as an event for an
    // unfocused window. This pause is the difference between the shortcut working and not.
    execFileSync('sleep', ['1'], {timeout: 3000, stdio: 'ignore'});
    execFileSync('xdotool', ['key', '--clearmodifiers', combo], {timeout: 3000, stdio: 'ignore'});
    return true;
  } catch (e) { console.error(`Shortcut ${combo} failed:`, e.message); return false; }
}

/** MOD+o = "turn device screen off (keep mirroring)"; MOD+Shift+o turns it back on. */
function screenOffShortcut(on = false) { return scrcpyShortcut(on ? 'alt+shift+o' : 'alt+o'); }

/**
 * MOD+Shift+r = "reset video capture/encoding". This is what revives a mirror that produces no
 * frames (measured: healthy again within ~15s), where restarting the whole scrcpy client left the
 * stream dead — so the watchdog prefers it and no longer restarts the client to recover.
 */
/**
 * MOD+Shift+r = "reset video capture/encoding". This is what revives a mirror that produces no
 * frames, where restarting the whole scrcpy client left the stream dead. The display must stay ON
 * while the encoder comes back (measured: resetting a powered-off display does nothing, and
 * powering it off again right after the reset keeps it dead), so darkness is restored later by the
 * normal re-assert once frames are flowing.
 */
function recoverMirror() {
  screenOffShortcut(true);
  return resetCapture();
}

function resetCapture() { return scrcpyShortcut('alt+shift+r'); }

/**
 * scrcpy resizes its own window (measured 976x549 inside a 1920x1080 canvas, even though it is
 * started with --window-width/height=1920x1080), which leaves the phone filling only part of the
 * canvas. Forcing the size back makes the video fill it — measured: the phone rectangle becomes
 * 1920x1080 — so the panel shows a filled picture with no client-side scaling, and therefore no
 * coordinate transform that would skew clicks in control mode.
 */
function fitScrcpyWindow() {
  const canvas = canvasSize();
  if (!canvas) return;
  try {
    const ids = execFileSync('xdotool', ['search', '--onlyvisible', '--class', 'scrcpy'],
      {timeout: 3000, maxBuffer: 65536, encoding: 'utf8'}).trim().split('\n').filter(Boolean);
    if (!ids.length) { windowState = null; return; }
    const id = ids[0];
    const geometry = execFileSync('xdotool', ['getwindowgeometry', '--shell', id], {timeout: 3000, encoding: 'utf8'});
    const width = Number(/WIDTH=(\d+)/.exec(geometry)?.[1] ?? 0);
    const height = Number(/HEIGHT=(\d+)/.exec(geometry)?.[1] ?? 0);
    if (!windowNeedsFit(canvas, {width, height})) {
      windowState = {width, height, forcedAt: windowState?.forcedAt ?? null};
      return;
    }
    execFileSync('xdotool', ['windowmove', id, '0', '0'], {timeout: 3000, stdio: 'ignore'});
    execFileSync('xdotool', ['windowsize', id, String(canvas.width), String(canvas.height)], {timeout: 3000, stdio: 'ignore'});
    windowState = {width: canvas.width, height: canvas.height, forcedAt: now(), was: {width, height}};
    console.error(`scrcpy window ${width}x${height} did not cover the ${canvas.width}x${canvas.height} canvas; forced it back`);
  } catch (e) { console.error('Window fit failed:', e.message); }
}

/** Effective strategy: a verification failure outranks the requested one. */
function effectiveDarkMode() {
  const requested = darkStrategy(displayPolicy);
  if (requested === 'none') return 'none';
  return darkFallback || requested;
}

function stopScrcpy() { if (child) child.kill('SIGTERM'); }

/**
 * Proves the chosen darkness still leaves MAA able to read the screen. A display that is
 * off in a way that stops compositing returns an all-black screencap, which breaks OCR;
 * when that happens we fall back rather than silently shipping a broken automation run.
 */
async function verifyDark(address) {
  const mode = effectiveDarkMode();
  if (mode === 'none') { darkState = {...darkState, verified: null, reason: null}; return; }
  let stats = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = execFileSync(adbBin, ['-s', address, 'exec-out', 'screencap'],
        {timeout: 15000, maxBuffer: 33554432});
      stats = frameStats(raw);
    } catch (e) { console.error('Screencap for darkness check failed:', e.message); }
    const usable = screenshotUsable(stats);
    if (usable !== false) {
      darkState = {...darkState, verified: usable, mean: stats?.mean ?? null,
        blackFraction: stats?.blackFraction ?? null, reason: null};
      return;
    }
    if (attempt < 2) { ensureAwake(address); await sleep(1000); }
  }
  darkState = {...darkState, verified: false, mean: stats?.mean ?? null,
    blackFraction: stats?.blackFraction ?? null,
    reason: `screencap went black under ${mode}; MAA OCR would fail there`};
  console.error(`${darkState.reason}; falling back to brightness-zero`);
  darkFallback = 'brightness-zero';
  publish(address);
  // The strategy is baked into the scrcpy command line, so the chain restarts to drop it;
  // the fallback is persisted in display.json and survives that restart.
  stopScrcpy();
}

// ---- scrcpy ---------------------------------------------------------------------------

function startScrcpy(address) {
  const mode = effectiveDarkMode();
  const args = ['-s', address, '--no-audio', '--no-clipboard-autosync', '--max-size=1920',
    '--max-fps=30', '--video-bit-rate=4M', '--window-borderless', '--window-x=0', '--window-y=0',
    '--window-width=1920', '--window-height=1080', '--print-fps'];
  if (displayPolicy.dark) args.push('--stay-awake');
  if (mode === 'turn-screen-off') args.push('--turn-screen-off');
  child = spawn(scrcpyBin, args, {stdio: ['ignore', 'pipe', 'pipe']});
  scrcpyLogTail = '';
  lastVideo = null;
  let tail = '';
  const log = chunk => {
    tail = (tail + chunk.toString()).slice(-16384);
    scrcpyLogTail = tail;
    const size = videoSize(tail);
    if (size) lastVideo = size;
    try { fs.writeFileSync(scrcpyLogPath, tail); fs.chmodSync(scrcpyLogPath, 0o644); } catch {}
  };
  child.stdout.on('data', log);
  child.stderr.on('data', log);
  child.on('error', () => { child = null; active = null; });
  child.on('close', () => {
    child = null; active = null;
    if (inPlaceRestart) { inPlaceRestart = false; return; }
    // Restart the whole display chain to close existing VNC sessions and clear pixels.
    process.exit(1);
  });
  darkState = {requested: darkStrategy(displayPolicy), mode, verified: null,
    reason: darkFallback ? `requested ${darkState.requested} is unusable on this panel` : null,
    mean: null, blackFraction: null};
  scrcpyStartedAt = now();
  renderHealthy = null;
  lastScreenOff = 0;
}

function configureDisplay(address) {
  // Preserve the physical display's natural axes; the game rotates to 16:9.
  const physical = execFileSync(adbBin, ['-s', address, 'shell', 'wm', 'size'],
    {encoding: 'utf8', timeout: 5000, maxBuffer: 65536});
  adbShell(address, ['wm', 'size', displaySize(displayPolicy, physical)]);
  adbShell(address, ['wm', 'density', String(displayPolicy.density)]);
}

// ---- main loop ------------------------------------------------------------------------

async function bootstrap() {
  try {
    const previous = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    if (previous?.dark?.fallback) darkFallback = previous.dark.fallback;
    if (previous?.dark?.lastScreenOffAt) lastScreenOffAt = previous.dark.lastScreenOffAt;
    if (previous?.dark?.lastCaptureResetAt) lastCaptureResetAt = previous.dark.lastCaptureResetAt;
  } catch {}
  try { execFileSync(adbBin, ['kill-server'], {timeout: 4000, stdio: 'ignore'}); } catch {}
  startAdbServer();
  await waitForAdb();
  vncReady = await waitForVnc();
  lastUsbSignature = usbSignature();
  console.error(`Supervisor ready (adb restarts=${adbRestarts}, darkFallback=${darkFallback ?? 'none'})`);
}

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    if (!adbChild) { startAdbServer(); await waitForAdb(); }
    const usbMode = transport() !== 'tcp';
    if (usbMode) {
      const signature = usbSignature();
      if (signature !== lastUsbSignature) {
        lastUsbSignature = signature;
        await restartAdbServer('USB topology changed');
      }
    }
    let bound = {address: null, state: 'DISCONNECTED', reason: null};
    try { bound = binding(); } catch {}
    if (!usbMode) ensureNetworkTransport(bound);
    publish(bound.address);
    // A replug or a container restart re-enumerates the phone, so the adb server can start
    // before the device finishes attaching and then never notice it (no hotplug events in
    // this namespace). Whenever the kernel shows the configured phone exposing an ADB
    // function but adb does not list it at all, force a fresh enumeration. Backed off to
    // once per 5s, and deliberately not applied to unauthorized/offline devices, where a
    // restart would change nothing.
    if (usbMode && !bound.address && bound.state === 'DISCONNECTED') {
      const facts = usbFacts();
      if (facts.present && facts.adbCapable) {
        await restartAdbServer('phone exposes ADB but the adb server cannot see it');
        return;
      }
    }
    const address = bound.address;
    // Only the phone can fix a device that exposes no ADB function; do not spin on it.
    if (!address || (child && address !== active)) {
      if (child && address !== active) stopScrcpy();
      return;
    }
    if (child) {
      const started = scrcpyStartedAt || now();
      // Match real counter output ("INFO: 30 fps"), not the option name in a warning line.
      if (/\d+(?:\.\d+)?\s+fps\b/.test(scrcpyLogTail)) {
        if (renderHealthy === false) console.error('scrcpy is rendering again');
        renderHealthy = true;
        renderRecoveries = 0;
      } else if (now() - started > RENDER_DEADLINE_MS) {
        renderHealthy = false;
        if (renderRecoveries < MAX_RENDER_RECOVERIES) {
          renderRecoveries++;
          console.error('scrcpy produced no frames; turning the display on and resetting capture/encoding');
          publish(address);
          if (!recoverMirror()) { inPlaceRestart = true; stopScrcpy(); }
        } else if (now() - (renderResetAt || 0) > RENDER_RESET_MS) {
          // Still nothing: keep asking for a capture reset rather than restarting the client, which
          // has been measured to leave the stream dead for minutes.
          renderResetAt = now();
          console.error('scrcpy still produced no frames; resetting capture/encoding again');
          recoverMirror();
        }
      }
      return;
    }
    if (now() - bootAt < START_SETTLE_MS || !vncReady) return;
    active = address;
    try { configureDisplay(address); }
    catch (e) { console.error('Display configuration failed:', e.message); active = null; return; }
    ensureAwake(address);
    startScrcpy(address);
    if (effectiveDarkMode() === 'brightness-zero') ensureBrightness(address);
    // The window is what scrcpy draws into; it must cover the canvas for the picture to fill it.
    setTimeout(() => { fitScrcpyWindow(); publish(address); }, 4000);
    setTimeout(() => { void verifyDark(address).catch(e => console.error('Darkness check failed:', e.message)); }, 6000);
  } finally { busy = false; }
}

// Re-assert "awake + dark" on a slower cadence so a wake or auto-brightness does not
// light the display in production.
setInterval(() => {
  if (!displayPolicy?.dark || !active) return;
  if (now() - lastScreenOff < (displayPolicy.reassertMs ?? 30000)) return;
  lastScreenOff = now();
  ensureAwake(active);
  // scrcpy resizes its own window (measured 976x549 inside the 1920x1080 canvas, ignoring
  // --window-width/height), which leaves the phone occupying a fraction of the canvas. Forcing the
  // window back makes the video fill the canvas, so the panel needs no client-side scaling at all.
  fitScrcpyWindow();
  const mode = effectiveDarkMode();
  if (mode === 'brightness-zero') ensureBrightness(active);
  // The display power-off lasts only until something wakes the screen — MAA's own taps do. scrcpy's
  // shortcut restores it without touching the mirror, so production darkness is self-healing. It is
  // skipped while the mirror has no frames: darkening the display then keeps the encoder down, so
  // darkness is only re-asserted once the picture is actually flowing.
  else if (mode === 'turn-screen-off' && renderHealthy) screenOffShortcut();
}, 1000);

// View vs control: the manager publishes the control lease state; the supervisor toggles
// x11vnc read-only so "display mode" (no lease) cannot inject input while "control mode"
// (lease held) can. Default is view-only.
setInterval(() => {
  let state;
  try { state = JSON.parse(fs.readFileSync(controlPath, 'utf8')); } catch {}
  const screenOff = screenOffRequest(state, lastScreenOffAt);
  if (screenOff) { lastScreenOffAt = screenOff; applyScreenOff(); }
  const captureReset = captureResetRequest(state, lastCaptureResetAt);
  if (captureReset) {
    lastCaptureResetAt = captureReset;
    console.error('Capture reset requested from the console');
    if (active) { recoverMirror(); fitScrcpyWindow(); }
    publish(active);
  }
  try {
    execFileSync('x11vnc', ['-display', ':99', '-remote', displayControlCommand(state)],
      {timeout: 1000, maxBuffer: 65536, stdio: 'ignore'});
  } catch (e) { console.error('Cannot enforce display input mode:', e.message); process.exit(1); }
}, 1000);

function shutdown() {
  stopScrcpy();
  if (adbChild) { adbChild.removeAllListeners('close'); adbChild.kill('SIGTERM'); }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

setInterval(() => { void tick().catch(e => console.error('tick:', e.message)); }, 1000);
void bootstrap();
