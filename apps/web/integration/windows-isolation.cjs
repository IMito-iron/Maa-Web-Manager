// Test process ONLY. Production entrypoints and their application code remain unchanged.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = process.env.CLASSIC_TEST_ROOT;
if (process.env.CLASSIC_LOCAL_ISOLATION !== '1' || !root || !path.isAbsolute(root) ||
    !root.includes(path.join('.cache', 'classic-integration')) || !process.env.RUNNER_SOCKET?.startsWith('\\\\.\\pipe\\maa-classic-')) {
  throw Error('Local integration isolation contract missing');
}
const pipe = process.env.RUNNER_SOCKET;
const map = p => {
  const normalized = typeof p === 'string' ? p.replaceAll('\\', '/') : '';
  return /^\/(control-state|stats)(\/|$)/.test(normalized) ? path.join(root, normalized.slice(1)) : p;
};
for (const name of ['mkdir', 'readFile', 'writeFile']) {
  const original = fs.promises[name].bind(fs.promises);
  fs.promises[name] = (p, ...args) => original(map(p), ...args);
}
const rename = fs.promises.rename.bind(fs.promises);
fs.promises.rename = (a, b) => rename(map(a), map(b));
const chmod = fs.promises.chmod.bind(fs.promises);
fs.promises.chmod = (p, mode) => p === pipe ? Promise.resolve() : chmod(p, mode);
const rm = fs.promises.rm.bind(fs.promises);
fs.promises.rm = (p, ...args) => p === pipe ? Promise.resolve() : rm(p, ...args);
// Portal has a fixed production 0.0.0.0 bind; the test boundary narrows it to loopback.
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function(...args) {
  if (args[1] === '0.0.0.0') args[1] = '127.0.0.1';
  fs.appendFileSync(path.join(root,'listeners.jsonl'),JSON.stringify({role:process.env.CLASSIC_TEST_ROLE,args:args.map(v=>typeof v==='function'?'callback':v)})+'\n');
  return listen.apply(this, args);
};
if (process.env.CLASSIC_TEST_ROLE === 'manager') {
  const {UsbDeviceAdapter} = require(path.join(process.env.CLASSIC_SOURCE_ROOT, 'apps/server/dist/device.js'));
  const state = () => JSON.parse(fs.readFileSync(path.join(root, 'device-state.json'), 'utf8'));
  UsbDeviceAdapter.prototype.inspect = async () => ({
    address: state().ready ? 'FAKE-USB' : null, state: state().ready ? 'CONNECTED' : 'DISCONNECTED',
    reason: state().ready ? null : 'Synthetic device not ready', adb: state().ready, android: state().ready,
    device: state().ready ? {serial:'FAKE-USB', model:'Integration Fake Device'} : null,
    usb:{present:false,adbCapable:false,vid:null,pid:null,authorized:null},
  });
  UsbDeviceAdapter.prototype.binding = async () => ({address:state().ready ? 'FAKE-USB' : null, state:'FAKE', reason:null});
  UsbDeviceAdapter.prototype.list = async () => [];
  UsbDeviceAdapter.prototype.prepare = async () => { throw Error('Integration must never dispatch tasks'); };
  UsbDeviceAdapter.prototype.foreground = async () => null;
}
