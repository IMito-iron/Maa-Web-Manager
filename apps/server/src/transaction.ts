import {PrismaClient,Prisma} from '@prisma/client';
const chains=new WeakMap<PrismaClient,Promise<unknown>>();
/** Serialize read/check/write transactions per database in this single-writer service. */
export function serialTransaction<T>(db:PrismaClient,action:(tx:Prisma.TransactionClient)=>Promise<T>):Promise<T> {
  const result=(chains.get(db)||Promise.resolve()).then(()=>db.$transaction(action));
  chains.set(db,result.catch(()=>{}));return result;
}
