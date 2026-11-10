import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { adbDevices, parseDeviceConfig, resolveDevice, usbEntries } from './device-policy';
import { readUsbRecords } from './usb-sysfs';

export interface UsbFacts {present:boolean;adbCapable:boolean;vid:number|null;pid:number|null;authorized:boolean|null}

/** The application can substitute a fake without loading ADB or opening USB. */
export interface DevicePort {
  prepare(address:string): Promise<void>;
  inspect(): Promise<{address:string|null;state:string;reason:string|null;adb:boolean;android:boolean;device:any;usb:UsbFacts|null;transport?:'usb'|'tcp'|null}>;
  binding(): Promise<{address:string|null;state:string;reason:string|null}>;
  list(): Promise<{serial:string;state:string;model:string|null;product:string|null;selected:boolean}[]>;
  /** Foreground package at call time, or null when it cannot be determined. Optional so
   *  minimal fakes used in tests do not have to implement failure diagnostics. */
  foreground?(address:string): Promise<string|null>;
}

const exec = promisify(execFile);
export interface DeviceCommand { run(binary:string,args:string[]):Promise<string>; }
export class ExecDeviceCommand implements DeviceCommand {
  async run(binary:string,args:string[]) {return (await exec(binary,args,{timeout:5000,maxBuffer:2097152})).stdout;}
}

/** The kernel's view of the bus, injected so the adapter stays testable without USB. */
export type UsbRecordReader = () => {vid:number|null;pid:number|null;serial:string|null;authorized:boolean|null;interfaces:{class:number|null;subClass:number|null;protocol:number|null}[]}[];

/**
 * One adapter for both transports in DEVICE_CONFIG: a USB phone (bound by serial) or a network ADB
 * device such as an emulator (bound by its exact "host:port"). The adapter only talks to the ADB
 * server; it never opens transports itself — the device container's supervisor owns `adb connect`.
 */
export class AdbDeviceAdapter implements DevicePort {
  constructor(private configFile:string, private adb:string, private command:DeviceCommand=new ExecDeviceCommand(),
    private usbRecords:UsbRecordReader=readUsbRecords) {}
  private async config() {
    const file=await fs.open(this.configFile,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const stat=await file.stat();
      if(!stat.isFile()||stat.size>16384) throw new Error('Invalid device configuration file');
      return parseDeviceConfig(await file.readFile('utf8'));
    } finally {await file.close();}
  }
  private async serial() {return (await this.config()).serial;}
  private async devices() {return this.command.run(this.adb,['devices','-l']);}
  /** Why the configured phone is or is not reachable, in terms of the USB function it exposes. */
  private async facts():Promise<UsbFacts|null> {
    try {
      const config=await this.config();
      return config.transport==='usb'?usbEntries(this.usbRecords(),config.serial):null;
    }
    catch {return {present:false,adbCapable:false,vid:null,pid:null,authorized:null};}
  }
  async binding() {
    try {const facts=await this.facts();return resolveDevice(await this.devices(),await this.config(),facts);}
    catch {return {address:null,state:'DISCONNECTED',reason:'Device configuration or ADB discovery unavailable'};}
  }
  async prepare(address:string) {
    if((await this.binding()).address!==address)throw new Error('Device changed before wake');
    const run=(args:string[])=>this.command.run(this.adb,['-s',address,'shell',...args]);
    // WAKEUP is idempotent; POWER would toggle an already-awake device off.
    await run(['input','keyevent','224']);
    await run(['wm','dismiss-keyguard']).catch(()=>{});
    for(let attempt=0;attempt<5;attempt++) {
      const [power,policy]=await Promise.all([run(['dumpsys','power']),run(['dumpsys','window','policy'])]);
      const keyguard=/KeyguardServiceDelegate[\s\S]*?\bshowing=(true|false)/.exec(policy);
      if(/mWakefulness=Awake\b/.test(power)&&keyguard?.[1]==='false')return;
      if(keyguard?.[1]==='true'&&/\bsecure=true\b/.test(policy))throw new Error('手机仍有安全锁屏，请在手机上解锁后重试；不会保存或输入锁屏密码');
      await new Promise(r=>setTimeout(r,300));
    }
    throw new Error('无法确认手机已唤醒且解锁，请检查设备屏幕后重试');
  }
  /**
   * Reports which app owns the screen. This is how a run that failed because a device
   * policy or settings screen was left open gets a legible reason instead of eight
   * opaque task errors. Undeterminable output returns null and never blocks a run.
   */
  async foreground(address:string):Promise<string|null> {
    const output=await this.command.run(this.adb,['-s',address,'shell','dumpsys','window']).catch(()=>'');
    const match=/mCurrentFocus=Window\{[^}]*?\s([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\//.exec(output);
    if(match)return match[1];
    const fallback=/mCurrentFocus=Window\{[^}]*?\s([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)[\s}]/.exec(output);
    return fallback?fallback[1]:null;
  }
  async inspect() {
    const facts=await this.facts();
    const binding=await this.binding();
    const transport=await this.config().then(c=>c.transport as 'usb'|'tcp',()=>null);
    if(!binding.address) return {...binding,transport,adb:false,android:false,device:null,usb:facts};
    const address=binding.address;
    const [state,boot]=await Promise.all([
      this.command.run(this.adb,['-s',address,'get-state']).catch(()=>''),
      this.command.run(this.adb,['-s',address,'shell','getprop','sys.boot_completed']).catch(()=>''),
    ]);
    const adb=state.trim()==='device',android=adb&&boot.trim()==='1';
    return {...binding,transport,adb,android,state:android?'CONNECTED':adb?'DETECTED':'DISCONNECTED',
      reason:adb?binding.reason:'Configured ADB transport unavailable',usb:facts,
      device:adb?await this.probeDevice(address,transport??'usb'):null};
  }
  private async probeDevice(address: string, transport: string): Promise<any> {
    const adb = async (args: string[]) => (await this.command.run(this.adb, ['-s', address, ...args])).trim();
    const [model, version, abilist, size, battery] = await Promise.all([
      adb(['shell', 'getprop', 'ro.product.model']).catch(() => null),
      adb(['shell', 'getprop', 'ro.build.version.release']).catch(() => null),
      adb(['shell', 'getprop', 'ro.product.cpu.abilist']).catch(() => null),
      adb(['shell', 'wm', 'size']).catch(() => null),
      adb(['shell', 'dumpsys', 'battery']).catch(() => null),
    ]);
    const level = battery ? battery.match(/level:\s*(\d+)/)?.[1] : null;
    const status = battery ? battery.match(/status:\s*(\d+)/)?.[1] : null;
    const temp = battery ? battery.match(/temperature:\s*(\d+)/)?.[1] : null;
    const statusNames = ['unknown', 'unknown', 'charging', 'discharging', 'not charging', 'full'];
    return {
      serial: address,
      connectionType: transport,
      model: model || null,
      androidVersion: version || null,
      abi: abilist ? abilist.split(',')[0] : null,
      resolution: size ? (size.match(/Override size:\s*(\d+x\d+)/)?.[1] ?? size.match(/(\d+x\d+)/)?.[1] ?? null) : null,
      batteryLevel: level ? Number(level) : null,
      batteryStatus: status ? statusNames[Number(status)] ?? status : null,
      batteryTemp: temp ? Math.round(Number(temp) / 10) : null,
    };
  }
  async list() {
    const config=await this.config().catch(()=>null);
    return adbDevices(await this.devices()).filter(d=>!config||d.transport===config.transport)
      .map(({transport:_transport,...d})=>({...d,selected:d.serial===config?.serial}));
  }
}

/** @deprecated Former name from the USB-only releases; kept so existing imports keep working. */
export const UsbDeviceAdapter = AdbDeviceAdapter;
