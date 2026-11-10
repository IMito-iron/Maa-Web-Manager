import * as argon2 from 'argon2';

export interface PasswordHasher {
  hash(password:string):Promise<string>;
  verify(hash:string,password:string):Promise<boolean>;
}
export class ArgonPasswordHasher implements PasswordHasher {
  hash(password:string) {return argon2.hash(password,{type:argon2.argon2id,memoryCost:19456,timeCost:2,parallelism:1});}
  verify(hash:string,password:string) {return argon2.verify(hash,password).catch(()=>false);}
}
