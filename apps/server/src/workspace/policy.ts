import {createHash} from 'node:crypto';
export class WorkspaceError extends Error {
  constructor(message:string,public status=400){super(message);}
}
export const versionOf=(raw:string)=>createHash('sha256').update(raw).digest('hex');
export function label(value:unknown):string {
  if(typeof value!=='string'||!value.trim()||value.length>100)throw new WorkspaceError('Name must be 1–100 characters');
  return value.trim();
}
/** Members cannot supply raw MaaCore/CLI tasks or account-switch instructions. */
export function fightTask(input:unknown):string {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new WorkspaceError('Expected fight settings');
  const data=input as Record<string,unknown>;
  if(Object.keys(data).some(k=>!['stage','times'].includes(k)))throw new WorkspaceError('Unsupported task parameter');
  if(typeof data.stage!=='string'||! /^[A-Za-z0-9@_-]{1,64}$/.test(data.stage))throw new WorkspaceError('Invalid stage');
  if(!Number.isInteger(data.times)||Number(data.times)<1||Number(data.times)>100)throw new WorkspaceError('Times must be 1–100');
  return JSON.stringify({type:'Fight',params:{stage:data.stage,times:data.times,medicine:0,stone:0}});
}
