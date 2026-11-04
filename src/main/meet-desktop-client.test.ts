import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readMeetDesktopClient } from './meet-desktop-client';
export async function run() {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'inwise-client-')); const file=path.join(dir,'client.json');
 try {
  assert.equal(readMeetDesktopClient(file),null);
  fs.writeFileSync(file,'invalid'); assert.equal(readMeetDesktopClient(file),null);
  fs.writeFileSync(file,JSON.stringify({clientId:'example.apps.googleusercontent.com',clientSecret:'desktop-value',accessToken:'never-return'}));
  assert.deepEqual(readMeetDesktopClient(file),{clientId:'example.apps.googleusercontent.com',clientSecret:'desktop-value'});
  fs.writeFileSync(file,JSON.stringify({clientId:'wrong-host',clientSecret:'x'})); assert.equal(readMeetDesktopClient(file),null);
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
 console.log('meet-desktop-client: all tests passed');
}
if(require.main===module) run().catch(e=>{console.error(e);process.exit(1)});
