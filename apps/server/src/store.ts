import { Injectable, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cfg } from './config';
import { hash, nameOf, parseTask } from './domain';

@Injectable()
export class Store {
  db = new PrismaClient();
  private chain: Promise<unknown> = Promise.resolve();
  // Serialize file mutations, enqueue operations and dispatch decisions in one process.
  serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.chain.then(action); this.chain = result.catch(() => {}); return result;
  }
  async init() {
    await fs.mkdir(cfg.tasks, {recursive:true}); await fs.mkdir(path.join(cfg.data, 'logs'), {recursive:true});
    if ((await fs.lstat(cfg.tasks)).isSymbolicLink()) throw new Error('Task directory cannot be a symlink');
    await this.db.$queryRawUnsafe('PRAGMA journal_mode=WAL');
    await this.db.$queryRawUnsafe('PRAGMA busy_timeout=5000');
  }
  file(name: string) { return path.join(cfg.tasks, `${nameOf(name)}.json`); }
  private displayNameOf(raw: string, fallback: string): string {
    try { const d = JSON.parse(raw); return typeof d?.name === 'string' && d.name ? d.name : fallback; }
    catch { return fallback; }
  }
  async read(name: string) {
    const file = this.file(name);
    let handle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = await handle.stat();
      if (!st.isFile() || st.size > 1024*1024) throw new BadRequestException('Not a regular task file or exceeds 1 MiB');
      const raw = await handle.readFile('utf8'); return { name, raw, version: hash(raw), displayName: this.displayNameOf(raw, name) };
    } catch (e: any) {
      if (e.code === 'ENOENT') throw new NotFoundException('Task not found');
      if (e.code === 'ELOOP') throw new BadRequestException('Symlinks are forbidden');
      throw e;
    } finally { await handle?.close(); }
  }
  async list() {
    const files = await fs.readdir(cfg.tasks, {withFileTypes:true});
    const items = files.filter(f=>f.isFile() && /\.(json|toml|ya?ml)$/.test(f.name));
    return Promise.all(items.map(async f=>{
      const name=f.name.replace(/\.[^.]+$/,'');
      const editable=f.name.endsWith('.json') && /^[a-zA-Z0-9_-]+\.json$/.test(f.name);
      let displayName=name;
      if(editable){ try{ displayName=(await this.read(name)).displayName; }catch{} }
      return { name, file:f.name, editable, displayName };
    }));
  }
  async ensureIdle(name: string) {
    if (await this.db.run.count({where:{task:name,status:{in:['queued','running']}}})) throw new ConflictException('Task is queued or running');
  }
  async save(name: string, raw: string, version?: string, create = false) {
    return this.serial(async()=> {
      nameOf(name); parseTask(raw); await this.ensureIdle(name);
      const file = this.file(name);
      if (create) {
        for (const ext of ['json','toml','yaml','yml']) {
          try { await fs.lstat(path.join(cfg.tasks, `${name}.${ext}`)); } catch(e:any) { if(e.code==='ENOENT') continue; throw e; }
          throw new ConflictException('Task name already exists');
        }
      } else if ((await this.read(name)).version !== version) throw new ConflictException('Configuration changed; reload before saving');
      const temp = path.join(cfg.tasks, `.${randomUUID()}.tmp`);
      try {
        const h = await fs.open(temp, 'wx', 0o600); try { await h.writeFile(raw); await h.sync(); } finally { await h.close(); }
        if (create) { await fs.link(temp,file); await fs.unlink(temp); } else { await fs.rename(temp,file); }
      } finally { await fs.rm(temp,{force:true}); }
      return this.read(name);
    });
  }
  async remove(name: string, version: string) {
    return this.serial(async()=> {
      await this.ensureIdle(name);
      if(await this.db.schedule.count({where:{task:name}})) throw new ConflictException('Remove schedules referencing this task first');
      if((await this.read(name)).version!==version) throw new ConflictException('Configuration changed');
      await fs.unlink(this.file(name)); return {ok:true};
    });
  }
}
