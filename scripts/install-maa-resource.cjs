// Versioned overrides for the bundled MaaCore (6.21.4; terminal-bar ROIs backported from 6.22.0-beta.2); preserve unrelated user resources.
const fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto');
function install(root,source) {
  const directory=p=>{fs.mkdirSync(p,{recursive:true});if(!fs.lstatSync(p).isDirectory()||fs.lstatSync(p).isSymbolicLink())throw Error('Unsafe resource directory');};
  const save=(file,value)=>{if(fs.existsSync(file)&&(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()))throw Error('Unsafe resource file');const temp=file+'.'+randomUUID()+'.tmp';const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,value);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}try{fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}};
  directory(root);directory(path.join(root,'resource'));directory(path.join(root,'resource','tasks'));directory(path.join(root,'profiles'));
  const profile=path.join(root,'profiles','default.json');
  if(fs.lstatSync(profile).isSymbolicLink())throw Error('Unsafe profile');
  const value=JSON.parse(fs.readFileSync(profile,'utf8'));
  value.resource={...value.resource,user_resource:true};
  save(path.join(root,'resource','tasks','manager.json'),fs.readFileSync(source));
  save(profile,JSON.stringify(value,null,2)+'\n');
}
module.exports={install};
if(require.main===module)install('/config','/app/config/maa-resource/tasks/manager.json');
