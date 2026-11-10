import fs from 'node:fs';
import {executeSequence} from './sequence';
import {parseAccountIdentityPolicy} from './account-safety';
import {CoreLogIdentityProbe, coreLogPath} from './core-log-identity-probe';
const [bin,address,...files]=process.argv.slice(2);
if(!bin||!address||!files.length||files.length>2)process.exit(1);
// The target account is the stored input of the first (StartUp) document, never a claim that it is
// the account that is logged in; the probe establishes that from Core's own log.
let accountName: string | undefined;
try {
  const first=JSON.parse(fs.readFileSync(files[0],'utf8'));
  const value=first?.tasks?.[0]?.params?.account_name;
  if(typeof value==='string'&&value.trim())accountName=value.trim();
} catch { accountName=undefined; }
const probe=new CoreLogIdentityProbe(coreLogPath());
// -vvv only when the Manager needs Mall callbacks (MAA_MANAGER_VERBOSITY); anything else → -v.
const verbosity=process.env.MAA_MANAGER_VERBOSITY==='-vvv'?'-vvv':'-v';
// The same explicit environment policy the Manager records on the run; absent means fail-closed.
const identityPolicy=parseAccountIdentityPolicy(process.env.ACCOUNT_IDENTITY_POLICY);
void executeSequence(bin,files.map(file=>['run',file,'--addr',address,'--batch',verbosity]),(chunk,stderr)=>(stderr?process.stderr:process.stdout).write(chunk),
  accountName?{probe,target:{accountName},identityPolicy}:{}).then(code=>{process.exitCode=code;}).catch(()=>{process.exitCode=1;});
