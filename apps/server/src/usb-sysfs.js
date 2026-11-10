// The only I/O part of USB discovery: read the kernel's view of the bus.
//
// Why sysfs and not udev: the device container has no libudev and no /run/udev, and
// kernel uevents do not reach its network namespace, so ADB's own libusb hotplug
// callbacks never fire. /sys/bus/usb/devices *is* readable inside the container, so
// polling it is the one reliable way to notice that a phone was replugged or rebooted.
//
// The records produced here are plain data; all decisions live in device-policy.js.
const fs = require('node:fs');

function readDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function readTrimmed(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; }
}

function hex(value) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{1,4}$/.test(value)) return null;
  return Number.parseInt(value, 16);
}

/**
 * Enumerates USB devices as `{vid, pid, serial, authorized, interfaces:[{class,subClass,protocol}]}`.
 * A device is any sysfs entry that exposes `idVendor`; interfaces are its `name:config.iface` siblings.
 * @param {string} [root]
 */
function readUsbRecords(root = '/sys/bus/usb/devices') {
  const names = readDir(root);
  const records = [];
  for (const name of names) {
    const dir = `${root}/${name}`;
    const vid = hex(readTrimmed(`${dir}/idVendor`));
    if (vid === null) continue;
    const interfaces = [];
    for (const child of names) {
      if (!child.startsWith(`${name}:`)) continue;
      const iface = `${root}/${child}`;
      const cls = hex(readTrimmed(`${iface}/bInterfaceClass`));
      if (cls === null) continue;
      interfaces.push({
        class: cls,
        subClass: hex(readTrimmed(`${iface}/bInterfaceSubClass`)),
        protocol: hex(readTrimmed(`${iface}/bInterfaceProtocol`)),
      });
    }
    const authorized = readTrimmed(`${dir}/authorized`);
    records.push({
      vid,
      pid: hex(readTrimmed(`${dir}/idProduct`)),
      serial: readTrimmed(`${dir}/serial`),
      authorized: authorized === null ? null : authorized === '1',
      interfaces,
    });
  }
  return records;
}

module.exports = {readUsbRecords};
