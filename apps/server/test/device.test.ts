import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDeviceConfig, tcpAddress, adbDevices, resolveDevice, connectCommands, resolveUsb, usbDevices, usbEntries, displaySize, displayControlCommand,
  darkStrategy, screenOffRequest, captureResetRequest, windowNeedsFit, frameStats, screenshotUsable,
  videoSize} from '../src/device-policy';
import {AdbDeviceAdapter, UsbDeviceAdapter} from '../src/device';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('exact USB identity, independent of metadata ordering',()=>{
  const output='List of devices attached\nABCDEF device usb:1-2 model:other\nABC device product:p model:phone usb:1-3 transport_id:7\n';
  assert.equal(resolveUsb(output,'ABC').address,'ABC');
  assert.equal(resolveUsb(output,'AB').address,null);
  assert.equal(usbDevices(output).length,2);
});

test('adapter never issues device operations when configured USB binding is absent',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'maa-device-test-'));
  try {
    const file=path.join(dir,'device.json');
    await fs.writeFile(file,JSON.stringify({version:1,transport:'usb',serial:'ABC',packageName:'com.hypergryph.arknights'}));
    const calls:string[][]=[];
    const adapter=new UsbDeviceAdapter(file,'fake-adb',{run:async(_bin,args)=>{calls.push(args);return 'OTHER device usb:1-3\nABC device transport_id:2\n';}});
    assert.equal((await adapter.inspect()).adb,false);
    assert.deepEqual(calls,[['devices','-l']]);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('no fallback to TCP, first device, unauthorized or offline',()=>{
  for(const output of ['', 'ABC device product:p transport_id:1','ABC unauthorized usb:1-2','ABC offline usb:1-2','OTHER device usb:1-2']) {
    assert.equal(resolveUsb(output,'ABC').address,null);
  }
  assert.equal(resolveUsb('ABC device usb:1-2','').address,null);
});
test('strict configuration rejects wireless and malformed identities',()=>{
  const config={version:1,transport:'usb',serial:'ABC123',packageName:'com.hypergryph.arknights'};
  assert.equal(parseDeviceConfig(JSON.stringify(config)).serial,'ABC123');
  for(const serial of ['', '127.0.0.1:5555','a\nb','--help']) {
    assert.throws(()=>parseDeviceConfig(JSON.stringify({...config,serial})));
  }
  assert.throws(()=>parseDeviceConfig(JSON.stringify({...config,transport:'tcp'})));
});

test('game resolution preserves natural phone axes instead of moving the cutout to the long edge',()=>{
  const base={version:1,transport:'usb',serial:'TEST',packageName:'com.hypergryph.arknights'};
  const policy=parseDeviceConfig(JSON.stringify(base)).display;
  assert.equal(displaySize(policy,'Physical size: 1080x2400\nOverride size: 1280x720'),'720x1280');
  assert.equal(displaySize(policy,'Physical size: 1920x1080\nOverride size: 720x1280'),'1280x720');
  assert.throws(()=>displaySize(policy,'Override size: 1280x720'));
  assert.throws(()=>displaySize(policy,'Physical size: 1000x1000'));
  assert.equal(displaySize({...policy,naturalOrientation:'landscape'},''),'1280x720');
  assert.equal(displaySize({...policy,naturalOrientation:'portrait'},''),'720x1280');
  assert.throws(()=>parseDeviceConfig(JSON.stringify({...base,display:{naturalOrientation:'unknown'}})));
});

test('display input is read-only unless a fresh Runner heartbeat explicitly grants control',()=>{
  for(const state of [undefined,{}, {held:true}, {held:false,checkedAt:1000}, {held:true,checkedAt:0}, {held:true,checkedAt:4000}]) {
    assert.equal(displayControlCommand(state,3000),'viewonly');
  }
  assert.equal(displayControlCommand({held:true,checkedAt:1000},3000),'noviewonly');
  assert.equal(displayControlCommand({held:true,checkedAt:1000},3500),'viewonly');
});

test('preflight wakes the exact USB device and verifies keyguard; secure lock fails without PIN input',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'maa-wake-'));
  const file=path.join(dir,'device.json');
  await fs.writeFile(file,JSON.stringify({version:1,transport:'usb',serial:'TEST',packageName:'com.hypergryph.arknights'}));
  try {
    let locked=false;const calls:string[][]=[];
    const adapter=new UsbDeviceAdapter(file,'fake',{run:async(_bin,args)=>{
      calls.push(args);
      if(args[0]==='devices')return 'TEST device usb:1-1';
      if(args.includes('power'))return 'mWakefulness=Awake\n'+'x'.repeat(330000);
      if(args.includes('policy'))return `KeyguardServiceDelegate\n showing=${locked}\n secure=${locked}\n`;
      return '';
    }});
    await adapter.prepare('TEST');
    assert.ok(calls.some(c=>c.join(' ')==='-s TEST shell input keyevent 224'));
    assert.ok(calls.some(c=>c.join(' ')==='-s TEST shell wm dismiss-keyguard'));
    assert.equal(calls.some(c=>c.includes('26')),false);
    locked=true;await assert.rejects(()=>adapter.prepare('TEST'),/安全锁屏/);
    const before=calls.length;await assert.rejects(()=>adapter.prepare('OTHER'),/device changed before wake/i);
    assert.equal(calls.length,before+1);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

// The four ways a bound phone can be missing need four different user actions, so the
// reason must distinguish them instead of reporting one generic message.
test('absent binding reasons name the side the operator has to fix',()=>{
  const empty='List of devices attached\n';
  const missing=usbEntries([], 'ABC');
  assert.match(resolveUsb(empty,'ABC',missing).reason,/USB 未枚举/);
  assert.equal(resolveUsb(empty,'ABC',missing).state,'DISCONNECTED');

  // Enumerated, but the phone exposes no ADB function: only the phone can fix this.
  const noAdb=usbEntries([{vid:0x1782,pid:0x4021,serial:'ABC',authorized:true,
    interfaces:[{class:1,subClass:1,protocol:0},{class:1,subClass:3,protocol:0}]}], 'ABC');
  assert.deepEqual(noAdb,{present:true,adbCapable:false,vid:0x1782,pid:0x4021,authorized:true});
  assert.match(resolveUsb(empty,'ABC',noAdb).reason,/未提供 ADB 接口/);

  // ADB function present but adb still cannot see it: the host or the server is at fault.
  const withAdb=usbEntries([{vid:0x19d2,pid:0x0306,serial:'ABC',authorized:true,
    interfaces:[{class:0xff,subClass:0x42,protocol:1}]}], 'ABC');
  assert.equal(withAdb.adbCapable,true);
  assert.match(resolveUsb(empty,'ABC',withAdb).reason,/宿主机 adb 可能正在占用/);

  // Legacy call shape without enumeration facts keeps its previous behaviour.
  assert.equal(resolveUsb(empty,'ABC').address,null);

  assert.match(resolveUsb('ABC unauthorized usb:1-2','ABC',withAdb).reason,/始终允许/);
  assert.equal(resolveUsb('ABC unauthorized usb:1-2','ABC',withAdb).state,'UNAUTHORIZED');
  assert.equal(resolveUsb('ABC offline usb:1-2','ABC',withAdb).state,'OFFLINE');
});

test('darkness strategy rejects unknown modes and honours the typed policy',()=>{
  const base={version:1,transport:'usb',serial:'TEST',packageName:'com.hypergryph.arknights'};
  assert.equal(darkStrategy(parseDeviceConfig(JSON.stringify(base)).display),'turn-screen-off');
  for(const darkMode of ['brightness-zero','none','turn-screen-off']){
    assert.equal(darkStrategy(parseDeviceConfig(JSON.stringify({...base,display:{darkMode}})).display),darkMode);
  }
  assert.equal(darkStrategy(parseDeviceConfig(JSON.stringify({...base,display:{dark:false}})).display),'none');
  assert.throws(()=>parseDeviceConfig(JSON.stringify({...base,display:{darkMode:'asleep'}})),/Invalid darkMode/);
});

// A genuine power-off that stops compositing makes screencap black, which breaks OCR.
test('a black screencap is detected so the darkness strategy can be rolled back',()=>{
  const frame=(width:number,height:number,fill:number)=>{
    const buffer=Buffer.alloc(12+width*height*4);
    buffer.writeUInt32LE(width,0);buffer.writeUInt32LE(height,4);buffer.writeUInt32LE(1,8);
    buffer.fill(fill,12);
    return buffer;
  };
  const black=frameStats(frame(8,8,0)), bright=frameStats(frame(8,8,200));
  assert.equal(black?.mean,0);assert.equal(black?.blackFraction,1);
  assert.equal(screenshotUsable(black),false);
  assert.equal(screenshotUsable(bright),true);
  assert.equal(screenshotUsable(null),null);
  assert.equal(frameStats(Buffer.alloc(8)),null);
  assert.equal(frameStats(frame(4,4,10))?.width,4);
});

test('capture geometry comes from the supervisor log, not from a guess',()=>{
  assert.deepEqual(videoSize('INFO: Texture: 720x1280\n'),{width:720,height:1280});
  assert.deepEqual(videoSize('INFO: Initial texture: 1080x1920\nINFO: Texture: 1280x720\n'),{width:1280,height:720});
  assert.equal(videoSize(''),null);
  assert.equal(videoSize('INFO: 30 fps'),null);
});

// A run that failed because an administrative screen was left open looks identical to a
// game-side failure; recording the foreground package is what makes it legible.
test('foreground package is reported, and never invented',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'maa-foreground-'));
  const file=path.join(dir,'device.json');
  await fs.writeFile(file,JSON.stringify({version:1,transport:'usb',serial:'TEST',packageName:'com.hypergryph.arknights'}));
  try {
    const adapter=new UsbDeviceAdapter(file,'fake',{run:async(_bin,args)=>{
      if(args.includes('window'))return '  mCurrentFocus=Window{5e5f1b0 u0 com.afwsamples.testdpc/com.afwsamples.testdpc.policy.PolicyManagementActivity}\n';
      if(args.includes('getpropc'))return '';
      return '';
    }});
    assert.equal(await adapter.foreground('TEST'),'com.afwsamples.testdpc');
    const game=new UsbDeviceAdapter(file,'fake',{run:async()=>
      '  mCurrentFocus=Window{d41d8cd9 u0 com.hypergryph.arknights/com.u8.sdk.U8UnityContext}\n'});
    assert.equal(await game.foreground('TEST'),'com.hypergryph.arknights');
    const unknown=new UsbDeviceAdapter(file,'fake',{run:async()=> '  mCurrentFocus=null\n'});
    assert.equal(await unknown.foreground('TEST'),null);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

// A console screen-off request is applied once: the supervisor records the timestamp it acted on,
// so a restart of either side cannot make the phone go dark again behind the operator's back.
test('a screen-off request is delivered once',()=>{
  assert.equal(screenOffRequest(null,0),null);
  assert.equal(screenOffRequest({checkedAt:1},0),null);
  assert.equal(screenOffRequest({screenOffAt:1000},0),1000);
  assert.equal(screenOffRequest({screenOffAt:1000},1000),null,'already applied');
  assert.equal(screenOffRequest({screenOffAt:1000},1001),null);
  assert.equal(screenOffRequest({screenOffAt:2000},1000),2000,'a newer request applies');
  // The capture reset travels the same way but under its own field, so neither can trigger the other.
  assert.equal(captureResetRequest({screenOffAt:1000},0),null);
  assert.equal(captureResetRequest({captureResetAt:1000},0),1000);
  assert.equal(captureResetRequest({captureResetAt:1000},1000),null);
});

// scrcpy sizes its own window (measured 976x549 inside a 1920x1080 canvas even though it is started
// with --window-width/height=1920x1080), which leaves the phone filling only part of the canvas.
test('a mirror window that does not cover the canvas is re-fitted',()=>{
  const canvas={width:1920,height:1080};
  assert.equal(windowNeedsFit(canvas,{width:976,height:549}),true);
  assert.equal(windowNeedsFit(canvas,{width:1920,height:1080}),false);
  assert.equal(windowNeedsFit(canvas,null),true,'an unmeasured window is acted on');
  assert.equal(windowNeedsFit(null,{width:976,height:549}),false,'without a canvas there is nothing to fit');
  assert.equal(windowNeedsFit({width:0,height:0},{width:1,height:1}),false);
});

test('device config v2: usb or one exact network address, and any supported Arknights client', () => {
  const tcp=parseDeviceConfig(JSON.stringify({version:2,transport:'tcp',address:'emulator.local:05555'}));
  assert.equal(tcp.transport,'tcp');
  assert.equal(tcp.serial,'emulator.local:5555','the adb identifier is the normalised host:port');
  assert.equal(tcp.packageName,'com.hypergryph.arknights','v2 defaults to the official client');
  assert.equal(parseDeviceConfig(JSON.stringify({version:2,transport:'usb',serial:'ABC',packageName:'com.YoStarJP.Arknights'})).packageName,'com.YoStarJP.Arknights');
  for(const address of ['10.0.0.2','[::1]:5555','host:0','host:70000','-bad-:5555','a b:5555',''])
    assert.throws(()=>parseDeviceConfig(JSON.stringify({version:2,transport:'tcp',address})),/host:port/,address);
  assert.throws(()=>parseDeviceConfig(JSON.stringify({version:1,transport:'tcp',address:'10.0.0.2:5555'})),/transport/);
  assert.throws(()=>parseDeviceConfig(JSON.stringify({version:1,transport:'usb',serial:'ABC',packageName:'com.YoStarJP.Arknights'})),/packageName/,'v1 keeps its exact contract');
  assert.throws(()=>parseDeviceConfig(JSON.stringify({version:2,transport:'usb',serial:'ABC',packageName:'com.example.other'})),/packageName/);
  assert.equal(tcpAddress('10.0.0.2:5555'),'10.0.0.2:5555');
});

test('network binding only accepts the configured host:port over a non-USB transport', () => {
  const config=parseDeviceConfig(JSON.stringify({version:2,transport:'tcp',address:'10.0.0.2:5555'}));
  const listing='List of devices attached\n10.0.0.2:5555 device product:x model:Emu\nABC device usb:1-2 model:Phone\n';
  assert.deepEqual(resolveDevice(listing,config,null),{address:'10.0.0.2:5555',state:'CONNECTED',reason:null});
  assert.equal(resolveDevice('10.0.0.2:5556 device\n',config,null).address,null);
  assert.match(resolveDevice('',config,null).reason,/网络 ADB 未连接/);
  assert.equal(resolveDevice('10.0.0.2:5555 offline\n',config,null).state,'OFFLINE');
  assert.equal(resolveDevice('10.0.0.2:5555 unauthorized\n',config,null).state,'UNAUTHORIZED');
  // A USB config is never satisfied by a network device of the same name, and vice versa.
  const usb=parseDeviceConfig(JSON.stringify({version:2,transport:'usb',serial:'ABC'}));
  assert.equal(resolveDevice('ABC device product:x\n',usb,{present:true,adbCapable:true}).address,null);
  assert.equal(resolveDevice(listing,usb,{present:true,adbCapable:true}).address,'ABC');
  assert.deepEqual(adbDevices(listing).map(d=>[d.serial,d.transport]),[['10.0.0.2:5555','tcp'],['ABC','usb']]);
});

test('only the configured network address is ever (re)connected, with fixed argument arrays', () => {
  const config=parseDeviceConfig(JSON.stringify({version:2,transport:'tcp',address:'10.0.0.2:5555'}));
  assert.deepEqual(connectCommands(config,{address:null,state:'DISCONNECTED'}),[['connect','10.0.0.2:5555']]);
  assert.deepEqual(connectCommands(config,{address:null,state:'OFFLINE'}),[['disconnect','10.0.0.2:5555'],['connect','10.0.0.2:5555']]);
  assert.equal(connectCommands(config,{address:'10.0.0.2:5555',state:'CONNECTED'}),null);
  assert.equal(connectCommands(config,{address:null,state:'UNAUTHORIZED'}),null,'only the user can authorise');
  assert.equal(connectCommands(parseDeviceConfig(JSON.stringify({version:1,transport:'usb',serial:'ABC',packageName:'com.hypergryph.arknights'})),{address:null,state:'DISCONNECTED'}),null,'USB never connects');
});

test('AdbDeviceAdapter binds a network device and reports its transport', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'maa-tcp-'));
  try {
    const file=path.join(dir,'devices.json');
    await fs.writeFile(file,JSON.stringify({version:2,transport:'tcp',address:'10.0.0.2:5555'}));
    const calls:string[][]=[];
    const adapter=new AdbDeviceAdapter(file,'fake',{run:async(_bin,args)=>{calls.push(args);
      if(args[0]==='devices')return '10.0.0.2:5555 device product:x model:Emu\nABC device usb:1-2\n';
      if(args.includes('get-state'))return 'device\n';
      if(args.includes('sys.boot_completed'))return '1\n';
      return '';}},()=>{throw new Error('USB facts must not be read in tcp mode');});
    assert.equal((await adapter.binding()).address,'10.0.0.2:5555');
    const inspected=await adapter.inspect();
    assert.equal(inspected.transport,'tcp');
    assert.equal(inspected.usb,null);
    assert.equal(inspected.device.connectionType,'tcp');
    assert.deepEqual((await adapter.list()).map(d=>[d.serial,d.selected]),[['10.0.0.2:5555',true]]);
    assert.ok(!calls.some(args=>args[0]==='connect'),'the manager never opens transports');
    assert.equal(UsbDeviceAdapter,AdbDeviceAdapter,'former export name still works');
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
