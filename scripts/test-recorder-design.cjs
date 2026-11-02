const {app,BrowserWindow}=require('electron');
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
app.disableHardwareAcceleration();const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'inwise-recorder-design-'));app.setPath('userData',scratch);
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const preload=path.join(scratch,'fixture.cjs');
 fs.writeFileSync(preload,`window.callbacks={};window.expanded=false;
window.inwiseAPI=new Proxy({on:(c,f)=>window.callbacks[c]=f,getConfig:async()=>({}),getDesktopSourceId:async()=>'fixture',getMediaPermissions:async()=>({microphone:'granted',screen:'granted'}),resizePill:()=>{},showMainWindow:()=>{window.expanded=true}},{get:(o,k)=>o[k]||(()=>{})});
window.electronAPI={sendAudio:()=>{},sendAudioHealth:()=>{},reportUnhandledRejection:()=>{}};window.fixtureGains=[];
async function fakeStream(){const c=new AudioContext();await c.resume();const o=c.createOscillator(),g=c.createGain(),d=c.createMediaStreamDestination();window.fixtureGains.push(g);o.frequency.value=180;g.gain.value=.08;o.connect(g);g.connect(d);o.start();return d.stream;}
Object.defineProperty(navigator.mediaDevices,'enumerateDevices',{value:async()=>[{kind:'audioinput',deviceId:'default',label:'Synthetic microphone',groupId:'fixture'},{kind:'audiooutput',deviceId:'default',label:'Synthetic speaker',groupId:'fixture'}]});
Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:fakeStream});Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{value:fakeStream});`);
 const win=new BrowserWindow({width:560,height:100,show:false,frame:false,transparent:true,webPreferences:{preload,contextIsolation:false,offscreen:true,backgroundThrottling:false}});
 win.webContents.setAudioMuted(true);const js=s=>win.webContents.executeJavaScript(s);
 const out=path.resolve(__dirname,'../artifacts/owl-design');fs.mkdirSync(out,{recursive:true});
 const snap=async name=>fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());
 await win.loadFile(path.resolve(__dirname,'../dist/renderer/badge.html'));await wait(250);await snap('recorder-idle');
 await js("window.callbacks['recording:start']('Launch readiness sync')");
 for(let i=0;i<120;i++){if(await js("[...document.querySelectorAll('div')].some(e=>e.style.getPropertyValue('--glow-left-y'))"))break;await wait(200);}
 await snap('recorder-recording');
 const state=await js(`(()=>{const el=[...document.querySelectorAll('div')].find(e=>e.style.getPropertyValue('--glow-left-y'));return {glow:!!el,background:el?.style.background,border:el&&getComputedStyle(el).borderTopStyle,shadow:el&&getComputedStyle(el).boxShadow,text:document.body.innerText}})()`);
 assert.ok(state.glow,'audio still drives the soft glow');assert.ok(state.background.includes('255, 255, 255')||state.background.includes('#ffffff'),'white recorder surface');assert.equal(state.border,'none');assert.equal(state.shadow,'none');
 await js("window.fixtureGains.forEach(g=>g.gain.value=0)");await wait(300);
 await js("window.callbacks['recording:silence-prompt']({title:'Launch readiness sync',deadlineAt:Date.now()+120000})");await wait(200);await snap('recorder-silence-prompt');
 assert.ok(await js("document.body.innerText.includes('Keep recording')"),'silence action remains present');
 console.log('Recorder design checks passed: idle, recording, live glow, borderless white surface, two-minute silence prompt.');app.exit(0);
}).catch(e=>{console.error(e);app.exit(1)});
