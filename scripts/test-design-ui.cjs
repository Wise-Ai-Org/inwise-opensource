// Actual built renderer + real IPC and isolated synthetic data. Never opens user data.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
app.disableHardwareAcceleration();app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'inwise-owl-')));
app.setName('Inwise design QA');process.argv.push('--hidden');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
const config=require('../dist/main/config');
config.setConfig({onboardingComplete:true,apiKey:'synthetic-test-placeholder',mcpEnabled:false,calendarFreeRecording:false,calendarUrls:[],userName:'Alex'});
app.on('browser-window-created',(_e,w)=>{w.show=()=>{};w.focus=()=>{};});
require('../dist/main/main');
const delay=ms=>new Promise(r=>setTimeout(r,ms)),out=path.resolve(__dirname,'../artifacts/owl-design');
const capture=async win=>{for(let n=0;n<3;n++){try{return (await win.webContents.capturePage()).toPNG()}catch(e){if(!String(e).includes('UnknownVizError')||n===2)throw e;await delay(250);}}};
fs.mkdirSync(out,{recursive:true});const results=[],errors=[];
app.whenReady().then(async()=>{
 const db=require('../dist/main/database');
 const meetingId=await db.createMeeting({title:'Launch readiness sync',date:new Date().toISOString(),attendees:['Alex','Jordan Lee'],duration:25});
 await db.updateMeetingTranscript(meetingId,'Alex: We agreed to share the onboarding draft tomorrow. Jordan Lee: I will review the first version.',25);
 await db.saveInsights(meetingId,{summary:'The team agreed on the next onboarding improvements and a first review tomorrow.',actionItems:[{text:'Share the onboarding draft',owner:'Alex',priority:'high'}],decisions:[{text:'Review the first version tomorrow'}],blockers:[]});
 const inviteDoc=await db.createTask({title:'Prepare the pilot invite list',owner:'Alex',priority:'high',meetingId,skipDedup:true});
 const jordan=await db.addPerson({firstName:'Jordan',lastName:'Lee',notes:'Product team'});
 // Ollie moments fixtures (docs/OLLIE_MOMENTS.md): synthetic meetings for the inline recap and the failure card.
 const idOf=x=>typeof x==='string'?x:(x&&(x._id||x.id));const personId=idOf(jordan),inviteTask=idOf(inviteDoc);
 const minsAgo=n=>new Date(Date.now()-n*60000).toISOString(),dayKey=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
 const pilotId=await db.createMeeting({title:'Pilot planning',date:minsAgo(3),attendees:['Alex','Jordan Lee'],duration:1500});
 await db.updateMeetingTranscript(pilotId,'Alex: Let us pick the pilot customers. Jordan Lee: I will draft the survey.',1500,{ok:false,reasons:['Long silence on the system audio around minute 12']});
 await db.saveInsights(pilotId,{summary:'Picked the pilot customers.',actionItems:[{text:'Draft the pilot survey',owner:'Jordan Lee'}],decisions:[{text:'Start the pilot with three customers'}],blockers:[]});
 const surveyTask=idOf(await db.createTask({title:'Book the pilot customer calls',owner:'Jordan Lee',priority:'medium',meetingId:pilotId,skipDedup:true}));
 await db.updateTask(surveyTask,{approval:{status:'pending'}});
 const failedId=await db.createMeeting({title:'Customer call (saved audio)',date:minsAgo(2),attendees:['Alex'],duration:900});
 await db.setRecordingRecovery(failedId,{audioPath:path.join(app.getPath('userData'),'qa-missing-audio.webm'),stereo:false,attendees:['Alex'],format:'webm',durationSec:900});
 await db.setRecordingFailure(failedId,{stage:'transcribing',message:'Transcription failed.',audioSaved:true});await db.updateMeetingStatus(failedId,'error');
 // Moment cards are time-driven; these forced payloads (real seeded ids) override only ollie:getMoment / ollie:catchUpNotes in this QA process.
 const ollie=require('../dist/main/ollie-moments-service'),forced={moment:null,catchUp:null};
 ipcMain.removeHandler('ollie:getMoment');ipcMain.handle('ollie:getMoment',async()=>forced.moment||ollie.getOllieMoment());
 ipcMain.removeHandler('ollie:catchUpNotes');ipcMain.handle('ollie:catchUpNotes',async()=>forced.catchUp||ollie.getCatchUpNotes());
 const now=new Date(),tomorrowAt=(h,m)=>{const d=new Date(now);d.setDate(d.getDate()+1);d.setHours(h,m,0,0);return d.getTime()},yesterday=dayKey(new Date(Date.now()-86400000));
 const inviteRef={taskId:inviteTask,title:'Prepare the pilot invite list',dueDate:yesterday,daysLate:1};
 const surveyRef={taskId:surveyTask,title:'Book the pilot customer calls',dueDate:null,daysLate:null};
 const approval={id:'qa-approval',operation:'create',summary:'Create story: Pilot invite list',issueKey:null,meetingId,meetingTitle:'Launch readiness sync',createdAt:now.toISOString()};
 const moments={
  morning:{kind:'morning',key:'morning:'+dayKey(now),generatedAt:Date.now(),morning:{firstName:'Alex',meetingCount:3,priorityCount:2,overduePromiseCount:1,
   topPriorities:[{...inviteRef,rank:1,score:82,sourceMeetingId:meetingId,sourceMeetingTitle:'Launch readiness sync'},{...surveyRef,dueDate:dayKey(now),rank:2,score:64,sourceMeetingId:pilotId,sourceMeetingTitle:'Pilot planning'}],
   doneSinceYesterday:[{taskId:surveyTask,title:'Share the onboarding draft',dueDate:null,daysLate:null}],
   catchUp:[{personId,name:'Jordan Lee',daysSinceMet:24,weeksSinceMet:3,waitingOn:'the onboarding draft',waitingCount:1}],welcomeBack:null}},
  prep:{kind:'prep',key:'prep:qa-event',generatedAt:Date.now(),prep:{eventId:'qa-event',title:'Pilot kickoff with Jordan',startTime:Date.now()+8*60000,endTime:Date.now()+38*60000,minutesUntil:8,attendees:['Jordan Lee'],
   lastMet:{meetingId,title:'Launch readiness sync',date:now.toISOString()},draftAgenda:['Confirm the pilot invite list','Review the first onboarding version','Pick the first pilot date'],
   owes:[{name:'Jordan Lee',personId,owesYou:[{kind:'commitment',taskId:null,meetingId,text:'Review the first onboarding version',dueDate:yesterday,daysLate:2}],youOwe:[{kind:'task',taskId:inviteTask,meetingId,text:'Prepare the pilot invite list',dueDate:yesterday,daysLate:1}]}],
   pendingApprovals:[approval],recordArmed:false}},
  wrap:{kind:'wrap',key:'wrap:'+dayKey(now),generatedAt:Date.now(),wrapUp:{firstName:'Alex',today:{meetingCount:3,tasksFound:2,decisions:2},
   tomorrow:{firstMeeting:{eventId:'qa-event-2',title:'Pilot kickoff with Jordan',startTime:tomorrowAt(9,30),agendaDrafted:true,tasksDueBefore:[inviteRef]},overdueWithAttendees:[{...inviteRef,attendee:'Jordan Lee'}],
    crunch:{from:tomorrowAt(10,0),to:tomorrowAt(16,0),topOverdue:inviteRef},cancelledToday:[]},
   goneQuiet:[{...surveyRef,score:72,commitmentToOther:true,lastActivityAt:new Date(Date.now()-9*86400000).toISOString()}],
   slackToday:[{channelId:'unknown',threadCount:2,taskCount:1,decisionCount:0}],snoozedToday:[{taskId:inviteTask,title:'Update the beta FAQ',dueDate:null,daysLate:null}],receipts:[],
   needsRetry:[{meetingId:failedId,title:'Customer call (saved audio)',date:now.toISOString(),message:'Transcription failed.'}],slackSyncedAt:Date.now()-12*60000}},
 };
 const win=new BrowserWindow({width:380,height:720,show:false,frame:false,webPreferences:{preload:path.resolve(__dirname,'../dist/main/preload.js'),contextIsolation:true,offscreen:true,backgroundThrottling:false}});
 win.webContents.on('console-message',(_e,...a)=>{const t=a.join(' ');if(/Uncaught|The above error occurred/.test(t))errors.push(t)});
 const js=s=>win.webContents.executeJavaScript(s);
 const nav=async view=>{await js("document.querySelector('.pp-menu-backdrop')?.click()");await js(`window.dispatchEvent(new CustomEvent('pp-navigate',{detail:{view:${JSON.stringify(view)}}}))`);await delay(250)};
 const click=async(text,selector='button')=>{const found=await js(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.textContent.trim().includes(${JSON.stringify(text)}));if(!b)return false;b.click();return true})()`);assert.ok(found,'control exists: '+text);await delay(250)};
 const snap=async name=>{
  await delay(100);
  const state=await js(`(()=>{const b=getComputedStyle(document.body);return {background:b.backgroundColor,text:b.color,overflow:document.documentElement.scrollWidth>innerWidth,visible:document.body.innerText}})()`);
  assert.equal(state.background,'rgb(255, 255, 255)',name+' white canvas');assert.equal(state.overflow,false,name+' fits width');assert.ok(!state.visible.includes('Something went wrong'),name+' no crash');
  if(name==='review-priorities'){
   const geometry=await js("(()=>{const r=document.querySelector('.pp-root'),h=document.querySelector('.pp-drillhead');return {rootScroll:r.scrollTop,headingTop:h.getBoundingClientRect().top,headingBottom:h.getBoundingClientRect().bottom}})()");
   assert.equal(geometry.rootScroll,0,'priority focus keeps window chrome in place');assert.ok(geometry.headingTop>=40&&geometry.headingBottom<720,'review header remains visible');
  }
  if(name.startsWith('settings-')||name.startsWith('integration-'))assert.equal(await js("!!document.querySelector('.pp-menu')"),false,name+' unobstructed');
  fs.writeFileSync(path.join(out,name+'.png'),await capture(win));results.push({screen:name,passed:true});
  if(name.startsWith('settings-')||name.startsWith('integration-')){
   await js("document.querySelectorAll('.pp-body').forEach(x=>x.scrollTop=x.scrollHeight)");await delay(80);
   fs.writeFileSync(path.join(out,name+'-bottom.png'),await capture(win));
  }
 };
 await win.loadURL('app://bundle/index.html');await delay(1200);
 for(const view of ['communications','tasks','people']){await nav(view);await snap(view);}
 // Ollie moments: forced card payloads through the real renderer and IPC events.
 const cardTop=async()=>{await js("(()=>{const c=document.getElementById('ollie-moment-card');const b=c&&c.closest('.pp-body');if(b)b.scrollTop=Math.max(0,c.offsetTop-b.offsetTop-8)})()");await delay(80)};
 for(const [kind,label] of [['morning','Ollie planned your day'],['prep','Up next'],['wrap','Day wrapped']]){
  forced.moment=moments[kind];await nav('communications');win.webContents.send('ollie:moment-changed',{reason:'action'});await delay(350);
  assert.ok((await js("document.getElementById('ollie-moment-card')?.innerText||''")).toUpperCase().includes(label.toUpperCase()),kind+' card rendered');
  await cardTop();await snap('ollie-'+kind+'-card');
  if(kind==='wrap')assert.ok((await js("document.querySelector('.pp-statusbar').innerText")).includes('Slack synced 12 min ago'),'footer shows Slack sync');
 }
 forced.moment=null;
 await nav('tasks');win.webContents.send('ollie:focus-moment',{kind:'processed',key:'processed:'+pilotId,meetingId:pilotId});await delay(700);
 assert.ok(await js(`!!document.querySelector('[data-meeting-id="${pilotId}"].ol-focus .ol-card')`),'focus-moment opens the processed recap row');
 assert.ok((await js(`document.querySelector('[data-meeting-id="${pilotId}"]').innerText`)).includes('Keep'),'recap offers Keep / Skip');
 await js(`document.querySelector('[data-meeting-id="${pilotId}"]').scrollIntoView({block:'start'})`);await snap('ollie-processed-recap');
 assert.ok((await js(`document.querySelector('[data-meeting-id="${failedId}"]').innerText`)).includes('Export audio'),'failure card offers recovery');
 await js(`document.querySelector('[data-meeting-id="${failedId}"]').scrollIntoView({block:'start'})`);await snap('ollie-failure-card');
 forced.catchUp=[{personId,weeksSinceMet:3,waitingOn:'the onboarding draft',text:'3 weeks since you met · waiting on the onboarding draft'}];
 await nav('people');await delay(250);assert.ok(await js("!!document.querySelector('.ol-person-note')"),'catch-up note rendered');await snap('ollie-people-catch-up');forced.catchUp=null;
 await nav('communications');await js("document.querySelector('.pp-review-pill').click()");await snap('review-queue');
 await nav('tasks');await click('Review priorities');await snap('review-priorities');
 await nav('communications');await click('Upload');await snap('upload-sheet');await js("document.querySelector('.pp-sheet-backdrop').click()");
 await js(`window.dispatchEvent(new CustomEvent('pp-navigate',{detail:{meetingId:${JSON.stringify(meetingId)}}}))`);await delay(350);await snap('meeting-insights');
 await nav('tasks');await click('Prepare the pilot invite list','[role="button"]');await snap('task-detail');
 await click('Same as another task');await snap('task-merge-picker');await click('Cancel merge');await click('Snooze until');await snap('task-snooze');
 await nav('tasks');await click('+ New task');await snap('new-task-sheet');await js("document.querySelector('.pp-sheet-backdrop').click()");
 await nav('people');await click('Jordan Lee','.pp-setrow');await snap('person-detail');
 await click('Archive person');await snap('archive-person-confirmation');await click('Cancel');await click('Same as another person');await snap('person-merge-picker');
 await nav('people');await click('+ Add person');await snap('add-person');
 await nav('communications');await js("document.querySelector('[aria-label=\"Capture — voice note or meeting recording\"]').click()");await snap('capture-chooser');
 await win.reload();await delay(600);await js("document.querySelector('[aria-label=Menu]').click()");await snap('menu');
 const menuText=await js("document.querySelector('.pp-menu')?.innerText||''");
 for(const label of ['Search','Review','About']){
  await win.reload();await delay(500);await js("document.querySelector('[aria-label=Menu]').click()");
  if(menuText.includes(label)){await click(label);await snap(label.toLowerCase());}
 }
 for(const section of ['AI provider','Startup & daily plan','Notifications','Transcription & recording','Connect to AI','Voice & identity','Data']){await nav('settings');await click(section,'.pp-setrow');await snap('settings-'+section.toLowerCase().replace(/[^a-z]+/g,'-'));}
 for(const section of ['Calendar','Jira','Slack','Zoom','Microsoft Teams','Google Meet','Approval gates & sync']){
  await nav('settings');await click('Integrations','.pp-setrow');await click(section,'.pp-setrow');await snap('integration-'+section.toLowerCase().replace(/[^a-z]+/g,'-'));
 }
 await nav('settings');await click('Integrations','.pp-setrow');await snap('integrations-hub');
 await nav('voice-capture');await delay(500);await snap('voice-capture');await nav('communications');
 await win.loadURL('app://bundle/index.html?review='+meetingId);await delay(700);await snap('transcript-review');
 const tabs=await js("[...document.querySelectorAll('[role=tab]')].map(x=>x.textContent)");
 assert.ok(tabs.length>=5,'all review tabs present');
 for(const title of tabs){await click(title,'[role=tab]');await snap('review-'+title.toLowerCase().replace(/[^a-z]+/g,'-'));}
 await win.loadURL('app://bundle/index.html');await delay(500);await nav('communications');
 await js("document.querySelector('[aria-label=\"Next week\"]').click()");await snap('empty-next-week');
 win.setSize(520,800);await nav('tasks');await snap('wide-tasks');win.setSize(380,720);
 config.setConfig({onboardingComplete:false});await win.reload();await delay(600);await snap('onboarding-setup');
 ipcMain.removeHandler('whisper:setup');ipcMain.handle('whisper:setup',async()=>({ok:true}));
 await click('Continue');await snap('onboarding-connect');await click('Continue - connections optional');await snap('onboarding-ready');
 // Daily plan is a separate entry point; isolate its data from AI/network work.
 ipcMain.removeHandler('dailyPlan:get');ipcMain.handle('dailyPlan:get',async()=>({greeting:{title:'Good morning, Alex',sub:'One conversation and two commitments today'},meetings:[{id:meetingId,title:'Launch readiness sync',startTime:Date.now(),endTime:Date.now()+1800000,attendees:['Jordan Lee'],agenda:['Review the draft'],agendaBasis:null}],tasks:[{id:'qa-task',title:'Prepare the pilot invite list',priority:'high',dueDate:null,reasoning:'Ready for a next move'}],hasApiKey:true}));
 const planWin=new BrowserWindow({width:520,height:720,show:false,frame:false,webPreferences:{preload:path.resolve(__dirname,'../dist/main/dailyplan-preload.js'),contextIsolation:true,offscreen:true}});
 await planWin.loadFile(path.resolve(__dirname,'../dist/renderer/dailyplan.html'));await delay(500);fs.writeFileSync(path.join(out,'daily-plan.png'),await capture(planWin));results.push({screen:'daily-plan',passed:true});
 assert.ok(await js("!!document.querySelector('.onboarding-card')"),'setup screen mounted');assert.deepEqual(errors,[],'no renderer exceptions');
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({passed:true,screens:results,rendererErrors:errors,limitations:['Synthetic data and fake microphone; no real provider credentials or external writes used.']},null,2));
 console.log('Owl design QA passed: '+results.length+' screen/state captures, real IPC, 380/520px layouts.');app.exit(0);
}).catch(e=>{console.error(e);fs.writeFileSync(path.join(out,'failure.txt'),e.stack||String(e));app.exit(1)});

