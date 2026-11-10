import test from 'node:test';
import assert from 'node:assert/strict';
import {AuthService,AuthRepository,AuthSession,credentials,tokenDigest} from '../src/auth/service';
import {ArgonPasswordHasher} from '../src/auth/password';

class MemoryAuth implements AuthRepository {
  user={id:'1',username:'alice',role:'member',disabled:false,passwordHash:'hash:password12345'};
  sessions=new Map<string,AuthSession>();
  async findUser(username:string){return username===this.user.username?this.user:null;}
  async session(digest:string){return this.sessions.get(digest)||null;}
  async createSession(data:any){this.sessions.set(data.digest,{...data,user:this.user});}
  async touch(digest:string,now:Date){this.sessions.get(digest)!.lastSeenAt=now;}
  async revoke(digest:string){this.sessions.delete(digest);}
  async revokeUser(_id:string){this.sessions.clear();}
}
const passwords={hash:async(p:string)=>'hash:'+p,verify:async(h:string,p:string)=>h==='hash:'+p};
test('session tokens are digested, expire idle, and revoke immediately',async()=>{
  const repo=new MemoryAuth();let now=new Date('2026-10-11T00:00:00Z');
  const auth=new AuthService(repo,passwords,()=>now);await auth.init();
  const s=await auth.login('alice','password12345');
  assert.equal(repo.sessions.has(s.token),false);assert.equal(repo.sessions.has(tokenDigest(s.token)),true);
  assert.ok(await auth.authenticate(s.token));
  now=new Date(now.getTime()+30*60000);assert.equal(await auth.authenticate(s.token),null);
  const second=await auth.login('alice','password12345');await auth.logout(second.token);assert.equal(await auth.authenticate(second.token),null);
});
test('disabled users and incorrect credentials fail closed',async()=>{
  const repo=new MemoryAuth(),auth=new AuthService(repo,passwords);await auth.init();
  await assert.rejects(auth.login('nobody','password12345'),/Invalid credentials/);
  await assert.rejects(auth.login('alice','wrong'),/Invalid credentials/);
  const s=await auth.login('alice','password12345');repo.user.disabled=true;
  assert.equal(await auth.authenticate(s.token),null);
  await assert.rejects(auth.login('alice','password12345'),/Invalid credentials/);
});
test('absolute expiration is enforced independently of activity',async()=>{
  const repo=new MemoryAuth(),auth=new AuthService(repo,passwords);await auth.init();
  const session=await auth.login('alice','password12345');
  repo.sessions.get(tokenDigest(session.token))!.expiresAt=new Date(Date.now()-1);
  assert.equal(await auth.authenticate(session.token),null);
});
test('password policy and real Argon2id adapter contract',async()=>{
  assert.throws(()=>credentials('alice','short'));
  const p=new ArgonPasswordHasher(),hash=await p.hash('a-long-password123');
  assert.match(hash,/^\$argon2id\$/);assert.equal(await p.verify(hash,'a-long-password123'),true);assert.equal(await p.verify(hash,'wrong'),false);
});
