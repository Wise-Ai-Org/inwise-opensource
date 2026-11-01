const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.setPath('userData', path.join(app.getPath('temp'), 'inwise-audio-repro'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL('data:text/html,<html><body>Isolated audio test</body></html>');
  const helper = require('typescript').transpileModule(fs.readFileSync(path.join(__dirname, '../src/renderer/voice-audio.ts'), 'utf8'), {compilerOptions:{module:require('typescript').ModuleKind.CommonJS,target:require('typescript').ScriptTarget.ES2020}}).outputText;
  await win.webContents.executeJavaScript('window.voiceAudio = {}; (function(exports){' + helper + '})(window.voiceAudio)');
  const results = await win.webContents.executeJavaScript(`(async () => {
    const results = [];
    for (const ms of [0, 50, 500, 1500]) {
      const ctx = new AudioContext(); await ctx.resume();
      const oscillator = ctx.createOscillator();
      const destination = ctx.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start();
      const recorder = new MediaRecorder(destination.stream, {mimeType:'audio/webm;codecs=opus'});
      const chunks=[]; recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
      recorder.start(250); await new Promise(r=>setTimeout(r,ms));
      const stopped=new Promise(r=>recorder.onstop=r); recorder.stop(); await stopped;
      const bytes=await new Blob(chunks,{type:'audio/webm'}).arrayBuffer();
      const decodeCtx=new AudioContext({sampleRate:16000});
      try { const audio=await decodeCtx.decodeAudioData(bytes.slice(0));results.push({ms,bytes:bytes.byteLength,decoded:true,duration:audio.duration}); }
      catch(e){results.push({ms,bytes:bytes.byteLength,decoded:false,name:e.name,error:e.message});}
      try {
        const wav = await window.voiceAudio.decodeVoiceRecording(bytes);
        const wavCtx = new AudioContext({sampleRate:16000});
        const wavBytes = wav.byteLength;
        const roundTrip = await wavCtx.decodeAudioData(wav.buffer);
        if(roundTrip.sampleRate !== 16000 || roundTrip.length === 0) throw new Error('Invalid WAV');
        results[results.length-1].fixed = {ok:true, wavBytes, sampleRate:roundTrip.sampleRate};
        await wavCtx.close();
        const stereoWav=await window.voiceAudio.decodeVoiceRecording(bytes, true);
        const stereoCtx=new AudioContext();
        const stereoAudio=await stereoCtx.decodeAudioData(stereoWav.buffer);
        if(stereoAudio.numberOfChannels!==2) throw new Error('Stereo channel preservation failed');
        results[results.length-1].fixed.stereoPreserved=true;
        await stereoCtx.close();
      } catch(e) { results[results.length-1].fixed = {ok:false,error:e.message}; }
      await decodeCtx.close();oscillator.stop();destination.stream.getTracks().forEach(t=>t.stop());await ctx.close();
    }
    for(const result of results) {
      if(!result.bytes && !result.fixed.error.includes('No audio was captured')) throw new Error('Empty capture not handled');
      if(result.decoded && !result.fixed.ok) throw new Error('Valid recording regression');
    }
    // Deliberately corrupt input must fail, not silently report successful capture.
    let corruptRejected=false;
    try { await window.voiceAudio.decodeVoiceRecording(new Uint8Array([1,2,3,4]).buffer); } catch { corruptRejected=true; }
    if(!corruptRejected) throw new Error('Corrupt audio accepted');
    const fake = new EventTarget(); fake.state='recording'; fake.stop=()=>{};
    let timedOut=false;
    try { await window.voiceAudio.stopVoiceRecorder(fake, 30); } catch { timedOut=true; }
    if(!timedOut) throw new Error('Stop timeout not enforced');
    results.push({corruptRejected, stopTimeoutHandled:timedOut});
    return results;
  })()`);
  console.log(JSON.stringify(results, null, 2));
  const output=path.join(__dirname,'../artifacts/audio-repro.json'); fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(results,null,2));
  win.destroy(); app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
