import test from 'node:test';
import assert from 'node:assert/strict';
import {reorder} from './reorder';
import {vncUrl} from './vncUrl';
test('noVNC WebSocket path resolves at the site root, not under /vnc twice',()=>{
  const page=new URL(vncUrl,'https://maa.test');
  assert.equal(new URL(page.searchParams.get('path')!,page).pathname,'/vnc/websockify');
});
test('reordering preserves selected task identity, variants and unknown fields',()=>{
  const items=[{type:'A',future:1},{type:'B',variants:[{x:1}]},{type:'C'}];
  for(let from=0;from<3;from++)for(let to=0;to<3;to++)for(let selected=0;selected<3;selected++){
    const result=reorder(items,from,to,selected);assert.equal(result.items[result.selected],items[selected]);assert.equal(result.items[to],items[from]);assert.equal(items[0].type,'A');
  }
  assert.equal(reorder(items,-1,0,1).items,items);
});
