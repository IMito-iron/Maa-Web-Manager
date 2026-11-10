import {PrismaClient} from '@prisma/client';
import {ArgonPasswordHasher} from './password';
import {credentials} from './service';

async function main() {
  // Password arrives through stdin, never argv, shell history or an image layer.
  let password='';for await(const chunk of process.stdin) {password+=chunk;if(password.length>1024) throw Error('Input too long');}
  password=password.replace(/\r?\n$/,'');
  const username=process.argv[2];credentials(username,password);
  const db=new PrismaClient();
  try {
    const passwordHash=await new ArgonPasswordHasher().hash(password);
    await db.$transaction(async tx=>{
      if(await tx.user.count()) throw Error('Bootstrap is only permitted for an empty user database');
      await tx.user.create({data:{username,passwordHash,role:'admin'}});
    });
    console.log('Administrator created');
  } finally {await db.$disconnect();}
}
void main().catch(e=>{console.error(e.message);process.exitCode=1;});
