/* DashAI — app.js v8 */
const { useState, useEffect, useRef } = React;

/* ── Models ── */
const MODELS = [
  { id:'SmolLM2-360M-Instruct-q4f16_1-MLC', name:'DashNano', desc:'Ultralight · 360M params', size:'~200 MB', badge:'Mobile', bc:'mb-n', bytes:200e6 },
  { id:'Llama-3.2-1B-Instruct-q4f16_1-MLC', name:'DashLite', desc:'Fast & light · 1.2B params', size:'~700 MB', badge:'Recommended', bc:'mb-r', bytes:700e6 },
  { id:'Llama-3.2-3B-Instruct-q4f16_1-MLC', name:'DashMid',  desc:'Balanced · 3B params', size:'~2 GB', badge:'Balanced', bc:'mb-b', bytes:2e9 },
  { id:'Llama-3.1-8B-Instruct-q4f16_1-MLC', name:'DashPro',  desc:'Maximum power · 8B params', size:'~5 GB', badge:'Heavy', bc:'mb-h', bytes:5e9 },
];
const LANG_EXT = {python:'py',javascript:'js',typescript:'ts',html:'html',css:'css',bash:'sh',json:'json',java:'java',cpp:'cpp',c:'c',rust:'rs',go:'go',ruby:'rb',php:'php',sql:'sql',plaintext:'txt'};
const CHIPS = ['Who are you?','Open YouTube','Open GitHub','Write a Python scraper','Explain WebGPU','Show a glass card CSS','Open Hacker News'];
const SAVED_KEY = 'dashai_last_model';
const PROFILE_KEY = 'dashai_profile';

/* ── Performance profiles ── */
const isMob = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 680;
const detectProfile = () => localStorage.getItem(PROFILE_KEY) || (isMob() ? 'mobile' : 'desktop');
const PROFILES = {
  desktop: { label:'Desktop', icon:'computer',     maxTokens:1024, ctxLimit:16, yieldEvery:2 },
  mobile:  { label:'Mobile',  icon:'phone_android', maxTokens:512,  ctxLimit:8,  yieldEvery:1 },
};

/* ── Engine singleton ── */
if (!window._DE) window._DE = null;

/* ── Yield to compositor between tokens ── */
const yieldFrame = () => new Promise(r => {
  if (typeof scheduler !== 'undefined' && scheduler.yield) { scheduler.yield().then(r); return; }
  const mc = new MessageChannel(); mc.port1.onmessage = r; mc.port2.postMessage(null);
});

const waitWLLM = () => new Promise(r => { if (window._wllm) r(); else window.addEventListener('wllm', r, {once:true}); });
const hasGPU = () => !!navigator.gpu;
const uid = () => Math.random().toString(36).slice(2,9);
const fmtEta = s => s < 60 ? `${Math.round(s)}s` : `${Math.floor(s/60)}m ${Math.round(s%60)}s`;

const buildSys = ao =>
`You are Dash, an on-device AI inside DashAI — runs locally via WebGPU in the browser.
IDENTITY: Your name is Dash. If asked, say "I'm Dash, an on-device AI."
OPENING WEBSITES: Wrap any URL in asterisks: *https://site.com*
DashAI ${ao?'opens them automatically.':'shows a tap-to-open button.'}
Examples: "open youtube" → *https://youtube.com* · "search dogs" → *https://google.com/search?q=dogs*
Rules: 1) Always full URL with asterisks 2) Inline with text 3) Don't explain unless asked
CODE: fenced blocks with language tag. STYLE: concise and direct, no filler phrases.`;

/* ── Markdown / URL parsing ── */
function parseAI(raw) {
  const cmds = [];
  let text = raw.replace(/\*(https?:\/\/[^\s*]+)\*/g, (_,u)=>{ cmds.push(u); return ''; });
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

/* ══════════════════════════════════════════════════════════════
   STREAMING TEXT
   
   THE BUG: .btxt had display:flex + flex-direction:column which
   made every inline <span> stack vertically like a column.
   
   FIX: The streaming container is display:block (inline text flow).
   We append text nodes directly — no per-word spans at all during
   streaming. This is the simplest, fastest, most correct approach:
   just a <p> that gets .textContent updated each frame.
   On desktop we keep the word-fade by cloning completed words into
   animated spans, but the layout container is always block-level.
══════════════════════════════════════════════════════════════ */
const StreamingText = ({ textRef, mobile }) => {
  const pRef = useRef(null);
  const lastLen = useRef(0);

  useEffect(() => {
    const el = pRef.current;
    if (!el) return;
    let raf;

    const tick = () => {
      const text = textRef.current || '';
      if (text.length !== lastLen.current) {
        // Simplest correct approach: just set textContent.
        // This gives perfectly normal inline text flow with no glitches.
        // Words wrap naturally, no column stacking, no "paste then pop".
        el.textContent = text;
        lastLen.current = text.length;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return React.createElement('p', { className: 'stream-p', ref: pRef });
};

const StreamBubble = ({ textRef, mobile }) =>
  React.createElement('div', { className: 'mrow a' },
    React.createElement('div', { className: 'bub a' },
      React.createElement(StreamingText, { textRef, mobile })
    )
  );

/* ── Loader ── */
const Loader = ({size='loader-md', cls=''}) =>
  React.createElement('div',{className:`loader ${size} ${cls}`},
    React.createElement('div',{className:'inner one'}),
    React.createElement('div',{className:'inner two'}),
    React.createElement('div',{className:'inner three'})
  );

/* ── Code block ── */
const CodeWidget = ({lang, code}) => {
  const [ok,setOk]=useState(false);
  const ref=useRef(null);
  useEffect(()=>{if(ref.current&&window.Prism){const el=ref.current.querySelector('code');if(el)Prism.highlightElement(el);}},[code]);
  const copy=()=>navigator.clipboard.writeText(code).then(()=>{setOk(true);setTimeout(()=>setOk(false),2000);});
  const dl=()=>{const ext=LANG_EXT[lang.toLowerCase()]||'txt';const a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(new Blob([code],{type:'text/plain'})),download:`snippet.${ext}`});a.click();URL.revokeObjectURL(a.href);};
  return React.createElement('div',{className:'cw'},
    React.createElement('div',{className:'cw-h'},
      React.createElement('span',{className:'cw-lang'},lang||'code'),
      React.createElement('div',{className:'cw-btns'},
        React.createElement('button',{className:`cw-btn${ok?' ok':''}`,onClick:copy},React.createElement('span',{className:'material-symbols-outlined'},ok?'check':'content_copy'),ok?'Copied!':'Copy'),
        React.createElement('button',{className:'cw-btn',onClick:dl},React.createElement('span',{className:'material-symbols-outlined'},'download'),'Save')
      )
    ),
    React.createElement('div',{className:'cw-body',ref},React.createElement('pre',{className:`language-${lang}`},React.createElement('code',{className:`language-${lang}`},code)))
  );
};

const CmdBtn = ({url}) => {
  const p=url.replace(/^https?:\/\/(www\.)?/,'').replace(/\/$/,'');
  return React.createElement('a',{className:'cmdbtn',href:url,target:'_blank',rel:'noopener',onClick:e=>{e.preventDefault();safeOpen(url);}},
    React.createElement('span',{className:'material-symbols-outlined'},'open_in_new'),`Open ${p}`);
};

/* ── Static finished bubble ── */
const Bubble = React.memo(({msg, isLatest, autoOpen}) => {
  const firedRef = useRef(false);
  useEffect(()=>{
    if(autoOpen&&isLatest&&msg.role==='ai'&&msg.text&&!firedRef.current){
      const hits=[...msg.text.matchAll(/\*(https?:\/\/[^\s*]+)\*/g)];
      if(hits.length){firedRef.current=true;hits.forEach(([,url],i)=>setTimeout(()=>safeOpen(url),200+i*200));}
    }
  },[autoOpen,isLatest,msg.text]);

  if(msg.role==='user') return React.createElement('div',{className:'mrow u'},React.createElement('div',{className:'bub u'},msg.text));
  if(msg.thinking) return React.createElement('div',{className:'mrow a'},React.createElement('div',{className:'bub a think'},React.createElement('div',{className:'dots'},React.createElement('i'),React.createElement('i'),React.createElement('i'))));

  const segs=parseAI(msg.text||'');
  return React.createElement('div',{className:'mrow a'},
    React.createElement('div',{className:'bub a'},
      segs.map((s,i)=>{
        if(s.t==='code') return React.createElement(CodeWidget,{key:i,lang:s.lang,code:s.v});
        if(s.t==='cmd')  return React.createElement(CmdBtn,{key:i,url:s.v});
        // Text: render as paragraphs with inline markdown
        return React.createElement('div',{key:i,className:'btxt'},
          s.v.split('\n').map((ln,j)=>{
            if(!ln.trim()) return null;
            const li=ln.match(/^[-•*]\s+(.*)/);
            if(li) return React.createElement('p',{key:j,className:'bline'},
              React.createElement('span',{className:'bull'},'▸'),
              React.createElement('span',{dangerouslySetInnerHTML:{__html:iMd(li[1])}}));
            const h=ln.match(/^#{1,3}\s+(.*)/);
            if(h) return React.createElement('p',{key:j,className:'bhead',dangerouslySetInnerHTML:{__html:iMd(h[1])}});
            return React.createElement('p',{key:j,dangerouslySetInnerHTML:{__html:iMd(ln)}});
          })
        );
      })
    )
  );
});

/* ── Cache clear ── */
async function doClearCache(setMsg){
  setMsg('Clearing…');
  const out=[];
  try{if(window.caches){const ks=await caches.keys();for(const k of ks)await caches.delete(k);out.push(`${ks.length} cache(s)`);}}catch(e){}
  try{if(indexedDB.databases){const dbs=await indexedDB.databases();for(const d of dbs)await new Promise(r=>{const q=indexedDB.deleteDatabase(d.name);q.onsuccess=q.onerror=r;});out.push(`${dbs.length} IDB store(s)`);}}catch(e){}
  localStorage.removeItem(SAVED_KEY);
  window._DE=null;
  setMsg('Cleared '+(out.join(' & ')||'storage')+'. Reload to re-download model.');
}

/* ══════════════════════════════════════════════════════════════
   SETTINGS — full slide-in page, no modal/overlay/border
══════════════════════════════════════════════════════════════ */
const Settings = ({onClose,theme,setTheme,autoOpen,setAutoOpen,model,onClear,onLoadModel,profile,setProfile}) => {
  const [cm,setCm]=useState('');
  const [cb,setCb]=useState(false);
  const doCache=async()=>{setCb(true);await doClearCache(setCm);setCb(false);};

  const profBtn=(key)=>{
    const p=PROFILES[key]; const active=profile===key;
    return React.createElement('button',{
      key, className:`prof-btn${active?' active':''}`,
      onClick:()=>{localStorage.setItem(PROFILE_KEY,key);setProfile(key);}
    },
      React.createElement('span',{className:'material-symbols-outlined'},p.icon),
      React.createElement('div',{className:'prof-btn-text'},
        React.createElement('span',{className:'prof-btn-label'},p.label),
        React.createElement('span',{className:'prof-btn-sub'},key==='mobile'?`${p.maxTokens} tokens · ${p.ctxLimit} msg ctx · yield every token`:`${p.maxTokens} tokens · ${p.ctxLimit} msg ctx · full quality`)
      ),
      active&&React.createElement('span',{className:'material-symbols-outlined prof-check'},'check_circle')
    );
  };

  return React.createElement('div',{className:'settings-page'},
    /* Header */
    React.createElement('div',{className:'sp-topbar'},
      React.createElement('button',{className:'sp-back',onClick:onClose},
        React.createElement('span',{className:'material-symbols-outlined'},'arrow_back'),
        'Back'
      ),
      React.createElement('span',{className:'sp-title'},'Settings')
    ),

    React.createElement('div',{className:'sp-body'},

      /* Performance */
      React.createElement('div',{className:'sp-sec'},
        React.createElement('div',{className:'sp-lbl'},'Performance'),
        React.createElement('div',{className:'prof-row'},profBtn('desktop'),profBtn('mobile')),
        React.createElement('p',{className:'sp-hint'},'Mobile mode limits response length and yields to browser every token to keep your phone smooth.')
      ),

      /* Appearance */
      React.createElement('div',{className:'sp-sec'},
        React.createElement('div',{className:'sp-lbl'},'Appearance'),
        React.createElement('div',{className:'sp-row'},
          React.createElement('div',null,React.createElement('div',{className:'sp-rl'},'Light Theme'),React.createElement('div',{className:'sp-rs'},'Switch to light colour scheme')),
          React.createElement('div',{className:`tog${theme==='light'?' on':''}`,onClick:()=>setTheme(t=>t==='dark'?'light':'dark')})
        )
      ),

      /* Browser */
      React.createElement('div',{className:'sp-sec'},
        React.createElement('div',{className:'sp-lbl'},'Browser'),
        React.createElement('div',{className:'sp-row'},
          React.createElement('div',null,React.createElement('div',{className:'sp-rl'},'Auto-open Links'),React.createElement('div',{className:'sp-rs'},'Open URLs automatically when Dash mentions them')),
          React.createElement('div',{className:`tog${autoOpen?' on':''}`,onClick:()=>setAutoOpen(v=>!v)})
        )
      ),

      /* Model */
      React.createElement('div',{className:'sp-sec'},
        React.createElement('div',{className:'sp-lbl'},'Model'),
        React.createElement('div',{className:'sp-model-card'},
          React.createElement('div',null,
            React.createElement('div',{className:'sp-rl'},model?.name||'No model loaded'),
            React.createElement('div',{className:'sp-rs'},model?`${model.desc} · ${model.size}`:'Tap below to load a model')
          ),
          model&&React.createElement('span',{className:'sp-mbadge'},model.size)
        ),
        React.createElement('button',{className:'sp-action-btn',onClick:()=>{onClose();onLoadModel();}},
          React.createElement('span',{className:'material-symbols-outlined'},'swap_horiz'),
          model?'Switch Model':'Load Model'
        )
      ),

      /* Data */
      React.createElement('div',{className:'sp-sec'},
        React.createElement('div',{className:'sp-lbl'},'Data'),
        React.createElement('button',{className:'sp-action-btn danger',style:{marginBottom:8},onClick:()=>{onClear();onClose();}},
          React.createElement('span',{className:'material-symbols-outlined'},'delete_sweep'),
          'Clear all conversations'
        ),
        React.createElement('button',{className:'sp-action-btn danger',disabled:cb,onClick:doCache},
          React.createElement('span',{className:'material-symbols-outlined'},cb?'hourglass_empty':'delete'),
          cb?'Clearing cache…':'Clear model cache'
        ),
        cm&&React.createElement('p',{className:'sp-hint',style:{marginTop:8}},cm)
      ),

      /* About */
      React.createElement('div',{className:'sp-sec'},
        React.createElement('div',{className:'sp-lbl'},'About'),
        React.createElement('div',{className:'sp-about'},
          React.createElement('p',null,'DashAI runs AI entirely on your device using WebGPU. No data leaves your browser.'),
          React.createElement('a',{href:'privacy.html',className:'sp-link'},'Privacy Policy'),
          React.createElement('a',{href:'https://mlc.ai',target:'_blank',rel:'noopener',className:'sp-link'},'Powered by MLC / WebLLM')
        )
      )
    )
  );
};

/* ── Onboarding ── */
const SLIDES=[
  {icon:null,   hed:['Meet ',React.createElement('em',{key:'e'},'DashAI.')],  sub:'A fast AI that lives in your browser — no accounts, no cloud after setup.',    feats:[{icon:'memory',label:'Runs on Your GPU'},{icon:'wifi_off',label:'Works Offline'},{icon:'tab',label:'Multi-tab Chats'}]},
  {icon:'bolt', hed:['Powered by ',React.createElement('em',{key:'e'},'WebGPU.')], sub:'Your GPU runs the model. Tokens stream word by word, just like ChatGPT.', feats:[{icon:'speed',label:'Streams Token-by-Token'},{icon:'devices',label:'Chrome & Edge'},{icon:'code',label:'Writes Code'}]},
  {icon:'open_in_new',hed:['Open sites, ',React.createElement('em',{key:'e'},'instantly.')],sub:'Ask Dash to open any site — it figures out the URL.',feats:[{icon:'link',label:'Smart Links'},{icon:'search',label:'Search Anything'},{icon:'bolt',label:'Instant'}]},
];
const Onboarding=({onDone})=>{
  const[slide,setSlide]=useState(0);const[key,setKey]=useState(0);
  const go=n=>{setSlide(n);setKey(k=>k+1);};const s=SLIDES[slide];
  return React.createElement('div',{className:'onb'},
    React.createElement('div',{className:'onb-glow'}),
    React.createElement('div',{className:'onb-inner'},
      React.createElement('div',{key,className:'slide-content'},
        React.createElement('div',{className:'onb-loader-wrap'},
          slide===0
            ?React.createElement(Loader,{size:'loader-xl',cls:'pulsing'})
            :React.createElement('div',{className:'onb-icon-wrap'},React.createElement('span',{className:'material-symbols-outlined',style:{fontSize:38,color:'var(--ac)'}},s.icon))
        ),
        React.createElement('h1',{className:'onb-hed'},s.hed),
        React.createElement('p',{className:'onb-sub'},s.sub),
        React.createElement('div',{className:'feat-row'},s.feats.map((f,i)=>React.createElement('div',{key:i,className:'feat'},React.createElement('span',{className:'material-symbols-outlined'},f.icon),f.label)))
      ),
      React.createElement('div',{className:'onb-dots'},SLIDES.map((_,i)=>React.createElement('div',{key:i,className:`onb-dot${i===slide?' active':''}`,onClick:()=>go(i)}))),
      React.createElement('div',{className:'onb-btns'},
        slide>0&&React.createElement('button',{className:'onb-btn',onClick:()=>go(slide-1)},'Back'),
        React.createElement('button',{className:'onb-btn primary',onClick:()=>slide<SLIDES.length-1?go(slide+1):onDone()},slide===SLIDES.length-1?'Get Started →':'Next →')
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
      React.createElement('p',{className:'msel-s'},'All models run locally via WebGPU — no data leaves your device.'),
      MODELS.map(m=>React.createElement('div',{key:m.id,className:'mcard',onClick:()=>onSelect(m)},
        React.createElement('div',null,React.createElement('h4',null,m.name),React.createElement('p',null,`${m.desc} · ${m.size}`)),
        React.createElement('span',{className:`mbadge ${m.bc}`},m.badge)
      )),
      gpuErr&&React.createElement('div',{className:'gpu-warn'},'⚠️ WebGPU unavailable. Use Chrome 113+ or Edge 113+.'),
      React.createElement('div',{className:'msel-skip',onClick:onSkip},'Try without a model')
    )
  );

/* ══════════════════════════════════════════════════════════════
   MAIN APP
══════════════════════════════════════════════════════════════ */
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

  const liveTextRef   = useRef('');
  const endR          = useRef(null);
  const iRef          = useRef(null);
  const initedRef     = useRef(false);
  const loadStartRef  = useRef(0);
  const lastProg      = useRef(0);
  const msgCountRef   = useRef(0);

  const prof    = PROFILES[profile];
  const mobile  = profile === 'mobile';

  /* keyboard resize */
  useEffect(()=>{
    const vv=window.visualViewport; if(!vv) return;
    const up=()=>{ const el=document.getElementById('inputz-bar'); if(!el) return; el.style.bottom=Math.max(0,window.innerHeight-vv.height-vv.offsetTop)+'px'; };
    vv.addEventListener('resize',up); vv.addEventListener('scroll',up);
    return()=>{ vv.removeEventListener('resize',up); vv.removeEventListener('scroll',up); };
  },[]);

  const cur  = convs.find(c=>c.id===curId)||convs[0];
  const msgs = cur?.msgs||[];

  useEffect(()=>{ if(!hasGPU()) setGpuErr(true); },[]);
  useEffect(()=>{ document.documentElement.classList.toggle('lt',theme==='light'); },[theme]);

  /* scroll only on new message, not every stream tick */
  useEffect(()=>{
    if(msgs.length!==msgCountRef.current){ msgCountRef.current=msgs.length; endR.current?.scrollIntoView({behavior:'smooth'}); }
  },[msgs]);

  /* auto-load on mount */
  useEffect(()=>{
    if(savedModel&&!initedRef.current){ initedRef.current=true; initAI(savedModel); }
  },[]);

  const updateMsgs=(id,fn)=>setConvs(cs=>cs.map(c=>c.id===id?{...c,msgs:fn(c.msgs)}:c));
  const newConv=()=>{ const id=uid(); setConvs(cs=>[...cs,{id,title:`Chat ${cs.length+1}`,msgs:[]}]); setCurId(id); setTimeout(()=>iRef.current?.focus(),80); };
  const deleteConv=id=>setConvs(cs=>{ const nx=cs.filter(c=>c.id!==id); if(!nx.length){const nc={id:uid(),title:'Chat 1',msgs:[]};setCurId(nc.id);return[nc];} if(curId===id)setCurId(nx[nx.length-1].id); return nx; });

  async function initAI(m) {
    if(!hasGPU()){setGpuErr(true);setStage('modelselect');return;}
    setModel(m); setStage('loading'); setLpct(0); setEta('');
    loadStartRef.current=performance.now();

    const onProgress=progress=>{
      const now=performance.now();
      if(now-lastProg.current<250&&progress<0.99) return;
      lastProg.current=now;
      const pct=Math.round(progress*100); setLpct(pct);
      if(pct>2&&pct<99){
        const el=(now-loadStartRef.current)/1000;
        const bd=(pct/100)*m.bytes; const sp=bd/el; const rem=(m.bytes-bd)/sp;
        if(rem>0&&isFinite(rem)) setEta(fmtEta(rem));
      }
      if(pct>=99) setEta('');
    };

    try{
      await waitWLLM();
      const{CreateMLCEngine}=window.webllm;
      window._DE=await CreateMLCEngine(m.id,{initProgressCallback:r=>onProgress(r.progress||0)});
      localStorage.setItem(SAVED_KEY,m.id);
      setEta(''); setStage('main');
      setTimeout(()=>iRef.current?.focus(),120);
    }catch(e){
      console.error(e);
      const cacheErr=/cache|quota|storage|add to/i.test(e.message||'');
      if(cacheErr&&window._DE){localStorage.setItem(SAVED_KEY,m.id);setEta('');setStage('main');return;}
      window._DE=null; setStage('modelselect');
      if(!cacheErr) alert(`Could not load model: ${e.message}`);
    }
  }

  const skipToMain=()=>{ setStage('main'); setTimeout(()=>iRef.current?.focus(),80); };
  const primepopup=()=>{ window._popOk=true; };

  const send=async(override)=>{
    const text=(override||q).trim();
    if(!text||busy) return;
    window._popOk=true;

    if(!window._DE){
      setQ('');
      if(!msgs.length) setConvs(cs=>cs.map(c=>c.id===curId?{...c,title:text.slice(0,34)}:c));
      updateMsgs(curId,m=>[...m,{id:uid(),role:'user',text}]);
      updateMsgs(curId,m=>[...m,{id:uid(),role:'ai',thinking:false,text:'__NO_MODEL__'}]);
      return;
    }

    setQ(''); setBusy(true);
    if(!msgs.length) setConvs(cs=>cs.map(c=>c.id===curId?{...c,title:text.length>34?text.slice(0,32)+'…':text}:c));

    const tid=uid();
    updateMsgs(curId,m=>[...m,{id:uid(),role:'user',text}]);
    updateMsgs(curId,m=>[...m,{id:tid,role:'ai',thinking:true,text:''}]);

    try{
      const ctxMsgs=msgs
        .filter(m=>m.text&&!m.thinking&&m.text!=='__NO_MODEL__')
        .slice(-prof.ctxLimit)
        .map(m=>({role:m.role==='ai'?'assistant':'user',content:m.text}));
      const messages=[{role:'system',content:buildSys(autoOpen)},...ctxMsgs,{role:'user',content:text}];

      liveTextRef.current='';
      /* Set streamId BEFORE flipping thinking:false so first render is already StreamBubble */
      setStreamId(tid);
      updateMsgs(curId,m=>{ const n=[...m]; const i=n.findIndex(x=>x.id===tid); if(i!==-1) n[i]={...n[i],thinking:false,text:''}; return n; });

      const stream=await window._DE.chat.completions.create({
        messages, stream:true, max_tokens:prof.maxTokens, temperature:0.7,
      });

      let acc='', tc=0;
      for await(const chunk of stream){
        const delta=chunk.choices[0]?.delta?.content||'';
        if(!delta) continue;
        acc+=delta;
        liveTextRef.current=acc;
        tc++;
        if(tc%prof.yieldEvery===0) await yieldFrame();
      }

      /* Commit text FIRST, then clear streamId — no flash of empty Bubble */
      liveTextRef.current='';
      updateMsgs(curId,m=>{ const n=[...m]; const i=n.findIndex(x=>x.id===tid); if(i!==-1) n[i]={...n[i],text:acc}; return n; });
      setStreamId(null);

    }catch(e){
      console.error(e);
      liveTextRef.current='';
      const dead=/Tokenizer|deleted|not loaded/i.test(e.message||'');
      updateMsgs(curId,m=>{ const n=[...m]; const i=n.findIndex(x=>x.id===tid); if(i!==-1) n[i]={...n[i],thinking:false,text:dead?'⚠️ Model unloaded — go to Settings → Load Model.':`⚠️ ${e.message}`}; return n; });
      setStreamId(null);
      if(dead){window._DE=null;setModel(null);}
    }

    setBusy(false);
    setTimeout(()=>iRef.current?.focus(),50);
  };

  const onKey=e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();} };
  const latestAI=(()=>{ for(let i=msgs.length-1;i>=0;i--) if(msgs[i].role==='ai') return i; return -1; })();

  /* ── Stage gates ── */
  if(stage==='onboarding')  return React.createElement(Onboarding,{onDone:()=>setStage('modelselect')});
  if(stage==='modelselect') return React.createElement(ModelSelect,{onSelect:initAI,onSkip:skipToMain,gpuErr});
  if(stage==='loading') return React.createElement('div',{className:'ldr'},
    React.createElement(Loader,{size:'loader-xl'}),
    React.createElement('div',{className:'ptrack',style:{marginTop:26}},React.createElement('div',{className:'pfill',style:{width:`${lpct}%`}})),
    React.createElement('p',{className:'ldr-eta'},lpct>0&&lpct<100?`${lpct}%${eta?' · ~'+eta+' left':''}`:lpct>=100?'Finalizing…':'Starting…')
  );

  /* Settings page — slides over entire UI */
  if(sets) return React.createElement(Settings,{
    onClose:()=>setSets(false),theme,setTheme,autoOpen,setAutoOpen,model,
    onLoadModel:()=>setStage('modelselect'),
    onClear:()=>{ const id=uid(); setConvs([{id,title:'Chat 1',msgs:[]}]); setCurId(id); },
    profile,setProfile
  });

  /* ── Main chat UI ── */
  const engineOk=!!window._DE;
  const noModelBanner=!engineOk&&React.createElement('div',{className:'no-model-banner'},
    React.createElement('div',{className:'no-model-pill',onClick:()=>setStage('modelselect')},
      React.createElement('span',{className:'material-symbols-outlined',style:{fontSize:14}},'download'),'No AI model — tap to load'
    )
  );

  return React.createElement(React.Fragment,null,
    noModelBanner,

    /* NAV */
    React.createElement('nav',{className:'nav'},
      React.createElement('div',{className:'nav-brand'},
        React.createElement(Loader,{size:'loader-nav',cls:busy?'pulsing':''}),
        React.createElement('span',{className:'wordmark'},'DashAI')
      ),
      React.createElement('div',{className:'nav-gap'}),
      React.createElement('div',{className:'nav-r'},
        React.createElement('a',{href:'index.html',className:'home-btn'},React.createElement('span',{className:'material-symbols-outlined'},'home'),'Home'),
        React.createElement('div',{className:`auto-pill${autoOpen?' on':''}`,onClick:()=>{setAutoOpen(v=>!v);primepopup();}},
          React.createElement('span',{className:'material-symbols-outlined'},autoOpen?'link':'link_off'),
          React.createElement('span',{className:'label'},'Auto-open'),
          React.createElement('div',{className:`tog-sm${autoOpen?' on':''}`})
        ),
        React.createElement('button',{className:'ibtn',title:`${PROFILES[profile].label} mode`,onClick:()=>setSets(true)},
          React.createElement('span',{className:'material-symbols-outlined'},PROFILES[profile].icon)),
        React.createElement('button',{className:'ibtn',onClick:()=>setSets(true)},
          React.createElement('span',{className:'material-symbols-outlined'},'settings'))
      )
    ),

    /* TABS */
    React.createElement('div',{className:'tabs-bar'},
      convs.map(c=>React.createElement('div',{key:c.id,className:`tab${c.id===curId?' active':''}`,onClick:()=>setCurId(c.id)},
        React.createElement('span',{className:'tab-title'},c.title),
        React.createElement('span',{className:'tab-x',onClick:e=>{e.stopPropagation();deleteConv(c.id);}},React.createElement('span',{className:'material-symbols-outlined'},'close'))
      )),
      React.createElement('div',{className:'new-tab',onClick:newConv},React.createElement('span',{className:'material-symbols-outlined'},'add'))
    ),

    React.createElement('div',{className:'top-ad'},'ads go here'),

    React.createElement('div',{className:'layout'},
      React.createElement('div',{className:'chat-col'},
        React.createElement('div',{className:'msgs'},
          msgs.length===0
            ?React.createElement('div',{className:'welcome'},
                React.createElement('div',{className:'w-loader'},React.createElement(Loader,{size:'loader-xl',cls:engineOk?'pulsing':''})),
                React.createElement('h2',{className:'wt'},"Hey, I'm Dash."),
                React.createElement('p',{className:'ws'},engineOk?'Ask me anything. Open websites. Write code.':'Load a model to get started.'),
                React.createElement('div',{className:'chips'},CHIPS.map(c=>React.createElement('div',{key:c,className:'chip',onClick:()=>{primepopup();send(c);}},c)))
              )
            :React.createElement('div',{className:'mlist'},
                msgs.map((msg,i)=>{
                  if(msg.role==='ai'&&msg.text==='__NO_MODEL__') return React.createElement('div',{key:msg.id||i,className:'mrow a'},
                    React.createElement('div',{className:'bub a'},
                      React.createElement('div',{className:'no-model-warn'},
                        React.createElement('span',{className:'material-symbols-outlined'},'warning'),
                        React.createElement('span',null,'No model loaded — ',
                          React.createElement('span',{style:{color:'var(--ac)',cursor:'pointer',textDecoration:'underline'},onClick:()=>setStage('modelselect')},'load one here'),'.')
                      )
                    )
                  );
                  if(msg.id===streamId) return React.createElement(StreamBubble,{key:msg.id,textRef:liveTextRef,mobile});
                  return React.createElement(Bubble,{key:msg.id||i,msg,isLatest:i===latestAI,autoOpen});
                }),
                React.createElement('div',{ref:endR})
              )
        ),

        React.createElement('div',{id:'inputz-bar',className:'inputz'},
          React.createElement('div',{className:'ibar'},
            React.createElement('div',{style:{flexShrink:0,opacity:.45,display:'flex',alignItems:'center'}},React.createElement(Loader,{size:'loader-inp',cls:busy?'pulsing':''})),
            React.createElement('input',{ref:iRef,
              placeholder:engineOk?'Ask Dash anything…':'No model — tap banner to load',
              value:q,onChange:e=>setQ(e.target.value),onKeyDown:onKey,onFocus:primepopup,disabled:busy})
          ),
          React.createElement('button',{className:'sbtn',onClick:()=>{primepopup();send();},disabled:busy||!q.trim()},
            React.createElement('span',{className:'material-symbols-outlined'},busy?'stop_circle':'arrow_upward'))
        )
      ),
      React.createElement('div',{className:'ad-col'},
        React.createElement('div',{className:'ad-block'},'ads'),
        React.createElement('div',{className:'ad-block-sm'},'ads')
      )
    ),
    React.createElement('div',{className:'mobile-ad-bottom'},'ads go here')
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
