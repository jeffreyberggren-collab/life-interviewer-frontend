(function(){
  const { SERVER_URL } = window.APP_CONFIG || {};
  const preview = document.getElementById('preview');
  const overlayCanvas = document.getElementById('overlayCanvas');
  const qBanner = document.getElementById('questionBanner');
  const downloads = document.getElementById('downloads');
  const progressBar = document.getElementById('progressBar');
  const logEl = document.getElementById('log');
  const assistantAudio = document.getElementById('assistantAudio');

  const eventSelect = document.getElementById('eventSelect');
  const langSelect = document.getElementById('langSelect');
  const overlayToggle = document.getElementById('overlayToggle');
  const captionSize = document.getElementById('captionSize');
  const captionSizeVal = document.getElementById('captionSizeVal');
  const connectBtn = document.getElementById('connectBtn');
  const startRecBtn = document.getElementById('startRecBtn');
  const stopRecBtn = document.getElementById('stopRecBtn');
  const srtBtn = document.getElementById('srtBtn');

  if(!SERVER_URL){
    alert('SERVER_URL not set. Open config.js and add your Render URL.');
    throw new Error('SERVER_URL missing');
  }

  let pc=null, dc=null;
  let localStream=null, remoteStream=null;
  let mixedAudioDest=null; // AudioContext destination for mixing mic+AI
  let mediaRecorder=null, recordedChunks=[];
  let captions=[]; // {i, start, end, text}
  let captionIndex=1;
  let assistantSpeaking=false, speakTimer=null;

  function log(msg){ console.log(msg); logEl.textContent=((logEl.textContent + '\\n' + msg).trim()); }

  // Camera + mic
  async function getCamera(){
    if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream=null; }
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode:'user', width:{ideal:1080}, height:{ideal:1920} } });
    preview.srcObject = localStream;
  }

  // Draw overlay with captions (burn-in if enabled)
  function drawOverlayLoop(){
    const ctx = overlayCanvas.getContext('2d');
    function frame(){
      const vw = preview.videoWidth || overlayCanvas.width || 1080;
      const vh = preview.videoHeight || overlayCanvas.height || 1920;
      overlayCanvas.width = vw; overlayCanvas.height = vh;
      ctx.drawImage(preview, 0, 0, vw, vh);
      const text = qBanner.textContent || '';
      if (overlayToggle.checked && text){
        const pad = Math.round(vw * 0.025);
        const boxH = Math.round(vh * 0.22);
        const grad = ctx.createLinearGradient(0, vh - boxH, 0, vh);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(0.35, 'rgba(0,0,0,0.55)');
        grad.addColorStop(1, 'rgba(0,0,0,0.8)');
        ctx.fillStyle = grad; ctx.fillRect(0, vh - boxH, vw, boxH);
        ctx.fillStyle='white'; ctx.font = `bold ${Math.max(Number(captionSize.value), Math.round(vw*0.035))}px -apple-system,system-ui,Segoe UI,Roboto,Helvetica,Arial`;
        ctx.textBaseline='bottom';
        const lines = wrapText(ctx, text, vw - pad*2);
        let y = vh - pad;
        for (let i = lines.length - 1; i >= 0; i--){ ctx.fillText(lines[i], pad, y); y -= Math.max(24, Math.round(vw*0.045)); }
      }
      requestAnimationFrame(frame);
    }
    frame();
  }
  function wrapText(ctx, text, maxWidth){ const words = text.split(' '), lines=[]; let line=''; for(const w of words){ const test = line ? (line+' '+w) : w; if (ctx.measureText(test).width > maxWidth){ if(line) lines.push(line); line=w; } else { line=test; } } if(line) lines.push(line); return lines.slice(-4); }

  // WebRTC connect to Realtime
  async function connectRealtime(){
    await getCamera();
    drawOverlayLoop();

    // Fetch ephemeral key from server (pass event & vibe)
    const url = new URL('/session', SERVER_URL);
    url.searchParams.set('event', eventSelect.value);
    url.searchParams.set('vibe', 'old_friend');
    const resp = await fetch(url.toString());
    if(!resp.ok){ alert('Failed to get session from server'); return; }
    const session = await resp.json();
    const EPHEMERAL_KEY = session?.client_secret?.value;
    if(!EPHEMERAL_KEY){ alert('No session token received'); return; }

    pc = new RTCPeerConnection();
    // Local mic to model
    localStream.getAudioTracks().forEach(t=>pc.addTrack(t, localStream));
    // Get remote audio (assistant)
    remoteStream = new MediaStream();
    pc.ontrack = (e) => {
      e.streams[0].getAudioTracks().forEach(track => remoteStream.addTrack(track));
      assistantAudio.srcObject = remoteStream;
    };

    // Data channel to receive text deltas for captions
    dc = pc.createDataChannel('oai-events');
    dc.onopen = ()=> log('Data channel open');
    dc.onmessage = (ev)=>{
      try{
        const msg = JSON.parse(ev.data);
        if (msg.type === 'response.output_text.delta'){
          if(!assistantSpeaking){ assistantSpeaking = true; onAssistantStart(); }
          appendCaptionDelta(msg.delta || '');
        } else if (msg.type === 'response.output_text.done'){
          closeCaption();
        } else if (msg.type === 'response.completed'){
          closeCaption();
        }
      }catch{ /* ignore non-JSON */ }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const baseUrl = 'https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';
    const sdpResp = await fetch(baseUrl, {
      method: 'POST',
      body: offer.sdp,
      headers: { 'Authorization': `Bearer ${EPHEMERAL_KEY}`, 'Content-Type': 'application/sdp' }
    });
    const answer = { type: 'answer', sdp: await sdpResp.text() };
    await pc.setRemoteDescription(answer);

    // Prime the model in English (client-side hint; server already enforces)
    if (dc?.readyState === 'open'){
      dc.send(JSON.stringify({
        type: 'response.create',
        response: {
          instructions: `Speak English (US). Be an old friend focused on ${eventSelect.value}. One question at a time.`
        }
      }));
    }

    connectBtn.disabled = true;
    startRecBtn.disabled = false;
  }

  // Captions handling
  let captions=[]; // {i, start, end, text}
  let captionIndex=1;
  let currentCaption = { i:null, start:null, text:'' };
  let assistantSpeaking=false, speakTimer=null;

  function nowMs(){ return performance.now(); }

  function appendCaptionDelta(delta){
    // Start or extend current caption
    if(currentCaption.i===null){
      currentCaption = { i: captionIndex++, start: nowMs(), text: '' };
    }
    currentCaption.text += delta;
    qBanner.textContent = currentCaption.text.trim();
    // Reset "assistant speaking" timer so mic stays muted until the AI falls silent
    if (speakTimer) clearTimeout(speakTimer);
    speakTimer = setTimeout(()=>{ assistantSpeaking=false; onAssistantStop(); closeCaption(); }, 1200);
  }

  function closeCaption(){
    if(currentCaption.i!==null){
      const end = nowMs();
      const start = currentCaption.start;
      const text = (currentCaption.text||'').trim();
      if (text){
        captions.push({ i: currentCaption.i, start, end, text });
      }
      currentCaption = { i:null, start:null, text:'' };
    }
    qBanner.textContent = '';
  }

  // Mic gating so the AI finishes speaking before user can interrupt
  function onAssistantStart(){
    assistantSpeaking = true;
    const mic = localStream?.getAudioTracks()?.[0];
    if (mic) mic.enabled = false;
  }
  function onAssistantStop(){
    const mic = localStream?.getAudioTracks()?.[0];
    if (mic) mic.enabled = true;
  }

  // Build SRT text
  function toSrtTime(ms){
    const t = Math.max(ms, 0);
    const hh = Math.floor(t/3600000);
    const mm = Math.floor((t%3600000)/60000);
    const ss = Math.floor((t%60000)/1000);
    const ms3 = Math.floor(t%1000);
    return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')},${String(ms3).padStart(3,'0')}`;
  }
  function exportSrt(){
    if(!captions.length){ alert('No captions yet.'); return; }
    const t0 = captions[0].start; // zero baseline
    const lines = captions.map(c => `${c.i}\n${toSrtTime(c.start - t0)} --> ${toSrtTime(c.end - t0)}\n${c.text.trim()}\n`);
    const blob = new Blob([lines.join('\n')], { type:'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    a.href = url; a.download = `captions_${stamp}.srt`; a.textContent = `Download SRT — ${stamp}`;
    downloads.appendChild(a);
    srtBtn.disabled = true;
    setTimeout(()=>URL.revokeObjectURL(url), 30000);
  }

  // Recording: merge camera video + mixed mic+AI audio, burn-in captions if overlay ON
  async function startRecording(){
    // Canvas captures video + we add a mixed audio track
    const ctx = overlayCanvas.getContext('2d'); // ensure canvas is live
    const canvasStream = overlayCanvas.captureStream(30);

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const mixedDest = audioCtx.createMediaStreamDestination();

    // Mic
    if (localStream?.getAudioTracks()?.length){
      const micSrc = audioCtx.createMediaStreamSource(new MediaStream([localStream.getAudioTracks()[0]]));
      micSrc.connect(mixedDest);
    }
    // Assistant
    if (remoteStream?.getAudioTracks()?.length){
      const aiSrc = audioCtx.createMediaStreamSource(new MediaStream([remoteStream.getAudioTracks()[0]]));
      aiSrc.connect(mixedDest);
    }

    const outStream = new MediaStream([...canvasStream.getVideoTracks()]);
    if (mixedDest.stream.getAudioTracks().length){
      outStream.addTrack(mixedDest.stream.getAudioTracks()[0]);
    }

    let mime = '';
    const prefs=['video/mp4;codecs=avc1,mp4a','video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'];
    for (const t of prefs){ if (MediaRecorder.isTypeSupported(t)){ mime=t; break; } }

    const recorded=[];
    const rec = new MediaRecorder(outStream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = (e)=>{ if(e.data && e.data.size) recorded.push(e.data); };
    rec.onstop = ()=>{
      const blob = new Blob(recorded, { type: rec.mimeType || 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g,'-');
      const ext = (rec.mimeType||'').includes('mp4') ? 'mp4' : 'webm';
      a.href = url; a.download = `interview_${stamp}.${ext}`;
      a.textContent = `Download video (${ext.toUpperCase()}) — ${stamp}`;
      downloads.appendChild(a);
      setTimeout(()=>URL.revokeObjectURL(url), 60000);
    };
    rec.start();

    // store refs
    mediaRecorder = rec;
    startRecBtn.disabled = true; stopRecBtn.disabled = false; srtBtn.disabled = false;
  }

  function stopRecording(){
    mediaRecorder?.stop();
    startRecBtn.disabled=false; stopRecBtn.disabled=true;
  }

  // UI wiring
  captionSize.addEventListener('input', ()=> captionSizeVal.textContent = captionSize.value + 'px');
  connectBtn.addEventListener('click', connectRealtime);
  startRecBtn.addEventListener('click', startRecording);
  stopRecBtn.addEventListener('click', stopRecording);
  srtBtn.addEventListener('click', exportSrt);

  captionSizeVal.textContent = captionSize.value + 'px';
  preview.addEventListener('loadedmetadata', drawOverlayLoop);
})();