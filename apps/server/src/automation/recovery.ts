import {PrismaClient} from '@prisma/client';
export async function recoverExecution(db:PrismaClient) {
  await db.run.updateMany({where:{status:'running'},data:{status:'interrupted',finishedAt:new Date(),reason:'Manager restarted; previous process was terminated',pid:null}});
}
