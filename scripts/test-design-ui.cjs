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
 ipcMain.removeHandler('ollie:getProcessed');ipcMain.handle('ollie:getProcessed',async(_e,id)=>{const p=await ollie.getProcessedSummary(id);return p&&id===pilotId?{...p,jira:jiraRecap}:p&&id===meetingId?{...p,jira:jiraActionsRecap}:p});
 ipcMain.removeHandler('jira:searchUsers');ipcMain.handle('jira:searchUsers',async(_e,q)=>({ok:true,users:[{accountId:'qa-acc-jordan',displayName:'Jordan Lee',email:'jordan.lee@example.invalid'},{accountId:'qa-acc-jordan-2',displayName:'Jordan Leeds',email:null}].filter(u=>u.displayName.toLowerCase().includes(String(q||'').toLowerCase().split(' ')[0]))}));
 // Jira settings screen without a real connection: status and projects are synthetic in this QA process only.
 ipcMain.removeHandler('jira:status');ipcMain.handle('jira:status',()=>({connected:true,info:{cloudName:'Example Jira',email:'alex@example.invalid',cloudUrl:'https://example.invalid'}}));
 ipcMain.removeHandler('jira:getProjects');ipcMain.handle('jira:getProjects',async()=>({ok:true,projects:[{id:'1',key:'PILOT',name:'Pilot'}]}));
 ipcMain.removeHandler('ollie:catchUpNotes');ipcMain.handle('ollie:catchUpNotes',async()=>forced.catchUp||ollie.getCatchUpNotes());
 const now=new Date(),tomorrowAt=(h,m)=>{const d=new Date(now);d.setDate(d.getDate()+1);d.setHours(h,m,0,0);return d.getTime()},yesterday=dayKey(new Date(Date.now()-86400000));
 const inviteRef={taskId:inviteTask,title:'Prepare the pilot invite list',dueDate:yesterday,daysLate:1};
 const surveyRef={taskId:surveyTask,title:'Book the pilot customer calls',dueDate:null,daysLate:null};
 const approval={id:'qa-approval',operation:'create',summary:'Create ticket “Prepare the pilot invite list”?',issueKey:null,meetingId,meetingTitle:'Launch readiness sync',createdAt:now.toISOString(),issueTitle:null,evidence:'I will pull the invite list together this week',suggestion:null,intent:'new',confidence:0.72,url:null};
 // Jira fixtures (docs/JIRA_SAFETY.md): synthetic keys and example.invalid links only; no Jira connection or writes.
 const jfmt=require('../dist/main/jira-format');
 // The quote says Thursday, so the proposed date is the coming Thursday.
 const nextThursday=(()=>{const d=new Date();d.setDate(d.getDate()+(((4-d.getDay())+7)%7||7));return dayKey(d)})();
 const jurl=k=>'https://example.invalid/browse/'+k,jrow=(key,title,kind,detail,owner=null)=>({key,title,url:jurl(key),kind,detail,owner});
 const jiraPending=[
  {id:'qa-jira-done',operation:'transition',summary:'Move PILOT-42 to Done?',issueKey:'PILOT-42',issueTitle:'Send onboarding survey to pilot customers',url:jurl('PILOT-42'),evidence:'the survey went out yesterday, so that one is done',suggestion:null,intent:'done',confidence:0.84,meetingId:pilotId,meetingTitle:'Pilot planning',createdAt:now.toISOString()},
  {id:'qa-jira-due',operation:'update',summary:'Move the due date on PILOT-51 to '+jfmt.formatJiraDate(nextThursday)+'?',issueKey:'PILOT-51',issueTitle:'Pilot customer calls',url:jurl('PILOT-51'),evidence:'the calls slipped to Thursday',suggestion:null,intent:'due_moved',confidence:0.78,meetingId:pilotId,meetingTitle:'Pilot planning',createdAt:now.toISOString()},
  {id:'qa-jira-sug',operation:'comment',summary:'Update PILOT-38 instead?',issueKey:'PILOT-38',issueTitle:'Draft the pilot survey questions',url:jurl('PILOT-38'),evidence:'Jordan will draft the survey',suggestion:'Update PILOT-38 instead?',intent:'new',confidence:0.61,meetingId:pilotId,meetingTitle:'Pilot planning',createdAt:now.toISOString()},
 ];
 const jiraRecap={pushedCount:1,failedCount:1,pushed:[{id:'qa-pushed',issueKey:'PILOT-44',url:jurl('PILOT-44'),operation:'comment'}],pending:jiraPending,failed:[{id:'qa-failed',issueKey:'PILOT-12',operation:'transition',message:'PILOT-12 has no transition to Done'}]};
 const act=(id,operation,args,extra)=>({id,operation,summary:jfmt.describeJiraChange({operation,args}),issueKey:args.issueKey||args.blockedKey,url:jurl(args.issueKey||args.blockedKey),suggestion:null,confidence:0.8,meetingId,meetingTitle:'Launch readiness sync',createdAt:now.toISOString(),blockedReason:null,needs:null,assigneeName:args.assigneeName||null,...extra});
 const jiraActionsRecap={pushedCount:0,failedCount:0,pushed:[],failed:[],pending:[
  act('qa-assign','assign',{issueKey:'PILOT-40',accountId:null,assigneeName:'Jordan Lee'},{issueTitle:'Pilot onboarding emails',evidence:'Jordan will take PILOT-40',intent:'reassign',needs:'jira-user',blockedReason:'Jordan Lee is not linked to Jira yet. Find them in Jira first'}),
  act('qa-link','link',{blockedKey:'PILOT-33',blockerKey:'OPS-12'},{issueTitle:'Pilot SSO setup',evidence:'PILOT-33 is blocked on the SSO work in OPS-12',intent:'blocked_by'}),
  act('qa-sprint','sprint',{issueKey:'PILOT-41',sprintId:14,sprintName:'Sprint 14'},{issueTitle:'Pilot pricing page',evidence:"let's pull PILOT-41 into this sprint",intent:'sprint'}),
  act('qa-nosprint','sprint',{issueKey:'OPS-7',sprintId:null,sprintName:null},{issueTitle:'Vendor review',evidence:'OPS-7 should go in the next sprint',intent:'sprint',blockedReason:"OPS's board has no active or upcoming sprint"}),
 ]};
 const morningJira={dueToday:[jrow('PILOT-51','Pilot customer calls','due_today','Due today · In Progress')],overdue:[jrow('PILOT-47','Fix invite email links','overdue','2 days overdue · In Review')],
  sprintEnding:{name:'Pilot sprint 4',endsAt:new Date(new Date().setHours(17,0,0,0)).toISOString(),openCount:2,rows:[jrow('PILOT-49','Pilot analytics dashboard','sprint','In Progress')]},
  mentions:[jrow('PILOT-38','Draft the pilot survey questions','mention','Jordan Lee mentioned you')]};
 const prepJira={rows:[jrow('PILOT-33','Pilot SSO setup','blocked','Blocked 4 days by OPS-12','Jordan Lee'),jrow('PILOT-47','Fix invite email links','yours','Yours · In Review'),
  jrow('PILOT-41','Pilot pricing page','moved','Moved to In Review since you last met','Jordan Lee'),jrow('PILOT-29','Customer data export','stale','No update for 9 days','Jordan Lee')]};
 const wrapJira={changedToday:[{id:'qa-w1',issueKey:'PILOT-44',url:jurl('PILOT-44'),operation:'comment',summary:'Commented on PILOT-44'},{id:'qa-w2',issueKey:'PILOT-52',url:jurl('PILOT-52'),operation:'create',summary:'Created PILOT-52: Book the pilot customer calls'}],
  waitingCount:3,staleDiscussed:[jrow('PILOT-29','Customer data export','stale','Discussed today, no Jira update for 9 days','Jordan Lee')]};
 const moments={
  morning:{kind:'morning',key:'morning:'+dayKey(now),generatedAt:Date.now(),morning:{firstName:'Alex',meetingCount:3,priorityCount:2,overduePromiseCount:1,
   topPriorities:[{...inviteRef,rank:1,score:82,sourceMeetingId:meetingId,sourceMeetingTitle:'Launch readiness sync'},{...surveyRef,dueDate:dayKey(now),rank:2,score:64,sourceMeetingId:pilotId,sourceMeetingTitle:'Pilot planning'}],
   doneSinceYesterday:[{taskId:surveyTask,title:'Share the onboarding draft',dueDate:null,daysLate:null}],
   catchUp:[{personId,name:'Jordan Lee',daysSinceMet:24,weeksSinceMet:3,waitingOn:'the onboarding draft',waitingCount:1}],welcomeBack:null,jira:morningJira}},
  prep:{kind:'prep',key:'prep:qa-event',generatedAt:Date.now(),prep:{eventId:'qa-event',title:'Pilot kickoff with Jordan',startTime:Date.now()+8*60000,endTime:Date.now()+38*60000,minutesUntil:8,attendees:['Jordan Lee'],
   lastMet:{meetingId,title:'Launch readiness sync',date:now.toISOString()},draftAgenda:['Confirm the pilot invite list','Review the first onboarding version','Pick the first pilot date'],
   owes:[{name:'Jordan Lee',personId,owesYou:[{kind:'commitment',taskId:null,meetingId,text:'Review the first onboarding version',dueDate:yesterday,daysLate:2}],youOwe:[{kind:'task',taskId:inviteTask,meetingId,text:'Prepare the pilot invite list',dueDate:yesterday,daysLate:1}]}],
   pendingApprovals:[approval],recordArmed:false,jira:prepJira}},
  wrap:{kind:'wrap',key:'wrap:'+dayKey(now),generatedAt:Date.now(),wrapUp:{firstName:'Alex',today:{meetingCount:3,tasksFound:2,decisions:2},
   tomorrow:{firstMeeting:{eventId:'qa-event-2',title:'Pilot kickoff with Jordan',startTime:tomorrowAt(9,30),agendaDrafted:true,tasksDueBefore:[inviteRef]},overdueWithAttendees:[{...inviteRef,attendee:'Jordan Lee'}],
    crunch:{from:tomorrowAt(10,0),to:tomorrowAt(16,0),topOverdue:inviteRef},cancelledToday:[]},
   goneQuiet:[{...surveyRef,score:72,commitmentToOther:true,lastActivityAt:new Date(Date.now()-9*86400000).toISOString()}],
   slackToday:[{channelId:'unknown',threadCount:2,taskCount:1,decisionCount:0}],snoozedToday:[{taskId:inviteTask,title:'Update the beta FAQ',dueDate:null,daysLate:null}],receipts:[],
   needsRetry:[{meetingId:failedId,title:'Customer call (saved audio)',date:now.toISOString(),message:'Transcription failed.'}],slackSyncedAt:Date.now()-12*60000,jira:wrapJira}},
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
 const showSection=async label=>{const ok=await js(`(()=>{const l=[...document.querySelectorAll('.ol-seclabel')].find(x=>x.textContent.trim()===${JSON.stringify(label)});if(!l)return false;l.scrollIntoView({block:'start'});return true})()`);assert.ok(ok,label+' section rendered');await delay(100)};
 const cardTop=async()=>{await js("(()=>{const c=document.getElementById('ollie-moment-card');const b=c&&c.closest('.pp-body');if(b)b.scrollTop=Math.max(0,c.offsetTop-b.offsetTop-8)})()");await delay(80)};
 for(const [kind,label] of [['morning','Ollie planned your day'],['prep','Up next'],['wrap','Day wrapped']]){
  forced.moment=moments[kind];await nav('communications');win.webContents.send('ollie:moment-changed',{reason:'action'});await delay(350);
  assert.ok((await js("document.getElementById('ollie-moment-card')?.innerText||''")).toUpperCase().includes(label.toUpperCase()),kind+' card rendered');
  await cardTop();await snap('ollie-'+kind+'-card');
  const jiraLabel={morning:'Your Jira',prep:'Their Jira',wrap:'Jira today'}[kind];
  await showSection(jiraLabel);await snap('jira-'+kind);
  if(kind==='wrap')assert.ok((await js("document.querySelector('.pp-statusbar').innerText")).includes('Slack synced 12 min ago'),'footer shows Slack sync');
 }
 forced.moment=null;
 await nav('tasks');win.webContents.send('ollie:focus-moment',{kind:'processed',key:'processed:'+pilotId,meetingId:pilotId});await delay(700);
 assert.ok(await js(`!!document.querySelector('[data-meeting-id="${pilotId}"].ol-focus .ol-card')`),'focus-moment opens the processed recap row');
 assert.ok((await js(`document.querySelector('[data-meeting-id="${pilotId}"]').innerText`)).includes('Keep'),'recap offers Keep / Skip');
 await js(`document.querySelector('[data-meeting-id="${pilotId}"]').scrollIntoView({block:'start'})`);await snap('ollie-processed-recap');
 const recapText=await js(`document.querySelector('[data-meeting-id="${pilotId}"]').innerText`);
 for(const t of ['Move PILOT-42 to Done?','Update PILOT-38 instead?','Create new','PILOT-12 has no transition to Done'])assert.ok(recapText.includes(t),'recap shows '+t);
 await showSection('Jira from this meeting');await snap('jira-recap');
 assert.ok((await js(`document.querySelector('[data-meeting-id="${failedId}"]').innerText`)).includes('Export audio'),'failure card offers recovery');
 await js(`document.querySelector('[data-meeting-id="${failedId}"]').scrollIntoView({block:'start'})`);await snap('ollie-failure-card');
 forced.catchUp=[{personId,weeksSinceMet:3,waitingOn:'the onboarding draft',text:'3 weeks since you met · waiting on the onboarding draft'}];
 await nav('people');await delay(250);assert.ok(await js("!!document.querySelector('.ol-person-note')"),'catch-up note rendered');await snap('ollie-people-catch-up');forced.catchUp=null;
 // Recap Jira actions: assign (person not linked yet), blocking link, sprint found, sprint missing.
 await nav('communications');await delay(300);
 assert.ok(await js(`!!document.querySelector('[data-meeting-id="${meetingId}"] .ol-card')`),'actions recap rendered');
 await js(`(()=>{const c=document.querySelector('[data-meeting-id="${meetingId}"]');const l=[...c.querySelectorAll('.ol-seclabel')].find(x=>x.textContent.trim()==='Jira from this meeting');l.scrollIntoView({block:'start'})})()`);await delay(120);
 const actionsText=await js(`document.querySelector('[data-meeting-id="${meetingId}"]').innerText`);
 for(const t of ['Assign PILOT-40 to Jordan Lee?','Mark PILOT-33 as blocked by OPS-12?','Add PILOT-41 to Sprint 14?','Find in Jira',"OPS's board has no active or upcoming sprint"])assert.ok(actionsText.includes(t),'actions recap shows '+t);
 await snap('jira-recap-actions');
 await js(`[...document.querySelectorAll('[data-meeting-id="${meetingId}"] button')].find(b=>b.textContent.trim()==='Find in Jira').click()`);await delay(500);
 assert.ok((await js(`document.querySelector('[data-meeting-id="${meetingId}"]').innerText`)).includes('jordan.lee@example.invalid'),'Find in Jira lists Jira people');
 // People tab: a person Jira could not match by email.
 await db.setPersonJiraLink(personId,{status:'unresolved',accountId:null,displayName:null,checkedAt:now.toISOString()});
 await nav('people');await delay(400);
 assert.ok((await js("document.body.innerText")).includes('Not linked to Jira yet'),'People row offers the Jira link');
 await click('Find in Jira');await delay(500);
 assert.ok((await js("document.body.innerText")).includes('jordan.lee@example.invalid'),'Jira people search results');
 await snap('people-jira-link');
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
 await nav('settings');await click('Integrations','.pp-setrow');await click('Jira','.pp-setrow');await delay(300);
 assert.ok(await js(`(()=>{const g=document.querySelector('[role=radiogroup][aria-label="Jira changes"]');if(!g)return false;g.scrollIntoView({block:'center'});return true})()`),'Jira changes setting rendered');
 assert.ok(await js(`[...document.querySelectorAll('[role=radiogroup][aria-label="Jira changes"] input')][0].checked`),'Ask me every time is the default');
 await delay(100);fs.writeFileSync(path.join(out,'settings-jira-approval.png'),await capture(win));results.push({screen:'settings-jira-approval',passed:true});
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

