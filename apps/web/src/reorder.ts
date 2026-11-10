/** Move by index without mutating the task objects or their unknown JSON fields. */
export function reorder<T>(items:T[],from:number,to:number,selected:number) {
  if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||from>=items.length||to<0||to>=items.length||from===to)return {items,selected};
  const next=items.slice(),[item]=next.splice(from,1);next.splice(to,0,item);
  const index=selected===from?to:from<selected&&to>=selected?selected-1:from>selected&&to<=selected?selected+1:selected;
  return {items:next,selected:index};
}
