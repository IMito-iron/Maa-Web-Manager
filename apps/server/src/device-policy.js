// Shared by the manager adapter and the display supervisor. No I/O here: every fact
// this module reasons about is passed in by the caller (see usb-sysfs.js for the one
// place that touches the kernel).
const DARK_MODES = ['turn-screen-off', 'brightness-zero', 'none'];

// Arknights clients MaaCore supports (MaaWpfGui ClientType → package). The package only names the
// app the device is expected to run; the MAA client type is chosen per preset.
const PACKAGES = Object.freeze([
  'com.hypergryph.arknights',           // Official (CN)
  'com.hypergryph.arknights.bilibili',  // Bilibili (CN)
  'com.YoStarEN.Arknights',             // YoStarEN
  'com.YoStarJP.Arknights',             // YoStarJP
  'com.YoStarKR.Arknights',             // YoStarKR
  'tw.txwy.and.arknights',              // txwy
]);
const TRANSPORTS = ['usb', 'tcp'];
const SERIAL = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// adb names a network device by the exact "host:port" it was connected with. Hostnames and IPv4
// only; IPv6 literals are not accepted (adb's own bracket handling differs between versions).
const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** "host:port" for a network ADB device, or null when it is not one. */
function tcpAddress(text) {
  if (typeof text !== 'string') return null;
  const match = /^([^:\s]+):(\d{1,5})$/.exec(text);
  if (!match || !HOST.test(match[1])) return null;
  const port = Number(match[2]);
  return port >= 1 && port <= 65535 ? `${match[1]}:${port}` : null;
}

/**
 * The device configuration file (DEVICE_CONFIG).
 *   version 1: {transport:"usb", serial, packageName:"com.hypergryph.arknights"}  (unchanged)
 *   version 2: {transport:"usb", serial} | {transport:"tcp", address:"host:port"}, packageName optional
 * `serial` in the result is always the identifier adb uses for the device (the address for tcp).
 */
function parseDeviceConfig(raw) {
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw new Error('Device configuration must be a JSON object');
  if (value.version !== 1 && value.version !== 2) throw new Error('Device configuration version must be 1 or 2');
  if (!TRANSPORTS.includes(value.transport) || (value.version === 1 && value.transport !== 'usb')) {
    throw new Error('Device transport must be "usb" (version 1/2) or "tcp" (version 2)');
  }
  const packageName = value.packageName ?? (value.version === 2 ? PACKAGES[0] : undefined);
  if (!PACKAGES.includes(packageName) || (value.version === 1 && packageName !== PACKAGES[0])) {
    throw new Error(`packageName must be one of: ${PACKAGES.join(', ')}`);
  }
  let serial, address = null;
  if (value.transport === 'usb') {
    if (typeof value.serial !== 'string' || !SERIAL.test(value.serial)) throw new Error('USB transport requires the exact device serial');
    serial = value.serial;
  } else {
    address = tcpAddress(value.address);
    if (!address) throw new Error('tcp transport requires address "host:port" (hostname or IPv4, port 1-65535)');
    serial = address;
  }
  const display={width:1280,height:720,density:240,dark:true,brightness:0,darkMode:'turn-screen-off',reassertMs:30000,naturalOrientation:'auto',...value.display};
  if(!['auto','portrait','landscape'].includes(display.naturalOrientation))throw new Error('Invalid naturalOrientation: expected auto, portrait or landscape');
  if(!DARK_MODES.includes(display.darkMode))throw new Error(`Invalid darkMode: expected ${DARK_MODES.join(', ')}`);
  if(!Number.isInteger(display.width)||!Number.isInteger(display.height)||display.width<720||display.width>3840||display.height<360||display.height>2160||display.width*9!==display.height*16||!Number.isInteger(display.density)||display.density<120||display.density>640||typeof display.dark!=='boolean'||!Number.isInteger(display.brightness)||display.brightness<0||display.brightness>255||!Number.isInteger(display.reassertMs)||display.reassertMs<5000||display.reassertMs>300000)throw new Error('Invalid display policy: landscape 16:9, density 120–640, brightness 0–255, interval 5000–300000 ms');
  return Object.freeze({version: value.version, transport: value.transport, serial, address, packageName, display:Object.freeze(display)});
}

/** Every line of `adb devices -l`, with the transport it uses. */
function adbDevices(output) {
  return String(output ?? '').split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !line.startsWith('List of devices') && !line.startsWith('*'))
    .map(line => line.split(/\s+/)).filter(parts => parts.length >= 2)
    .map(parts => ({serial: parts[0], state: parts[1],
      transport: parts.some(p => p.startsWith('usb:')) ? 'usb' : 'tcp',
      model: parts.find(p => p.startsWith('model:'))?.slice(6) ?? null,
      product: parts.find(p => p.startsWith('product:'))?.slice(8) ?? null}));
}

/** Binding of a network ADB device: only the exact configured "host:port" counts. */
function resolveTcp(output, address) {
  if (!address) return {address: null, state: 'DISCONNECTED', reason: 'Explicit device configuration required'};
  const device = adbDevices(output).find(d => d.serial === address && d.transport === 'tcp');
  if (!device) return {address: null, state: 'DISCONNECTED',
    reason: `网络 ADB 未连接：请确认 ${address} 上的模拟器或设备已开启 ADB 调试，且 device 容器能访问该地址`};
  if (device.state !== 'device') return {address: null,
    state: device.state === 'unauthorized' ? 'UNAUTHORIZED' : device.state === 'offline' ? 'OFFLINE' : 'DETECTED',
    reason: device.state === 'unauthorized' ? 'ADB 未授权：请在设备上允许这台计算机的调试请求'
      : device.state === 'offline' ? '网络 ADB 设备离线：将自动重新连接' : 'Configured network device is not authorized and online'};
  return {address: device.serial, state: 'CONNECTED', reason: null};
}

/** One binding rule for both transports, shared by the manager and the display supervisor. */
function resolveDevice(output, config, facts) {
  if (!config) return {address: null, state: 'DISCONNECTED', reason: 'Explicit device configuration required'};
  return config.transport === 'tcp' ? resolveTcp(output, config.serial) : resolveUsb(output, config.serial, facts);
}

/**
 * The adb client command that would (re)establish a network transport, or null. Only the device
 * container's supervisor acts on it; the manager never opens transports. Fixed argument arrays.
 * @returns {string[][]|null}
 */
function connectCommands(config, bound) {
  if (config?.transport !== 'tcp' || bound?.address) return null;
  if (bound?.state === 'OFFLINE') return [['disconnect', config.serial], ['connect', config.serial]];
  if (bound?.state === 'DISCONNECTED') return [['connect', config.serial]];
  return null;
}

/** @param {string} output */
function usbDevices(output) {
  return output.split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .filter(parts => parts.length >= 2 && parts.some(p => p.startsWith('usb:')))
    .map(parts => ({serial: parts[0], state: parts[1],
      model: parts.find(p => p.startsWith('model:'))?.slice(6) ?? null,
      product: parts.find(p => p.startsWith('product:'))?.slice(8) ?? null}));
}

// ADB's USB function is vendor-specific class 0xff / subclass 0x42. Its presence is
// what separates "the phone is not plugged in" from "the phone is plugged in but is
// not exposing ADB at all" — two failures with completely different user actions.
const ADB_INTERFACE = {class: 0xff, subClass: 0x42};

/**
 * Facts about the configured device as the kernel sees it.
 * @param {{vid:number|null,pid:number|null,serial:string|null,authorized:boolean|null,interfaces:{class:number|null,subClass:number|null,protocol:number|null}[]}[]} records
 * @param {string|null} serial
 */
function usbEntries(records, serial) {
  const absent = {present: false, adbCapable: false, vid: null, pid: null, authorized: null};
  if (!serial) return absent;
  const match = (records || []).find(record => record && record.serial === serial);
  if (!match) return absent;
  const adbCapable = (match.interfaces || []).some(iface => iface &&
    iface.class === ADB_INTERFACE.class && iface.subClass === ADB_INTERFACE.subClass);
  return {present: true, adbCapable, vid: match.vid ?? null, pid: match.pid ?? null,
    authorized: match.authorized ?? null};
}

// Actionable text only: each branch tells the operator which side to fix.
function absentReason(facts) {
  if (!facts || facts.present !== true) {
    return 'USB 未枚举：请检查数据线与供电后重新插拔';
  }
  if (facts.adbCapable !== true) {
    return 'USB 已枚举但未提供 ADB 接口：请在手机上确认「USB 调试」已开启、USB 用途为「传输文件」，再重新插拔';
  }
  return 'ADB 服务未识别到设备：宿主机 adb 可能正在占用 USB，或需重启设备侧 adb 服务';
}

/** @param {{present:boolean,adbCapable:boolean}?} facts optional; omitting it preserves the legacy single-reason behaviour */
function resolveUsb(output, serial, facts) {
  if (!serial) return {address: null, state: 'DISCONNECTED', reason: 'Explicit device configuration required'};
  const device = usbDevices(output).find(d => d.serial === serial);
  if (!device) return {address: null, state: 'DISCONNECTED', reason: absentReason(facts)};
  if (device.state !== 'device') return {address: null,
    state: device.state === 'unauthorized' ? 'UNAUTHORIZED' : device.state === 'offline' ? 'OFFLINE' : 'DETECTED',
    reason: device.state === 'unauthorized'
      ? 'ADB 未授权：请在手机上勾选「始终允许使用这台计算机」'
      : device.state === 'offline' ? 'ADB 设备离线：请重新插拔 USB'
      : 'Configured USB device is not authorized and online'};
  return {address: device.serial, state: 'CONNECTED', reason: null};
}

// width/height describe the game frame, not Android's unrotated display.
// Swapping a portrait phone's natural axes puts its cutout on the long edge;
// shortEdges applications then render an inset, non-16:9 game image.
function displaySize(display, wmSize) {
  let orientation=display.naturalOrientation;
  if(orientation==='auto') {
    const physical=/Physical size:\s*(\d+)x(\d+)/.exec(wmSize);
    if(!physical||Number(physical[1])===Number(physical[2]))throw new Error('Cannot determine natural display orientation from physical size');
    orientation=Number(physical[1])<Number(physical[2])?'portrait':'landscape';
  }
  return orientation==='portrait'?`${display.height}x${display.width}`:`${display.width}x${display.height}`;
}

function displayControlCommand(state, now=Date.now()) {
  const age=now-state?.checkedAt;
  return state?.held===true&&Number.isFinite(age)&&age>=0&&age<2500?'noviewonly':'viewonly';
}

/**
 * How to make the panel dark. A phone LCD emits nothing on its own, so
 * `screen_brightness 0` only lowers the backlight to its minimum and the panel stays
 * visibly lit; only a display power-off (scrcpy's `--turn-screen-off`) darkens it
 * while the display keeps compositing for `screencap`.
 * @returns {'turn-screen-off'|'brightness-zero'|'none'}
 */
function darkStrategy(display) {
  if (!display || display.dark !== true) return 'none';
  return DARK_MODES.includes(display.darkMode) ? display.darkMode : 'turn-screen-off';
}

/**
 * A one-shot request from the console, applied once per request: the timestamp is returned while it
 * is newer than the one the supervisor last acted on, so neither side restarting can repeat it
 * behind the operator's back.
 * @param {string} key field holding the request timestamp in the shared control state
 * @returns {number|null}
 */
function pendingRequest(state, key, appliedAt) {
  const requested = Number(state?.[key]) || 0;
  return requested > (Number(appliedAt) || 0) ? requested : null;
}

/** Darken the phone now (backlight + scrcpy's own display power-off). */
function screenOffRequest(state, appliedAt) {
  return pendingRequest(state, 'screenOffAt', appliedAt);
}

/** Reset scrcpy's video capture/encoding: the only thing that revives a mirror with no frames. */
function captureResetRequest(state, appliedAt) {
  return pendingRequest(state, 'captureResetAt', appliedAt);
}

/** Scrcpy sizes its own window (measured 976x549 inside a 1920x1080 canvas), so it is forced back. */
function windowNeedsFit(canvas, window) {
  const width = Number(canvas?.width), height = Number(canvas?.height);
  if (!(width > 0 && height > 0)) return false;
  // A window that already fills the canvas is left alone; a missing measurement is acted on.
  return Number(window?.width) !== width || Number(window?.height) !== height;
}

const BLACK_LUMA = 8;
const MAX_SAMPLED_PIXELS = 200000;

const luma = (r, g, b) => (r * 299 + g * 587 + b * 114) / 1000;

/**
 * Statistics over an `adb exec-out screencap` frame: a 12-byte little-endian header
 * (width, height, format) followed by RGBA rows. Sampling keeps this cheap on a
 * phone-sized frame. Pure, so it is unit-testable with a synthetic buffer.
 * @param {Buffer} buffer
 * @returns {{width:number,height:number,format:number,blackFraction:number,mean:number}|null}
 */
function frameStats(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const width = buffer.readUInt32LE(0);
  const height = buffer.readUInt32LE(4);
  if (!width || !height) return null;
  const stride = width * 4;
  if (buffer.length < 12 + stride * height) return null;
  const step = Math.max(1, Math.floor((width * height) / MAX_SAMPLED_PIXELS));
  let black = 0, sum = 0, count = 0;
  for (let y = 0; y < height; y++) {
    const row = 12 + y * stride;
    for (let x = 0; x < width; x += step) {
      const at = row + x * 4;
      const value = luma(buffer[at], buffer[at + 1], buffer[at + 2]);
      if (value < BLACK_LUMA) black++;
      sum += value; count++;
    }
  }
  return {width, height, format: buffer.readUInt32LE(8), blackFraction: black / count, mean: sum / count};
}

/**
 * Whether one screencap is still usable by MAA's OCR. `null` means "undeterminable"
 * (no frame or unusable buffer), which must not be mistaken for success.
 * @param {{blackFraction:number,mean:number}|null} stats
 * @returns {boolean|null}
 */
function screenshotUsable(stats) {
  if (!stats || !Number.isFinite(stats.blackFraction) || !Number.isFinite(stats.mean)) return null;
  return !(stats.blackFraction > 0.99 || stats.mean < 30);
}

/** Last video size scrcpy advertised in its `--print-fps` log, or null. */
function videoSize(log) {
  const matches = String(log ?? '').match(/Texture:\s*(\d+)x(\d+)/g);
  if (!matches || !matches.length) return null;
  const parsed = /Texture:\s*(\d+)x(\d+)/.exec(matches[matches.length - 1]);
  const width = Number(parsed[1]), height = Number(parsed[2]);
  return width > 0 && height > 0 ? {width, height} : null;
}

module.exports = {PACKAGES, parseDeviceConfig, tcpAddress, adbDevices, usbDevices, usbEntries, resolveUsb, resolveTcp,
  resolveDevice, connectCommands, displaySize,
  displayControlCommand, darkStrategy, screenOffRequest, captureResetRequest, windowNeedsFit,
  frameStats, screenshotUsable, videoSize};
