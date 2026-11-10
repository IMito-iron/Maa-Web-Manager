import {ConflictException, ForbiddenException, BadRequestException} from '@nestjs/common';
import {createHash} from 'node:crypto';

/** Owned by the Runner; all mutations run under the same lock as dispatch. */
/**
 * A control session must survive a pause in the heartbeat — a viewer watching the game may not
 * move the pointer for minutes, and browsers throttle timers in background tabs — but a session
 * nobody is attending must not hold the device (and block dispatch) indefinitely. Hence a generous
 * idle window, an absolute deadline per grant, and renewal on an explicit re-request.
 */
const IDLE_MS = 5 * 60_000;
const SESSION_MS = 30 * 60_000;

export class DeviceControl {
  private lease?: {digest:string; expiresAt:number; seenAt:number};
  private drainUntil=0;
  constructor(private now:()=>number=Date.now) {}
  private digest(token:unknown) {
    if(typeof token!=='string'||! /^[a-f0-9]{64}$/.test(token)) throw new BadRequestException('Invalid control credential');
    return createHash('sha256').update(token).digest('hex');
  }
  private current() {
    if(this.lease&&(this.now()>=this.lease.expiresAt||this.now()-this.lease.seenAt>=IDLE_MS)){this.lease=undefined;this.drainUntil=this.now()+4000;}
    return this.lease;
  }
  get held(){return !!this.current()||this.now()<this.drainUntil;}
  status(token?:string) {
    const lease=this.current();
    return {held:!!lease,owned:!!lease&&!!token&&lease.digest===this.digest(token),expiresAt:lease?new Date(lease.expiresAt).toISOString():null};
  }
  grant(token:string,running:boolean) {
    const digest=this.digest(token);
    if(running)throw new ConflictException('自动任务正在运行，请先停止任务再取得控制');
    const lease=this.current();
    if(this.now()<this.drainUntil)throw new ConflictException('正在关闭上一控制连接，请稍后重试');
    if(lease&&lease.digest!==digest)throw new ConflictException('另一浏览器正在控制设备');
    // The same owner asking again renews its session instead of being told it already holds it.
    this.lease={digest,expiresAt:this.now()+SESSION_MS,seenAt:this.now()};
    return this.status(token);
  }
  touch(token:string) {
    const lease=this.current();
    if(!lease||lease.digest!==this.digest(token))throw new ForbiddenException('控制已释放或过期');
    lease.seenAt=this.now();return this.status(token);
  }
  release(token:string) {
    if(this.current()&&this.lease!.digest!==this.digest(token))throw new ForbiddenException('另一浏览器正在控制设备');
    if(this.lease)this.drainUntil=this.now()+4000;
    this.lease=undefined;return this.status();
  }
}
