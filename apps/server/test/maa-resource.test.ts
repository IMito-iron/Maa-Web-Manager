import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {install}=require('../../../scripts/install-maa-resource.cjs');
test('resource installation is idempotent and preserves unrelated profile and resources',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'maa-resource-'));
  try {
    fs.mkdirSync(path.join(root,'profiles'));
    fs.writeFileSync(path.join(root,'profiles/default.json'),JSON.stringify({connection:{preset:'ADB'},unknown:42,resource:{global_resource:'x'}}));
    const source=path.resolve('../../config/maa-resource/tasks/manager.json');
    install(root,source);const before=fs.readFileSync(path.join(root,'profiles/default.json'),'utf8');install(root,source);
    assert.equal(fs.readFileSync(path.join(root,'profiles/default.json'),'utf8'),before);
    assert.deepEqual(JSON.parse(before),{connection:{preset:'ADB'},unknown:42,resource:{global_resource:'x',user_resource:true}});
    const patch=JSON.parse(fs.readFileSync(source,'utf8'));
    assert.ok(patch.Annihilation.next.includes('ManagerAnnihilationUsePrtsCheck'));
    assert.equal(patch.ManagerAnnihilationUsePrtsCheck.action,'DoNothing');
    assert.deepEqual(patch.ManagerAnnihilationUsePrtsCheck.next,[]);
    assert.ok(patch.ManagerReturnHome.next.includes('(Home)@QuickSwitch@ToHome#next'));
    assert.ok(!patch.ManagerReturnHome.next.includes('StartUpBegin'));
    // Backport of upstream MAA da56bac7 (#19179, first in v6.22.0-beta.2): the terminal bottom bar
    // shifted once Garrison Protocol became permanent; bundled MaaCore 6.21.4 still has the old ROIs.
    // Only the ROI is overridden — the rest of each task comes from the bundled resource.
    assert.deepEqual(patch.StageResource,{roi:[400,600,202,120]});
    assert.deepEqual(patch.GoTerminalStopflag,{roi:[400,600,202,120]});
    assert.deepEqual(patch['Roguelike@IntegratedStrategies'],{roi:[760,606,270,114]});
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
