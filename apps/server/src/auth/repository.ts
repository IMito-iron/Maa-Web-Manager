import {PrismaClient} from '@prisma/client';
import {AuthRepository} from './service';
export class PrismaAuthRepository implements AuthRepository {
  constructor(private db:PrismaClient) {}
  findUser(username:string) {return this.db.user.findUnique({where:{username}});}
  session(digest:string) {return this.db.session.findUnique({where:{digest},include:{user:{select:{id:true,username:true,role:true,disabled:true}}}});}
  async createSession(data:Parameters<AuthRepository['createSession']>[0]) {
    await this.db.$transaction(async tx=>{
      await tx.session.deleteMany({where:{OR:[{expiresAt:{lte:new Date()}},{lastSeenAt:{lt:new Date(Date.now()-30*60000)}}]}});
      const sessions=await tx.session.findMany({where:{userId:data.userId},orderBy:{createdAt:'desc'},skip:9,select:{digest:true}});
      await tx.session.deleteMany({where:{digest:{in:sessions.map(s=>s.digest)}}});
      await tx.session.create({data});
    });
  }
  async touch(digest:string,now:Date) {await this.db.session.updateMany({where:{digest},data:{lastSeenAt:now}});}
  async revoke(digest:string) {await this.db.session.deleteMany({where:{digest}});}
  async revokeUser(userId:string) {await this.db.session.deleteMany({where:{userId}});}
}
