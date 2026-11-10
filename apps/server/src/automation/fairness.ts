/** Stable owner round-robin, FIFO within each owner. Call with eligible runs only. */
export function fairNext<T extends {id:string;ownerId:string|null;createdAt:Date}>(runs:T[],lastOwner:string|null):T|undefined {
  const heads=new Map<string,T>();
  for(const run of [...runs].sort((a,b)=>a.createdAt.getTime()-b.createdAt.getTime()||a.id.localeCompare(b.id))) {
    const owner=run.ownerId??'';if(!heads.has(owner))heads.set(owner,run);
  }
  const owners=[...heads.keys()].sort();
  const next=lastOwner===null?owners[0]:owners.find(o=>o>lastOwner)??owners[0];
  return next===undefined?undefined:heads.get(next);
}
