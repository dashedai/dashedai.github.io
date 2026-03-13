/* ═══════════════════════════════════════════════════════════════
   DashAI — app.js v7
   
   KEY ARCHITECTURE DECISIONS:
   
   1. WebGPU runs ONLY on main thread (browser requirement) — no worker.
      Previous worker approach failed silently, making things worse.
   
   2. Anti-freeze strategy: yield to browser between EVERY token on mobile,
      every 2 tokens on desktop. Uses scheduler.yield() → MessageChannel
      fallback. This gives the compositor a 16ms window each token.
   
   3. StreamingText: APPENDS spans, never rebuilds innerHTML from scratch.
      O(1) DOM work per token instead of O(n) rebuild. Critical for mobile.
   
   4. Progress updates debounced to max 4/sec during model load so React
      re-renders don't compete with WebGPU init.
   
   5. All React state updates during streaming are deferred — only the
      final commit (setStreamId→null) triggers a React reconciliation.
   
   6. No context limit on messages — users can write as many as they want.
      We trim old messages from the API call only, not from the UI.
═══════════════════════════════════════════════════════════════ */
const { useState, useEffect, useRef } = React;

/* ── Model definitions ── */
const MODELS = [
  { id:'SmolLM2-360M-Instruct-q4f16_1-MLC',  name:'DashNano', desc:'Ultralight · 360M params · best for mobile', size:'~200 MB', badge:'Mobile', bc:'mb-n', bytes:200e6 },
  { id:'Llama-3.2-1B-Instruct-q4f16_1-MLC',  name:'DashLite', desc:'Fast & light · 1.2B params',                 size:'~700 MB', badge:'Recommended', bc:'mb-r', bytes:700e6 },
  { id:'Llama-3.2-3B-Instruct-q4f16_1-MLC',  name:'DashMid',  desc:'Balanced · 3B params',                       size:'~2 GB',   badge:'Balanced',    bc:'mb-b', bytes:2e9   },
  { id:'Llama-3.1-8B-Instruct-q4f16_1-MLC',  name:'DashPro',  desc:'Maximum power · 8B params',                  size:'~5 GB',   badge:'Heavy',        bc:'mb-h', bytes:5e9   },
];
const LANG_EXT = {python:'py',javascript:'js',typescript:'ts',html:'html',css:'css',bash:'sh',json:'json',java:'java',cpp:'cpp',c:'c',rust:'rs',go:'go',ruby:'rb',php:'php',sql:'sql',plaintext:'txt'};
const CHIPS = ['Who are you?','Open YouTube','Open GitHub','Write a Python scraper','Search for AI news','Explain WebGPU','Show a glass card CSS'];
const SAVED_KEY = 'dashai_last_model';
const PROFILE_KEY = 'dashai_profile';

/* ── Profile detection ── */
const isMobileUA = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 680;
function detectProfile() {
  return localStorage.getItem(PROFILE_KEY) || (isMobileUA() ? 'mobile' : 'desktop');
}

/* Profile config — context limit is for API call only, not UI display */
const PROFILES = {
  desktop: { label:'Desktop', icon:'computer',      maxTokens:1024, ctxLimit:16, yieldEvery:2  },
  mobile:  { label:'Mobile',  icon:'phone_android',  maxTokens:512,  ctxLimit:8,  yieldEvery:1  },
};

/* ── Engine on window, never GC'd ── */
if (!window._DE) window._DE = null;

/* ── Yield to browser compositor between tokens ──
   MessageChannel is faster than setTimeout(0) and
   scheduler.yield() is even faster on Chrome 115+ */
const yieldFrame = () => new Promise(r => {
  if (typeof scheduler !== 'undefined' && scheduler.yield) {
    scheduler.yield().then(r);
    return;
  }
  const mc = new MessageChannel();
  mc.port1.onmessage = r;
  mc.port2.postMessage(null);
});

const waitWLLM = () => new Promise(r => { if (window._wllm) r(); else window.addEventListener('wllm', r, {once:true}); });
const hasGPU   = () => !!navigator.gpu;
const uid      = () => Math.random().toString(36).slice(2,9);
const fmtEta   = s => s < 60 ? `${Math.round(s)}s` : `${Math.floor(s/60)}m ${Math.round(s%60)}s`;

/* System prompt */
const buildSys = (autoOpen) =>
`You are Dash, the AI inside DashAI — a browser app running AI locally via WebGPU.
IDENTITY: Your name is Dash. An on-device AI in the browser.
OPENING WEBSITES: Wrap the URL in asterisks: *https://site.com*
DashAI ${autoOpen?'opens them automatically.':'shows a tap-to-open button.'}
Examples: "open youtube" → *https://youtube.com* · "open github" → *https://github.com* · "search dogs" → *https://google.com/search?q=dogs*
Rules: 1) Always *https://full-url* 2) Inline with text 3) Don't explain unless asked
CODE: fenced blocks with language tag. STYLE: concise, direct.`;

/* Parse response */
function parseAI(raw) {
  const cmds = [];
  let text = raw.replace(/\*(https?:\/\/[^\s*]+)\*/g, (_,u) => { cmds.push(u); return ''; });
  const segs=[]; const re=/```(\w*)\r?\n?([\s\S]*?)```/g; let last=0,m;
  while((m=re.exec(text))!==null){
    const b=text.slice(last,m.index).trim(); if(b) segs.push({t:'txt',v:b});
    segs.push({t:'code',lang:m[1]||'plaintext',v:m[2].trim()});
    last=m.index+m[0].length;
  }
  const tail=text.slice(last).trim(); if(tail) segs.push({t:'txt',v:tail});
  cmds.forEach(u=>segs.push({t:'cmd',v:u}));
  return segs;
}
function iMd(s){
  return s.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
          .replace(/(?<!\*)\*(?!\*)(.*?)(?<!\*)\*(?!\*)/g,'<em>$1</em>')
          .replace(/`([^`]+)`/g,'<code>$1</code>');
}
function safeOpen(url){ try{window.open(url,'_blank','noopener');}catch(e){} }

/* ═══════════════════════════════════════════════════════════════
   STREAMING TEXT — incremental DOM append, never rebuilds
   
   The ONLY way to avoid O(n²) cost is to APPEND new spans rather
   than clearing innerHTML and rebuilding everything. We track the
   last rendered character position and only process new chars.
   
   Word-by-word fade: we split on whitespace. When we have a new
   complete word (followed by whitespace or end), we append it with
   .wf animation. Partial words (mid-token) render plain and get
   replaced when the word completes.
═══════════════════════════════════════════════════════════════ */
const StreamingText = ({ textRef, isMob }) => {
  const rootRef   = useRef(null);
  const stateRef  = useRef({
    renderedText: '',     // text already turned into DOM spans
    partialSpan: null,    // the current incomplete-word span (may be replaced)
  });

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    // On mobile: no blur animation (saves GPU), just appear
    // On desktop: use wf blur-fade
    const animate = !isMob;

    let rafId;
    const tick = () => {
      const fullText = textRef.current || '';
      const st = stateRef.current;

      // Nothing new
      if (fullText === st.renderedText) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      // Get only the new characters since last render
      const newChars = fullText.slice(st.renderedText.length);

      // Split new content into tokens by whitespace boundaries
      // We use the combined pending+new text to avoid splitting words mid-token
      const pending = st.partialSpan ? st.partialSpan.textContent : '';
      const combined = pending + newChars;

      // Split into words + spaces
      const parts = combined.split(/(\s+)/);

      // Remove old partial span if any
      if (st.partialSpan && st.partialSpan.parentNode) {
        el.removeChild(st.partialSpan);
        st.partialSpan = null;
      }

      const lastIdx = parts.length - 1;
      parts.forEach((part, i) => {
        if (!part) return;
        const isLast = i === lastIdx;
        const isWhitespace = /^\s+$/.test(part);

        if (isLast && !isWhitespace) {
          // This is the trailing partial word — render as plain mutable span
          const span = document.createElement('span');
          span.textContent = part.replace(/\n/g, '');
          if (part.includes('\n')) {
            // Handle newline in partial
            span.innerHTML = part.replace(/\n/g, '<br>');
          }
          el.appendChild(span);
          st.partialSpan = span;
        } else {
          // Completed word or whitespace — render with animation
          const span = document.createElement('span');
          if (part.includes('\n')) {
            span.innerHTML = part.replace(/\n/g, '<br>');
          } else {
            span.textContent = part;
          }
          if (animate && !isWhitespace) {
            span.className = 'wf';
            // No delay — each word just fades in immediately on arrival
          }
          el.appendChild(span);
        }
      });

      st.renderedText = fullText;
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return React.createElement('div', { className:'btxt', ref:rootRef });
};

const StreamBubble = ({ textRef, isMob }) =>
  React.createElement('div',{className:'mrow a'},
    React.createElement('div',{className:'bub a'},
      React.createElement('div',{className:'bi'},
        React.createElement(StreamingText, { textRef, isMob })
      )
    )
  );

/* ── Loader spinner ── */
const Loader = ({size='loader-md', cls=''}) =>
  React.createElement('div',{className:`loader ${size} ${cls}`},
    React.createElement('div',{className:'inner one'}),
    React.createElement('div',{className:'inner two'}),
    React.createElement('div',{className:'inner three'})
  );

/* ── Code block ── */
const CodeWidget = ({lang, code}) => {
  const [ok,setOk] = useState(false);
  const ref = useRef(null);
  useEffect(()=>{
    if(ref.current && window.Prism){
      const el = ref.current.querySelector('code');
      if(el) Prism.highlightElement(el);
    }
  },[code]);
  const copy = () => navigator.clipboard.writeText(code).then(()=>{setOk(true);setTimeout(()=>setOk(false),2000);});
  const dl   = () => {
    const ext = LANG_EXT[lang.toLowerCase()]||'txt';
    const a = Object.assign(document.createElement('a'),{
      href:URL.createObjectURL(new Blob([code],{type:'text/plain'})),
      download:`snippet.${ext}`
    });
    a.click(); URL.revokeObjectURL(a.href);
  };
  return React.createElement('div',{className:'cw'},
    React.createElement('div',{className:'cw-h'},
      React.createElement('span',{className:'cw-lang'},lang||'code'),
      React.createElement('div',{className:'cw-btns'},
        React.createElement('button',{className:`cw-btn${ok?' ok':''}`,onClick:copy},
          React.createElement('span',{className:'material-symbols-outlined'},ok?'check':'content_copy'),ok?'Copied!':'Copy'),
        React.createElement('button',{className:'cw-btn',onClick:dl},
          React.createElement('span',{className:'material-symbols-outlined'},'download'),'Save')
      )
    ),
    React.createElement('div',{className:'cw-body',ref},
      React.createElement('pre',{className:`language-${lang}`},
        React.createElement('code',{className:`language-${lang}`},code)))
  );
};

const CmdBtn = ({url}) => {
  const p = url.replace(/^https?:\/\/(www\.)?/,'').replace(/\/$/,'');
  return React.createElement('a',{className:'cmdbtn',href:url,target:'_blank',rel:'noopener',
    onClick:e=>{e.preventDefault();safeOpen(url);}},
    React.createElement('span',{className:'material-symbols-outlined'},'open_in_new'),`Open ${p}`);
};

/* ── Finished (static) bubble ── */
const Bubble = React.memo(({msg, isLatest, autoOpen}) => {
  const firedRef = useRef(false);
  useEffect(()=>{
    if(autoOpen&&isLatest&&msg.role==='ai'&&msg.text&&!firedRef.current){
      const hits=[...msg.text.matchAll(/\*(https?:\/\/[^\s*]+)\*/g)];
      if(hits.length){firedRef.current=true;hits.forEach(([,url],i)=>setTimeout(()=>safeOpen(url),200+i*200));}
    }
  },[autoOpen,isLatest,msg.text]);

  if(msg.role==='user') return React.createElement('div',{className:'mrow u'},
    React.createElement('div',{className:'bub u'},msg.text));

  if(msg.thinking) return React.createElement('div',{className:'mrow a'},
    React.createElement('div',{className:'bub a think'},
      React.createElement('div',{className:'dots'},
        React.createElement('i'),React.createElement('i'),React.createElement('i'))));

  const segs = parseAI(msg.text||'');
  return React.createElement('div',{className:'mrow a'},
    React.createElement('div',{className:'bub a'},
      React.createElement('div',{className:'bi'},segs.map((s,i)=>{
        if(s.t==='code') return React.createElement(CodeWidget,{key:i,lang:s.lang,code:s.v});
        if(s.t==='cmd')  return React.createElement(CmdBtn,{key:i,url:s.v});
        return React.createElement('div',{key:i,className:'btxt'},
          s.v.split(/\n/).filter(l=>l.trim()).map((ln,j)=>{
            const li=ln.match(/^[-•*]\s+(.*)/);
            if(li) return React.createElement('p',{key:j,style:{paddingLeft:'13px',position:'relative'}},
              React.createElement('span',{style:{position:'absolute',left:0,color:'var(--ac)',fontSize:'.58rem',top:'6px'}},'▸'),
              React.createElement('span',{dangerouslySetInnerHTML:{__html:iMd(li[1])}}));
            const h=ln.match(/^#{1,3}\s+(.*)/);
            if(h) return React.createElement('p',{key:j,style:{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:'.94rem'},
              dangerouslySetInnerHTML:{__html:iMd(h[1])}});
            return React.createElement('p',{key:j,dangerouslySetInnerHTML:{__html:iMd(ln)}});
          })
        );
      }))
    )
  );
});

/* ── Cache clear ── */
async function doClearCache(setMsg){
  setMsg('Clearing…');
  const out=[];
  try{
    if(window.caches){const ks=await caches.keys();for(const k of ks)await caches.delete(k);out.push(`${ks.length} cache(s)`);}
  }catch(e){}
  try{
    if(indexedDB.databases){
      const dbs=await indexedDB.databases();
      for(const d of dbs)await new Promise(r=>{const q=indexedDB.deleteDatabase(d.name);q.onsuccess=q.onerror=r;});
      out.push(`${dbs.length} IndexedDB(s)`);
    }
  }catch(e){}
  localStorage.removeItem(SAVED_KEY);
  window._DE=null;
  setMsg('Cleared '+(out.join(', ')||'storage')+'. Reload the page to re-download.');
}

/* ── Settings ── */
const Settings = ({onClose,theme,setTheme,autoOpen,setAutoOpen,model,onClear,onLoadModel,profile,setProfile}) => {
  const [cm,setCm]=useState('');
  const [cb,setCb]=useState(false);
  const doCache=async()=>{setCb(true);await doClearCache(setCm);setCb(false);};

  const profRow=(key)=>{
    const p=PROFILES[key]; const active=profile===key;
    return React.createElement('div',{key,
      className:`sp-row${active?' sp-row-active':''}`,
      style:{cursor:'pointer',marginBottom:5},
      onClick:()=>{localStorage.setItem(PROFILE_KEY,key);setProfile(key);}
    },
      React.createElement('div',{style:{display:'flex',alignItems:'center',gap:9}},
        React.createElement('span',{className:'material-symbols-outlined',style:{fontSize:18,color:active?'var(--ac)':'var(--sub)'}},p.icon),
        React.createElement('div',null,
          React.createElement('div',{className:'sp-rl',style:{color:active?'var(--tx)':'var(--sub)'}},p.label+(active?' ✓':'')),
          React.createElement('div',{className:'sp-rs'},
            `${p.maxTokens} max tokens · ${p.ctxLimit} msg context · yield every ${p.yieldEvery} token${p.yieldEvery>1?'s':''}`
          )
        )
      )
    );
  };

  return React.createElement('div',{className:'sov',onClick:e=>e.target===e.currentTarget&&onClose()},
    React.createElement('div',{className:'spanel'},
      React.createElement('div',{className:'sp-hd'},
        React.createElement('span',{className:'sp-title'},'Settings'),
        React.createElement('button',{className:'ibtn',onClick:onClose},
          React.createElement('span',{className:'material-symbols-outlined'},'close'))
      ),
      /* Performance */
      React.createElement('div',{className:'sp-sec'},
        React.createElement('div',{className:'sp-lbl'},'Performance Profile'),
        profRow('desktop'),
        profRow('mobile'),
        React.createElement('p',{style:{fontSize:'.7rem',color:'var(--sub2)',marginTop:6,lineHeight:1.5}},
          'Mobile: shorter responses, smaller context window sent to model, yield to browser every token to keep phone responsive. Desktop: full power.')
      ),
      /* Appearance */
      React.createElement('div',{className:'sp-sec'},
        React.createElement('div',{className:'sp-lbl'},'Appearance'),
        React.createElement('div',{className:'sp-row'},
          React.createElement('div',null,React.createElement('div',{className:'sp-rl'},'Light Theme')),
          React.createElement('div',{className:`tog${theme==='light'?' on':''}`,onClick:()=>setTheme(t=>t==='dark'?'light':'dark')})
        )
      ),
      /* Browser */
      React.createElement('div',{className:'sp-sec'},
        React.createElement('div',{className:'sp-lbl'},'Browser'),
        React.createElement('div',{className:'sp-row'},
          React.createElement('div',null,
            React.createElement('div',{className:'sp-rl'},'Auto-open Links'),
            React.createElement('div',{className:'sp-rs'},'URLs open automatically')),
          React.createElement('div',{className:`tog${autoOpen?' on':''}`,onClick:()=>setAutoOpen(v=>!v)})
        )
      ),
      /* Model */
      React.createElement('div',{className:'sp-sec'},
        React.createElement('div',{className:'sp-lbl'},'Model'),
        React.createElement('div',{className:'sp-row'},
          React.createElement('div',null,
            React.createElement('div',{className:'sp-rl'},model?.name||'No model loaded'),
            React.createElement('div',{className:'sp-rs'},model?.size||'')),
          model&&React.createElement('span',{className:'sp-model'},
            React.createElement('span',{className:'material-symbols-outlined'},'memory'),model.size)
        ),
        React.createElement('button',{className:'onb-btn primary',style:{width:'100%',marginTop:6},
          onClick:()=>{onClose();onLoadModel();}},model?'Switch Model':'Load Model')
      ),
      /* Data */
      React.createElement('div',{className:'sp-sec'},
        React.createElement('div',{className:'sp-lbl'},'Data'),
        React.createElement('button',{className:'danger-btn',style:{marginBottom:6},
          onClick:()=>{onClear();onClose();}},'Clear conversations'),
        React.createElement('button',{className:'danger-btn',disabled:cb,onClick:doCache},
          cb?'Clearing…':'Clear model cache'),
        cm&&React.createElement('p',{style:{fontSize:'.72rem',color:'var(--sub)',marginTop:6,lineHeight:1.5}},cm)
      )
    )
  );
};

/* ── Onboarding ── */
const SLIDES=[
  {icon:null,   hed:['Meet ',         React.createElement('em',{key:'e'},'DashAI.')],  sub:'A fast AI that lives in your browser — no accounts, no cloud after setup.',       feats:[{icon:'memory',label:'Runs on Your GPU'},{icon:'wifi_off',label:'Works Offline'},{icon:'tab',label:'Multi-tab Chats'}]},
  {icon:'bolt', hed:['Powered by ',   React.createElement('em',{key:'e'},'WebGPU.')],  sub:'Your GPU runs the model. Tokens stream word-by-word, just like ChatGPT.',         feats:[{icon:'speed',label:'Streams Token-by-Token'},{icon:'devices',label:'Chrome & Edge'},{icon:'code',label:'Writes Code'}]},
  {icon:'open_in_new',hed:['Open sites, ',React.createElement('em',{key:'e'},'instantly.')],sub:'Ask Dash to open any site — it figures out the URL.',feats:[{icon:'link',label:'Smart Links'},{icon:'search',label:'Search Anything'},{icon:'bolt',label:'Instant'}]},
];
const Onboarding=({onDone})=>{
  const[slide,setSlide]=useState(0);const[key,setKey]=useState(0);
  const go=n=>{setSlide(n);setKey(k=>k+1);};const s=SLIDES[slide];
  return React.createElement('div',{className:'onb'},
    React.createElement('div',{className:'onb-glow'}),
    React.createElement('div',{className:'onb-inner'},
      React.createElement('div',{key,className:'slide-content',style:{display:'flex',flexDirection:'column',alignItems:'center',width:'100%'}},
        React.createElement('div',{className:'onb-loader-wrap'},
          slide===0?React.createElement(Loader,{size:'loader-xl',cls:'pulsing'})
          :React.createElement('div',{style:{width:80,height:80,borderRadius:'50%',background:'var(--acd)',border:'1px solid var(--acb)',display:'flex',alignItems:'center',justifyContent:'center'}},
            React.createElement('span',{className:'material-symbols-outlined',style:{fontSize:38,color:'var(--ac)'}},s.icon))
        ),
        React.createElement('h1',{className:'onb-hed'},s.hed),
        React.createElement('p',{className:'onb-sub'},s.sub),
        React.createElement('div',{className:'feat-row'},s.feats.map((f,i)=>React.createElement('div',{key:i,className:'feat'},React.createElement('span',{className:'material-symbols-outlined'},f.icon),f.label)))
      ),
      React.createElement('div',{className:'onb-dots'},SLIDES.map((_,i)=>React.createElement('div',{key:i,className:`onb-dot${i===slide?' active':''}`,onClick:()=>go(i)}))),
      React.createElement('div',{className:'onb-btns'},
        slide>0&&React.createElement('button',{className:'onb-btn',onClick:()=>go(slide-1)},'Back'),
        React.createElement('button',{className:'onb-btn primary',onClick:()=>slide<SLIDES.length-1?go(slide+1):onDone()},
          slide===SLIDES.length-1?'Get Started →':'Next →')
      ),
      React.createElement('div',{className:'onb-skip',onClick:onDone},'Skip intro')
    )
  );
};

const ModelSelect=({onSelect,onSkip,gpuErr})=>
  React.createElement('div',{className:'msel'},
    React.createElement('div',{className:'msel-inner'},
      React.createElement('div',{className:'msel-loader'},React.createElement(Loader,{size:'loader-md'})),
      React.createElement('h2',{className:'msel-t'},'Choose your model'),
      React.createElement('p',{className:'msel-s'},'All models run locally via WebGPU.'),
      MODELS.map(m=>React.createElement('div',{key:m.id,className:'mcard',onClick:()=>onSelect(m)},
        React.createElement('div',null,
          React.createElement('h4',null,m.name),
          React.createElement('p',null,`${m.desc} · ${m.size}`)),
        React.createElement('span',{className:`mbadge ${m.bc}`},m.badge)
      )),
      gpuErr&&React.createElement('div',{className:'gpu-warn'},
        '⚠️ WebGPU unavailable. Use Chrome 113+ or Edge. Enable: ',
        React.createElement('code',null,'chrome://flags/#enable-unsafe-webgpu')),
      React.createElement('div',{className:'msel-skip',onClick:onSkip},'Try UI without a model')
    )
  );

/* ═══════════════════════════════════════════════════════════════
   MAIN APP
═══════════════════════════════════════════════════════════════ */
const App = () => {
  const savedId    = localStorage.getItem(SAVED_KEY);
  const savedModel = savedId ? MODELS.find(m=>m.id===savedId)||null : null;

  const [profile,  setProfile]  = useState(detectProfile);
  const [stage,    setStage]    = useState(savedModel?'loading':'onboarding');
  const [lpct,     setLpct]     = useState(0);
  const [eta,      setEta]      = useState('');
  const [convs,    setConvs]    = useState([{id:'c1',title:'Chat 1',msgs:[]}]);
  const [curId,    setCurId]    = useState('c1');
  const [q,        setQ]        = useState('');
  const [autoOpen, setAutoOpen] = useState(false);
  const [theme,    setTheme]    = useState('dark');
  const [sets,     setSets]     = useState(false);
  const [busy,     setBusy]     = useState(false);
  const [model,    setModel]    = useState(savedModel);
  const [gpuErr,   setGpuErr]   = useState(false);
  const [streamId, setStreamId] = useState(null);

  const liveTextRef  = useRef('');
  const endR         = useRef(null);
  const iRef         = useRef(null);
  const initedRef    = useRef(false);
  const loadStartRef = useRef(0);
  const lastProgressUpdate = useRef(0); // debounce progress callbacks

  const prof   = PROFILES[profile];
  const isMob  = profile === 'mobile';

  /* ── Viewport / keyboard resize ── */
  useEffect(()=>{
    const vv = window.visualViewport;
    if(!vv) return;
    const update = () => {
      const el = document.getElementById('inputz-bar');
      if(!el) return;
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      el.style.bottom = kb + 'px';
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return ()=>{ vv.removeEventListener('resize',update); vv.removeEventListener('scroll',update); };
  },[]);

  const cur  = convs.find(c=>c.id===curId)||convs[0];
  const msgs = cur?.msgs||[];

  useEffect(()=>{ if(!hasGPU()) setGpuErr(true); },[]);
  useEffect(()=>{ document.documentElement.classList.toggle('lt',theme==='light'); },[theme]);

  /* Scroll to bottom only when new message added (not every streaming tick) */
  const msgCountRef = useRef(0);
  useEffect(()=>{
    if(msgs.length !== msgCountRef.current){
      msgCountRef.current = msgs.length;
      endR.current?.scrollIntoView({behavior:'smooth'});
    }
  },[msgs]);

  /* Auto-load saved model on mount — once */
  useEffect(()=>{
    if(savedModel && !initedRef.current){ initedRef.current=true; initAI(savedModel); }
  },[]);

  const updateMsgs = (id,fn) => setConvs(cs=>cs.map(c=>c.id===id?{...c,msgs:fn(c.msgs)}:c));
  const newConv    = () => { const id=uid(); setConvs(cs=>[...cs,{id,title:`Chat ${cs.length+1}`,msgs:[]}]); setCurId(id); setTimeout(()=>iRef.current?.focus(),80); };
  const deleteConv = (id) => setConvs(cs=>{
    const nx=cs.filter(c=>c.id!==id);
    if(!nx.length){const nc={id:uid(),title:'Chat 1',msgs:[]};setCurId(nc.id);return[nc];}
    if(curId===id) setCurId(nx[nx.length-1].id);
    return nx;
  });

  async function initAI(m) {
    if(!hasGPU()){setGpuErr(true);setStage('modelselect');return;}
    setModel(m); setStage('loading'); setLpct(0); setEta('');
    loadStartRef.current = performance.now();

    /* Debounced progress — max 4 updates/sec to avoid React thrash during GPU init */
    const onProgress = (progress) => {
      const now = performance.now();
      if(now - lastProgressUpdate.current < 250 && progress < 0.99) return;
      lastProgressUpdate.current = now;

      const pct = Math.round(progress * 100);
      setLpct(pct);
      if(pct > 2 && pct < 99){
        const elapsed = (now - loadStartRef.current) / 1000;
        const bytesDown = (pct/100) * m.bytes;
        const speed = bytesDown / elapsed;
        const remaining = (m.bytes - bytesDown) / speed;
        if(remaining > 0 && isFinite(remaining)) setEta(fmtEta(remaining));
      }
      if(pct >= 99) setEta('');
    };

    try{
      await waitWLLM();
      const { CreateMLCEngine } = window.webllm;
      window._DE = await CreateMLCEngine(m.id, {
        initProgressCallback: r => onProgress(r.progress||0)
      });
      localStorage.setItem(SAVED_KEY, m.id);
      setEta(''); setStage('main');
      setTimeout(()=>iRef.current?.focus(), 120);
    } catch(e) {
      console.error(e);
      /* "Failed to add to cache" = Chromium IndexedDB bug.
         If _DE is non-null the engine is in memory and works fine. */
      const cacheErr = /cache|quota|storage|add to/i.test(e.message||'');
      if(cacheErr && window._DE){
        localStorage.setItem(SAVED_KEY, m.id);
        setEta(''); setStage('main');
        return;
      }
      window._DE = null;
      setStage('modelselect');
      if(!cacheErr) alert(`Could not load model: ${e.message}`);
    }
  }

  const skipToMain = () => { setStage('main'); setTimeout(()=>iRef.current?.focus(),80); };
  const primepopup = () => { window._popOk=true; };

  const send = async (override) => {
    const text = (override||q).trim();
    if(!text || busy) return;
    window._popOk = true;

    if(!window._DE){
      setQ('');
      if(!msgs.length) setConvs(cs=>cs.map(c=>c.id===curId?{...c,title:text.slice(0,34)}:c));
      updateMsgs(curId, m=>[...m,{id:uid(),role:'user',text}]);
      updateMsgs(curId, m=>[...m,{id:uid(),role:'ai',thinking:false,text:'__NO_MODEL__'}]);
      return;
    }

    setQ(''); setBusy(true);
    if(!msgs.length) setConvs(cs=>cs.map(c=>c.id===curId?{...c,title:text.length>34?text.slice(0,32)+'…':text}:c));

    const tid = uid();
    updateMsgs(curId, m=>[...m,{id:uid(),role:'user',text}]);
    updateMsgs(curId, m=>[...m,{id:tid,role:'ai',thinking:true,text:''}]);

    try{
      /* Build context — use ALL messages for display but limit what we send
         to the model to save tokens. Users can scroll and see everything. */
      const ctxMsgs = msgs
        .filter(m=>m.text && !m.thinking && m.text!=='__NO_MODEL__')
        .slice(-prof.ctxLimit)
        .map(m=>({role:m.role==='ai'?'assistant':'user', content:m.text}));

      const messages = [
        {role:'system', content:buildSys(autoOpen)},
        ...ctxMsgs,
        {role:'user', content:text}
      ];

      /* Switch thinking → streaming.
         CRITICAL ORDER: setStreamId FIRST so React knows to render StreamBubble
         before updateMsgs fires. If we flip thinking:false first with streamId=null,
         React renders a Bubble with empty text for one frame (the "paste" glitch). */
      liveTextRef.current = '';
      setStreamId(tid);
      updateMsgs(curId, m=>{
        const n=[...m]; const i=n.findIndex(x=>x.id===tid);
        if(i!==-1) n[i]={...n[i],thinking:false,text:''};
        return n;
      });

      const stream = await window._DE.chat.completions.create({
        messages,
        stream: true,
        max_tokens: prof.maxTokens,
        temperature: 0.7,
      });

      let acc = '';
      let tc  = 0; // token counter for yield frequency

      for await (const chunk of stream){
        const delta = chunk.choices[0]?.delta?.content||'';
        if(!delta) continue;

        acc += delta;
        liveTextRef.current = acc; // rAF in StreamingText picks this up
        tc++;

        /* Yield to browser every N tokens based on profile.
           This is the single most important line for mobile responsiveness.
           On mobile: yield every token = 1ms gaps for compositor.
           On desktop: yield every 2 tokens = still smooth, faster throughput. */
        if(tc % prof.yieldEvery === 0) await yieldFrame();
      }

      /* Stream complete — commit text FIRST, THEN clear streamId.
         This way when React re-renders after setStreamId(null),
         msg.text already has the full content and Bubble renders correctly. */
      liveTextRef.current = '';
      updateMsgs(curId, m=>{
        const n=[...m]; const i=n.findIndex(x=>x.id===tid);
        if(i!==-1) n[i]={...n[i],text:acc};
        return n;
      });
      setStreamId(null);

    } catch(e) {
      console.error(e);
      setStreamId(null);
      liveTextRef.current = '';
      const dead = /Tokenizer|deleted|not loaded/i.test(e.message||'');
      const errTxt = dead
        ? '⚠️ Model unloaded — go to Settings → Load Model.'
        : `⚠️ ${e.message}`;
      updateMsgs(curId, m=>{
        const n=[...m]; const i=n.findIndex(x=>x.id===tid);
        if(i!==-1) n[i]={...n[i],thinking:false,text:errTxt};
        return n;
      });
      if(dead){ window._DE=null; setModel(null); }
    }

    setBusy(false);
    setTimeout(()=>iRef.current?.focus(), 50);
  };

  const onKey = e => { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();} };
  const latestAI = (()=>{ for(let i=msgs.length-1;i>=0;i--) if(msgs[i].role==='ai') return i; return -1; })();

  /* ── Stage gates ── */
  if(stage==='onboarding')  return React.createElement(Onboarding, {onDone:()=>setStage('modelselect')});
  if(stage==='modelselect') return React.createElement(ModelSelect, {onSelect:initAI,onSkip:skipToMain,gpuErr});

  if(stage==='loading') return React.createElement('div',{className:'ldr'},
    React.createElement(Loader,{size:'loader-xl'}),
    React.createElement('div',{className:'ptrack',style:{marginTop:26}},
      React.createElement('div',{className:'pfill',style:{width:`${lpct}%`}})
    ),
    React.createElement('p',{className:'ldr-eta'},
      lpct>0&&lpct<100 ? `${lpct}%${eta?' · ~'+eta+' left':''}` :
      lpct>=100 ? 'Finalizing…' : 'Starting…'
    )
  );

  /* ── Main UI ── */
  const engineOk = !!window._DE;
  const noModelBanner = !engineOk && React.createElement('div',{className:'no-model-banner'},
    React.createElement('div',{className:'no-model-pill',onClick:()=>setStage('modelselect')},
      React.createElement('span',{className:'material-symbols-outlined',style:{fontSize:14}},'download'),
      'No AI model — tap to load'
    )
  );

  return React.createElement(React.Fragment, null,
    sets&&React.createElement(Settings,{onClose:()=>setSets(false),theme,setTheme,autoOpen,setAutoOpen,
      model,onLoadModel:()=>setStage('modelselect'),
      onClear:()=>{const id=uid();setConvs([{id,title:'Chat 1',msgs:[]}]);setCurId(id);},
      profile,setProfile
    }),
    noModelBanner,

    /* NAV */
    React.createElement('nav',{className:'nav'},
      React.createElement('div',{className:'nav-brand'},
        React.createElement(Loader,{size:'loader-nav',cls:busy?'pulsing':''}),
        React.createElement('span',{className:'wordmark'},'DashAI')
      ),
      React.createElement('div',{className:'nav-gap'}),
      React.createElement('div',{className:'nav-r'},
        React.createElement('a',{href:'index.html',className:'home-btn'},
          React.createElement('span',{className:'material-symbols-outlined'},'home'),'Home'),
        React.createElement('div',{className:`auto-pill${autoOpen?' on':''}`,onClick:()=>{setAutoOpen(v=>!v);primepopup();}},
          React.createElement('span',{className:'material-symbols-outlined'},autoOpen?'link':'link_off'),
          React.createElement('span',{className:'label'},'Auto-open'),
          React.createElement('div',{className:`tog-sm${autoOpen?' on':''}`})
        ),
        React.createElement('div',{className:'profile-badge',title:`${prof.label} mode`,onClick:()=>setSets(true)},
          React.createElement('span',{className:'material-symbols-outlined'},prof.icon)
        ),
        React.createElement('button',{className:'ibtn',onClick:()=>setSets(true)},
          React.createElement('span',{className:'material-symbols-outlined'},'settings'))
      )
    ),

    /* TABS */
    React.createElement('div',{className:'tabs-bar'},
      convs.map(c=>React.createElement('div',{key:c.id,className:`tab${c.id===curId?' active':''}`,onClick:()=>setCurId(c.id)},
        React.createElement('span',{className:'tab-title'},c.title),
        React.createElement('span',{className:'tab-x',onClick:e=>{e.stopPropagation();deleteConv(c.id);}},
          React.createElement('span',{className:'material-symbols-outlined'},'close'))
      )),
      React.createElement('div',{className:'new-tab',onClick:newConv},
        React.createElement('span',{className:'material-symbols-outlined'},'add'))
    ),

    React.createElement('div',{className:'top-ad'},'ads go here'),

    React.createElement('div',{className:'layout'},
      React.createElement('div',{className:'chat-col'},
        React.createElement('div',{className:'msgs'},
          msgs.length===0
            ? React.createElement('div',{className:'welcome'},
                React.createElement('div',{className:'w-loader'},
                  React.createElement(Loader,{size:'loader-xl',cls:engineOk?'pulsing':''})),
                React.createElement('h2',{className:'wt'},"Hey, I'm Dash."),
                React.createElement('p',{className:'ws'},engineOk?'Ask me anything. Open websites. Write code.':'Load a model to get started.'),
                React.createElement('div',{className:'chips'},CHIPS.map(c=>
                  React.createElement('div',{key:c,className:'chip',onClick:()=>{primepopup();send(c);}},c)))
              )
            : React.createElement('div',{className:'mlist'},
                msgs.map((msg,i)=>{
                  if(msg.role==='ai'&&msg.text==='__NO_MODEL__') return React.createElement('div',{key:msg.id||i,className:'mrow a'},
                    React.createElement('div',{className:'bub a'},
                      React.createElement('div',{className:'no-model-warn'},
                        React.createElement('span',{className:'material-symbols-outlined'},'warning'),
                        React.createElement('span',null,'No model. ',
                          React.createElement('span',{style:{color:'var(--ac)',cursor:'pointer',textDecoration:'underline'},
                            onClick:()=>setStage('modelselect')},'Load one here'),'.')
                      )
                    )
                  );
                  if(msg.id===streamId) return React.createElement(StreamBubble,{key:msg.id,textRef:liveTextRef,isMob});
                  return React.createElement(Bubble,{key:msg.id||i,msg,isLatest:i===latestAI,autoOpen});
                }),
                React.createElement('div',{ref:endR})
              )
        ),

        /* INPUT */
        React.createElement('div',{id:'inputz-bar',className:'inputz'},
          React.createElement('div',{className:'ibar'},
            React.createElement('div',{style:{flexShrink:0,opacity:.5,display:'flex',alignItems:'center'}},
              React.createElement(Loader,{size:'loader-inp',cls:busy?'pulsing':''})),
            React.createElement('input',{ref:iRef,
              placeholder:engineOk?'Ask Dash anything…':'No model — tap banner to load',
              value:q, onChange:e=>setQ(e.target.value), onKeyDown:onKey,
              onFocus:primepopup, disabled:busy})
          ),
          React.createElement('button',{className:'sbtn',onClick:()=>{primepopup();send();},disabled:busy||!q.trim()},
            React.createElement('span',{className:'material-symbols-outlined'},busy?'stop_circle':'arrow_upward'))
        )
      ),
      React.createElement('div',{className:'ad-col'},
        React.createElement('div',{className:'ad-block'},'ads go here'),
        React.createElement('div',{className:'ad-block-sm'},'ads go here')
      )
    ),
    React.createElement('div',{className:'mobile-ad-bottom'},'ads go here')
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
