import {spawn} from 'node:child_process';
import {
  ACCOUNT_IDENTITY_UNVERIFIED_COMPAT_REASON,
  identityBlockReason,
  type AccountIdentityPolicy,
  type IdentityProbe,
  type IdentityStatus,
} from './account-safety';

export interface SequenceOptions {
  /** Injected identity decision; absent means "cannot determine" and is fail-closed. */
  probe?: IdentityProbe;
  target?: {accountName: string};
  /** require-verified (default) or the explicitly configured warn-continue compatibility mode. */
  identityPolicy?: AccountIdentityPolicy;
}

/** How many times StartUp is repeated to read back the current account after a switch attempt. */
export const MAX_IDENTITY_READBACKS = 2;

const ACCOUNT_IDENTITY_CONFIRMED_NOTE = '[ACCOUNT_IDENTITY_CONFIRMED] 账号身份已确认：登录前账号管理页显示的当前账号就是目标账号。';
const ACCOUNT_SWITCH_READBACK_NOTE = '[ACCOUNT_SWITCH_READBACK] 已执行账号切换，重新进入账号管理页核对当前账号。';

/**
 * Run the account-switch invocation, verify identity, and only then run the remaining tasks.
 *
 * `StartUp Completed` proves the task chain finished, and Core's `AccountSwitch` event proves only
 * that it clicked the account (upstream issue #17845, ACCOUNT_SWITCH_UPSTREAM_STATUS.md). So when the
 * probe reports `switched`, StartUp runs again: it returns to the account manager page, where the
 * current account is read back. If the switch did not take effect this also retries it. Account-scoped
 * tasks are only released on `confirmed`. A probe with no evidence stops with exit code 3 (subject to
 * the policy) and an account that cannot be read back, or a different account, stops with exit code 4.
 * Both are recorded as run reasons by the Engine.
 *
 * Child processes inherit the Runner-owned process group, including on stop.
 */
export async function executeSequence(bin:string,args:string[][],onOutput:(chunk:Buffer,stderr:boolean)=>void,options:SequenceOptions={}):Promise<number> {
  let stopping=false;
  const stop=()=>{stopping=true;};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
  const note=(text:string,stderr=true)=>onOutput(Buffer.from(`\n${text}\n`),stderr);
  const invoke=(argv:string[])=>new Promise<{code:number;completed:boolean}>(resolve=>{
    const child=spawn(bin,argv,{stdio:['ignore','pipe','pipe'],shell:false});
    let completed=false,tail=['',''];
    const output=(chunk:Buffer,stderr:boolean)=>{
      const index=stderr?1:0;
      const lines=(tail[index]+chunk.toString('utf8')).split('\n');tail[index]=lines.pop()!.slice(-4096);
      for(const line of lines)if(/\bINFO[^\]]*\]\s+StartUp Completed\s*$/.test(line.replace(/\x1b\[[0-9;]*m/g,'')))completed=true;
      onOutput(chunk,stderr);
    };
    child.stdout.on('data',c=>output(c,false));child.stderr.on('data',c=>output(c,true));
    child.on('error',e=>{onOutput(Buffer.from(`\nCannot start MAA: ${e.message}\n`),true);resolve({code:1,completed:false});});
    child.on('close',code=>resolve({code:code??1,completed}));
  });
  /** One StartUp invocation with its own evidence window; `exit` is set when the sequence must end. */
  const startUp=async():Promise<{exit:number|null;status:IdentityStatus}>=>{
    const probe=options.target?options.probe:undefined;
    await probe?.begin?.();
    const result=await invoke(args[0]);
    if(stopping)return {exit:130,status:'unavailable'};
    if(result.code!==0)return {exit:result.code,status:'unavailable'};
    if(!result.completed){note('Account startup did not report completion; subsequent tasks blocked.');return {exit:1,status:'unavailable'};}
    return {exit:null,status:probe?await probe.confirm(options.target!):'unavailable'};
  };
  try {
    if(stopping)return 130;
    let first=await startUp();
    if(first.exit!==null)return first.exit;
    for(let readback=0;first.status==='switched'&&readback<MAX_IDENTITY_READBACKS;readback++) {
      note(ACCOUNT_SWITCH_READBACK_NOTE,false);
      first=await startUp();
      if(first.exit!==null)return first.exit;
    }
    // Still switching after every read-back: the account never showed as current.
    const status:IdentityStatus=first.status==='switched'?'mismatch':first.status;
    const policy:AccountIdentityPolicy=options.identityPolicy??'require-verified';
    const reason=identityBlockReason(status,policy);
    if(reason){note(reason);return status==='mismatch'?4:3;}
    if(status==='confirmed')note(ACCOUNT_IDENTITY_CONFIRMED_NOTE,false);
    // Compatibility mode: continue, but make the unverified-identity risk explicit in the log.
    else note(ACCOUNT_IDENTITY_UNVERIFIED_COMPAT_REASON);
    for(let i=1;i<args.length;i++) {
      if(stopping)return 130;
      const result=await invoke(args[i]);
      if(stopping)return 130;
      if(result.code!==0)return result.code;
    }
    return 0;
  } finally {process.off('SIGTERM',stop);process.off('SIGINT',stop);}
}
