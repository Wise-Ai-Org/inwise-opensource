const { app, BrowserWindow } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'inwise-voice-ui-'));
app.setPath('userData', scratch); app.setName('Inwise voice UI test');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
process.argv.push('--hidden');
const config = require('../dist/main/config');
config.setConfig({ onboardingComplete: true, apiKey: 'synthetic-test-placeholder', calendarUrls: [], calendarFreeRecording: false });
let fail = true;
const transcript = 'We agreed to review the customer onboarding flow tomorrow. Alex will prepare the draft and share it with the team before the next planning meeting.';
require('../dist/main/transcriber').transcribeAudio = async () => { if(fail) throw new Error('synthetic transcription failure'); return transcript; };
require('../dist/main/extractor').classifyVoiceMemo = async () => [{kind:'note',text:transcript}];
app.on('browser-window-created', (_e, win) => { win.show = () => {}; win.focus = () => {}; });
require('../dist/main/main');
const delay = ms => new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
  const win = BrowserWindow.getAllWindows()[0];
  for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript("!!document.querySelector('.pp-shell')").catch(()=>false)) break; await delay(100);}
  await win.webContents.executeJavaScript("window.dispatchEvent(new CustomEvent('pp-navigate',{detail:{view:'voice-capture'}}))");
  for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript("!!document.querySelector('[aria-label=\"Finish recording\"]:not(:disabled)')")) break;await delay(100);}
  await delay(1400);
  await win.webContents.executeJavaScript("document.querySelector('[aria-label=\"Finish recording\"]').click()");
  for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript("document.body.innerText.includes('Retry processing')"))break;await delay(100);}
  let text=await win.webContents.executeJavaScript('document.body.innerText');
  assert.ok(text.includes('Your audio is saved'),text); assert.ok(text.includes('Export audio'),text);
  const meetings=await require('../dist/main/database').getMeetings();
  assert.equal(meetings.length,1);assert.ok(fs.existsSync(meetings[0].recordingRecovery.audioPath));
  fail=false;
  await win.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(b=>b.textContent==='Retry processing').click()");
  for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript("document.body.innerText.includes('What was said') || document.body.innerText.includes('Add to Inwise') || !!document.querySelector('.vm-review')"))break;await delay(100);}
  text=await win.webContents.executeJavaScript('document.body.innerText');
  const updated=await require('../dist/main/database').getMeetings();
  assert.equal(updated.length,1); assert.equal(updated[0].transcript,transcript);assert.equal(updated[0].recordingFailure,null);
  assert.ok(!text.includes('Transcription failed'),text);
  fs.mkdirSync(path.join(__dirname,'../artifacts'),{recursive:true});
  fs.writeFileSync(path.join(__dirname,'../artifacts/voice-ui-test.json'),JSON.stringify({passed:true,tests:['fake microphone recording','Stop finalizes capture','transcription failure visible with retry and export','retry uses saved recording without re-recording','no duplicate recovery record','transcript recovered']},null,2));
  console.log('Voice UI recovery test passed'); app.exit(0);
}).catch(e=>{console.error(e);app.exit(1)});
