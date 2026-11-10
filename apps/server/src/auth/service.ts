import {createHash,randomBytes} from 'node:crypto';
import {PasswordHasher} from './password';

export type Identity={id:string;username:string;role:string;disabled:boolean};
export type AuthSession={digest:string;csrf:string;user:Identity;expiresAt:Date;lastSeenAt:Date};
export interface AuthRepository {
  findUser(username:string):Promise<(Identity&{passwordHash:string})|null>;
  session(digest:string):Promise<AuthSession|null>;
  createSession(data:{digest:string;csrf:string;userId:string;expiresAt:Date;lastSeenAt:Date}):Promise<void>;
  touch(digest:string,now:Date):Promise<void>;
  revoke(digest:string):Promise<void>;
  revokeUser(id:string):Promise<void>;
}
export class AuthError extends Error {}
export const tokenDigest=(token:string)=>createHash('sha256').update(token).digest('hex');
export function credentials(username:unknown,password:unknown):asserts password is string {
  if(typeof username!=='string'||!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(username)||typeof password!=='string'||password.length<12||password.length>128) throw new AuthError('Username must be 3–32 lowercase characters; password must be 12–128 characters');
}
export class AuthService {
  private dummy='';
  constructor(private repo:AuthRepository,private passwords:PasswordHasher,private now=()=>new Date()) {}
  async init() {this.dummy=await this.passwords.hash(randomBytes(32).toString('hex'));}
  async login(username:unknown,password:unknown) {
    if(typeof username!=='string'||typeof password!=='string'||username.length>32||password.length>128) throw new AuthError('Invalid credentials');
    const user=await this.repo.findUser(username);
    const valid=await this.passwords.verify(user?.passwordHash??this.dummy,password);
    if(!user||user.disabled||!valid) throw new AuthError('Invalid credentials');
    const token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex'),now=this.now();
    await this.repo.createSession({digest:tokenDigest(token),csrf,userId:user.id,expiresAt:new Date(now.getTime()+12*3600000),lastSeenAt:now});
    return {token,csrf,user:{id:user.id,username:user.username,role:user.role}};
  }
  async authenticate(token:string|undefined,touch=true):Promise<AuthSession|null> {
    if(!token||! /^[a-f0-9]{64}$/.test(token)) return null;
    const session=await this.repo.session(tokenDigest(token));
    const now=this.now();
    if(!session) return null;
    if(session.user.disabled||session.expiresAt<=now||now.getTime()-session.lastSeenAt.getTime()>=30*60000) {
      await this.repo.revoke(session.digest);return null;
    }
    if(touch&&now.getTime()-session.lastSeenAt.getTime()>60000) await this.repo.touch(session.digest,now);
    return session;
  }
  async logout(token:string) {await this.repo.revoke(tokenDigest(token));}
}
