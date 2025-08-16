(function(){
  function el(id){ return document.getElementById(id); }
  const logEl = el('log');
  function log(m){ console.log(m); if(logEl){ logEl.textContent=((logEl.textContent+'\n'+m).trim()); } }

  window.addEventListener('DOMContentLoaded', () => {
    try{ main(); }catch(e){ alert(e.message||e); }
  });

  async function main(){
    const { SERVER_URL } = window.APP_CONFIG || {};
    if(!SERVER_URL){ alert('SERVER_URL missing in config.js'); throw new Error('SERVER_URL missing'); }

    const preview = el('preview');
    const overlayCanvas = el('overlayCanvas');
    const qBanner = el('questionBanner');
    const downloads = el('downloads');
    const assistantAudio = el('assistantAudio');

    const eventSelect = el('eventSelect');
    const overlayToggle = el('overlayToggle');
    const captionSize = el('captionSize'); const captionSizeVal = el('captionSizeVal');
    const connectBtn = el('connectBtn'); const startRecBtn = el('startRecBtn');
    const stopRecBtn = el('stopRecBtn'); const srtBtn = el('srtBtn');

    captionSize.addEventListener('input', ()=> captionSizeVal.textContent = captionSize.value + 'px');
    captionSizeVal.textContent = captionSize.value + 'px';

    let pc=null, dc=null;
    let localStream=null, remoteStream=null;
    let mediaRecorder=null;
    let captions=[]; let captionIndex=1;
    let assistantSpeaking=false, speakTimer=null;

    connectBtn.addEventListener('click', async ()=>{
      await getCamera(); drawOverlayLoop();
      const url = new URL('/session', SERVER_URL);
      url.searchParams.set('event', eventSelect.value);
      url.searchParams.set('vibe', 'old_friend');
      const resp = await fetch(url.toString());
      const session = await resp.json();
      const EPHEMERAL_KEY = session?.client_secret?.value;
      if(!EPHEMERAL_KEY){ alert('No session token'); return; }

      pc = new RTCPeerConnection();
      localStream.getAudioTracks().forEach(t=>pc.addTrack(t, localStream));
      remoteStream = new MediaStream();
      pc.ontrack = (e) => { e.streams[0].getAudioTracks().forEach(t=>remoteStream.addTrack(t)); assistantAudio.srcObject = remoteStream; };

      dc = pc.createDataChannel('oai-events');
      dc.onmessage = (ev)=>{
        try{
          const msg = JSON.parse(ev.data);
          if (msg.type === 'response.output_text.delta'){ if(!assistantSpeaking){ assistantSpeaking=true; onAssistantStart(); } appendCaptionDelta(msg.delta||''); }
          else if (msg.type === 'response.output_text.done' || msg.type === 'response.completed'){ closeCaption(); }
        }catch{}
      };

      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      const sdpResp = await fetch('https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
        method:'POST', body: offer.sdp, headers:{ 'Authorization': `Bearer ${EPHEMERAL_KEY}`, 'Content-Type': 'application/sdp' }
      });
      const answer = { type:'answer', sdp: await sdpResp.text() }; await pc.setRemoteDescription(answer);

      // Send initial instructions
      dc.onopen = () => {
        dc.send(JSON.stringify({ 
          type:'response.create', 
          response:{ 
            instructions:`Speak English (US). Act like an old friend, stay on topic about ${eventSelect.value}. Ask one question at a time, let the user finish before speaking again.`
          } 
        }));
      };

      connectBtn.disabled = true; startRecBtn.disabled = false;
      log('Connected');
    });

    startRecBtn.addEventListener('click', startRecording);
    stopRecBtn.addEventListener('click', stopRecording);
    srtBtn.addEventListener('click', exportSrt);

    async function getCamera(){
      if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream=null; }
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode:'user', width:{ideal:1080}, height:{ideal:1920} } });
      preview.srcObject = localStream;
      log('Got camera/mic');
    }

    function drawOverlayLoop(){
      const ctx = overlayCanvas.getContext('2d');
      (function frame(){
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
          ctx.fillStyle='white';
          ctx.font = `bold ${Math.max(Number(captionSize.value), Math.round(vw*0.035))}px sans-serif`;
          ctx.textBaseline='bottom';
          const lines = wrap(ctx, text, vw - pad*2);
          let y = vh - pad;
          for (let i = lines.length - 1; i >= 0; i--){ ctx.fillText(lines[i], pad, y); y -= Math.max(24, Math.round(vw*0.045)); }
        }
        requestAnimationFrame(frame);
      })();
    }
    function wrap(ctx, text, maxWidth){
      const words=text.split(' '), lines=[]; let line='';
      for(const w of words){ 
        const test=line?line+' '+w:w; 
        if(ctx.measureText(test).width>maxWidth){ if(line) lines.push(line); line=w; } 
        else { line=test; } 
      }
      if(line) lines.push(line); 
      return lines.slice(-4);
    }

    // captions + gating
    let currentCaption={i:null,start:null,text:''};
    function nowMs(){ return performance.now(); }
    function appendCaptionDelta(d){
      if(currentCaption.i===null){ currentCaption={i:captions.length+1,start:nowMs(),text:''}; }
      currentCaption.text += d; qBanner.textContent=currentCaption.text.trim();
      if (speakTimer) clearTimeout(speakTimer);
      speakTimer=setTimeout(()=>{ assistantSpeaking=false; onAssistantStop(); closeCaption(); },1200);
    }
    function closeCaption(){
      if(currentCaption.i!==null){
        const end=nowMs(); const start=currentCaption.start; const text=(currentCaption.text||'').trim();
        if(text){ captions.push({ i: currentCaption.i, start, end, text }); }
        currentCaption={i:null,start:null,text:''};
      }
      qBanner.textContent='';
    }
    function onAssistantStart(){ const mic=localStream?.getAudioTracks()?.[0]; if(mic) mic.enabled=false; }
    function onAssistantStop(){ const mic=localStream?.getAudioTracks()?.[0]; if(mic) mic.enabled=true; }

    function toSrtTime(ms){ 
      const t=Math.max(ms,0),
      hh=Math.floor(t/3600000),
      mm=Math.floor((t%3600000)/60000),
      ss=Math.floor((t%60000)/1000),
      ms3=Math.floor(t%1000); 
      return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')},${String(ms3).padStart(3,'0')}`; 
    }
    function exportSrt(){
      if(!captions.length){ alert('No captions yet.'); return; }
      const t0=captions[0].start;
      const lines=captions.map(c=>`${c.i}\n${toSrtTime(c.start-t0)} --> ${toSrtTime(c.end-t0)}\n${c.text.trim()}\n`);
      const blob=new Blob([lines.join('\n')],{type:'text/plain'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a'); const stamp=new Date().toISOString().replace(/[:.]/g,'-');
      a.href=url; a.download=`captions_${stamp}.srt`;
      a.textContent=`Download SRT — ${stamp}`;
      downloads.appendChild(a); 
      setTimeout(()=>URL.revokeObjectURL(url),30000);
    }

    async function startRecording(){
      const canvasStream = overlayCanvas.captureStream(30);
      const audioCtx = new (window.AudioContext||window.webkitAudioContext)();
      const mixed = audioCtx.createMediaStreamDestination();
      if(localStream?.getAudioTracks()?.length){ audioCtx.createMediaStreamSource(new MediaStream([localStream.getAudioTracks()[0]])).connect(mixed); }
      if(remoteStream?.getAudioTracks()?.length){ audioCtx.createMediaStreamSource(new MediaStream([remoteStream.getAudioTracks()[0]])).connect(mixed); }
      const out = new MediaStream([...canvasStream.getVideoTracks()]);
      if(mixed.stream.getAudioTracks().length){ out.addTrack(mixed.stream.getAudioTracks()[0]); }
      const prefs=['video/mp4;codecs=avc1,mp4a','video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm']; 
      let mime=''; for(const t of prefs){ if(MediaRecorder.isTypeSupported(t)){ mime=t; break; } }
      const chunks=[]; 
      const rec=new MediaRecorder(out, mime?{mimeType:mime}:undefined);
      rec.ondataavailable=(e)=>{ if(e.data && e.data.size) chunks.push(e.data); };
      rec.onstop=()=>{
        const blob=new Blob(chunks,{type:rec.mimeType||'video/webm'});
        const url=URL.createObjectURL(blob);
        const a=document.createElement('a'); 
        const stamp=new Date().toISOString().replace(/[:.]/g,'-'); 
        const ext=(rec.mimeType||'').includes('mp4')?'mp4':'webm';
        a.href=url; 
        a.download=`interview_${stamp}.${ext}`;
        a.textContent=`Download video (${ext.toUpperCase()}) — ${stamp}`;
        downloads.appendChild(a); 
        setTimeout(()=>URL.revokeObjectURL(url),60000);
      };
      rec.start(); 
      mediaRecorder=rec; 
      startRecBtn.disabled=true; 
      stopRecBtn.disabled=false; 
      srtBtn.disabled=false;
    }
    function stopRecording(){ 
      if(!mediaRecorder){ alert('Recorder not started'); return; } 
      mediaRecorder.stop(); 
      startRecBtn.disabled=false; 
      stopRecBtn.disabled=true; 
    }
  }
})();
