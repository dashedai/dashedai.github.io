/* DashAI — app.js v10 */
const { useState, useEffect, useRef } = React;

/* ─── MODELS ─────────────────────────────────────────────────
   small:true  → hyper-explicit system prompt for link opening
   q4f16_1     → 4-bit quantised, runs on 2 GB+ VRAM
   For large models on mobile we force lower context + smaller
   max_tokens so they can still run without OOM.
────────────────────────────────────────────────────────────*/
const MODELS = [
  { id:'SmolLM2-360M-Instruct-q4f16_1-MLC',  name:'DashNano', tag:'360M', desc:'Ultrafast · best for mobile', size:'~200 MB', badge:'Mobile',      bc:'mb-n', bytes:200e6,  small:true,  heavy:false },
  { id:'Llama-3.2-1B-Instruct-q4f16_1-MLC',  name:'DashLite', tag:'1.2B', desc:'Fast & light',                size:'~700 MB', badge:'Recommended', bc:'mb-r', bytes:700e6,  small:true,  heavy:false },
  { id:'Llama-3.2-3B-Instruct-q4f16_1-MLC',  name:'DashMid',  tag:'3B',   desc:'Balanced quality',            size:'~2 GB',  badge:'Balanced',    bc:'mb-b', bytes:2e9,    small:false, heavy:false },
  { id:'Llama-3.1-8B-Instruct-q4f16_1-MLC',  name:'DashPro',  tag:'8B',   desc:'Maximum intelligence',        size:'~5 GB',  badge:'Powerful',    bc:'mb-h', bytes:5e9,    small:false, heavy:true  },
];

const LANG_EXT = {python:'py',javascript:'js',typescript:'ts',html:'html',css:'css',bash:'sh',json:'json',java:'java',cpp:'cpp',c:'c',rust:'rs',go:'go',ruby:'rb',php:'php',sql:'sql',plaintext:'txt'};
const CHIPS = ['Open YouTube','Open GitHub','Open Hacker News','Write a Python scraper','Explain WebGPU','Show CSS glass card'];
const SAVED_KEY  = 'dashai_last_model';
const PROFILE_KEY = 'dashai_profile';

/* ─── PROFILES ───────────────────────────────────────────────
   Mobile: yield every token (1 tick = 1 frame gap for GPU/compositor)
   Desktop: yield every 2 tokens (2× throughput)
   Heavy model on mobile: cap tokens lower to avoid OOM
────────────────────────────────────────────────────────────*/
const IS_MOB = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 680;
const detectProfile = () => localStorage.getItem(PROFILE_KEY) || (IS_MOB() ? 'mobile' : 'desktop');
const PROFILES = {
  desktop:{ label:'Desktop', icon:'computer',      maxTokens:1024, mobileMaxTokens:1024, ctxLimit:20, yieldEvery:2 },
  mobile: { label:'Mobile',  icon:'phone_android', maxTokens:400,  mobileMaxTokens:200,  ctxLimit:8,  yieldEvery:1 },
};

/* ─── ENGINE ─────────────────────────────────────────────── */
if (!window._DE) window._DE = null;

/* Yield compositor slot — scheduler.yield() > MessageChannel > setTimeout */
const yieldFrame = () => new Promise(r => {
  if (typeof scheduler !== 'undefined' && scheduler.yield) { scheduler.yield().then(r); return; }
  const mc = new MessageChannel(); mc.port1.onmessage = r; mc.port2.postMessage(null);
});

const waitWLLM  = () => new Promise(r => { if (window._wllm) r(); else window.addEventListener('wllm', r, {once:true}); });
const hasGPU    = () => !!navigator.gpu;
const uid       = () => Math.random().toString(36).slice(2,9);
const fmtEta    = s => s < 60 ? `${Math.round(s)}s` : `${Math.floor(s/60)}m ${Math.round(s%60)}s`;

/* ─── SYSTEM PROMPT ──────────────────────────────────────────
   small=true: rigid examples baked in so even 360M models
   correctly format URLs with *asterisks*
────────────────────────────────────────────────────────────*/
const buildSys = (ao, small) => {
  const linkSection = small
    ? `OPEN WEBSITES — CRITICAL RULE:
To open a website you MUST write the full URL wrapped in asterisks like this: *https://url*
MANDATORY EXAMPLES — copy exactly:
- open youtube      → *https://youtube.com*
- open github       → *https://github.com*
- search dogs       → *https://google.com/search?q=dogs*
- open reddit       → *https://reddit.com*
- open hacker news  → *https://news.ycombinator.com*
- open maps         → *https://maps.google.com*
- search AI news    → *https://google.com/search?q=AI+news*
RULE: asterisks + https:// + domain. NEVER a bare URL. NEVER skip the asterisks.
DashAI ${ao ? 'opens them automatically.' : 'shows a tap-to-open button.'}`
    : `OPEN WEBSITES: Wrap URL in asterisks — *https://url*
Examples: "open youtube" → *https://youtube.com* · "search x" → *https://google.com/search?q=x*
DashAI ${ao ? 'opens them automatically.' : 'shows a tap-to-open button.'}`;

  return `You are Dash — an on-device AI running privately in the browser via WebGPU.
IDENTITY: Your name is Dash. Private. Fast. No data leaves the device.
${linkSection}
CODE: Fenced blocks with language tag.
STYLE: Concise, direct. No filler like "Of course!" or "Sure!". Answer immediately.`;
};

/* ─── OCR via Tesseract.js (lazy-loaded) ─────────────────── */
let _tess = null;
async function loadTesseract() {
  if (_tess) return _tess;
  if (window.Tesseract) { _tess = window.Tesseract; return _tess; }
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
  _tess = window.Tesseract;
  return _tess;
}
async function runOCR(file, onPct) {
  const T = await loadTesseract();
  const w = await T.createWorker('eng', 1, {
    logger: m => { if (m.status === 'recognizing text' && onPct) onPct(Math.round(m.progress * 100)); }
  });
  const { data: { text } } = await w.recognize(file);
  await w.terminate();
  return text.trim();
}
const fileToB64 = f => new Promise((res,rej) => { const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(f); });

/* ─── MARKDOWN PARSER ────────────────────────────────────── */
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
const iMd = s => s
  .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
  .replace(/(?<!\*)\*(?!\*)(.*?)(?<!\*)\*(?!\*)/g,'<em>$1</em>')
  .replace(/`([^`]+)`/g,'<code>$1</code>');
const safeOpen = url => { try { window.open(url,'_blank','noopener'); } catch(e){} };

/* ─── STREAMING TEXT ─────────────────────────────────────────
   Single <p> updated via rAF — no spans, no flex-column.
   white-space:pre-wrap handles newlines naturally.
────────────────────────────────────────────────────────────*/
const StreamingText = ({ textRef }) => {
  const pRef = useRef(null);
  const lenRef = useRef(0);
  useEffect(() => {
    const el = pRef.current; if (!el) return;
    let raf;
    const tick = () => {
      const t = textRef.current || '';
      if (t.length !== lenRef.current) { el.textContent = t; lenRef.current = t.length; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return React.createElement('p', { className:'stream-p', ref:pRef });
};
const StreamBubble = ({ textRef }) =>
  React.createElement('div',{className:'mrow a'},
    React.createElement('div',{className:'bub a'},
      React.createElement(StreamingText,{textRef})
    )
  );

/* ─── COMPONENTS ─────────────────────────────────────────── */
const Loader = ({size='loader-md', cls=''}) =>
  React.createElement('div',{className:`loader ${size} ${cls}`},
    React.createElement('div',{className:'inner one'}),
    React.createElement('div',{className:'inner two'}),
    React.createElement('div',{className:'inner three'})
  );

const CodeWidget = ({lang, code}) => {
  const [ok,setOk] = useState(false);
  const ref = useRef(null);
  useEffect(()=>{if(ref.current&&window.Prism){const el=ref.current.querySelector('code');if(el)Prism.highlightElement(el);}},[code]);
  const copy = () => navigator.clipboard.writeText(code).then(()=>{setOk(true);setTimeout(()=>setOk(false),2000);});
  const dl   = () => { const ext=LANG_EXT[lang?.toLowerCase()]||'txt'; const a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(new Blob([code],{type:'text/plain'})),download:`snippet.${ext}`}); a.click(); URL.revokeObjectURL(a.href); };
  return React.createElement('div',{className:'cw'},
    React.createElement('div',{className:'cw-h'},
      React.createElement('span',{className:'cw-lang'},lang||'code'),
      React.createElement('div',{className:'cw-btns'},
        React.createElement('button',{className:`cw-btn${ok?' ok':''}`,onClick:copy},React.createElement('span',{className:'material-symbols-outlined'},ok?'check':'content_copy'),ok?'Copied':'Copy'),
        React.createElement('button',{className:'cw-btn',onClick:dl},React.createElement('span',{className:'material-symbols-outlined'},'download'),'Save')
      )
    ),
    React.createElement('div',{className:'cw-body',ref},React.createElement('pre',{className:`language-${lang}`},React.createElement('code',{className:`language-${lang}`},code)))
  );
};

const CmdBtn = ({url}) => {
  const p = url.replace(/^https?:\/\/(www\.)?/,'').replace(/\/$/,'').slice(0,40);
  return React.createElement('a',{className:'cmdbtn',href:url,target:'_blank',rel:'noopener',onClick:e=>{e.preventDefault();safeOpen(url);}},
    React.createElement('span',{className:'material-symbols-outlined'},'open_in_new'),`Open ${p}`);
};

const ImgThumb = ({src, onRemove}) =>
  React.createElement('div',{className:'img-thumb'},
    React.createElement('img',{src,alt:''}),
    React.createElement('button',{className:'img-thumb-x',onClick:onRemove},
      React.createElement('span',{className:'material-symbols-outlined'},'close'))
  );

const Bubble = React.memo(({msg, isLatest, autoOpen}) => {
  const firedRef = useRef(false);
  useEffect(()=>{
    if(autoOpen&&isLatest&&msg.role==='ai'&&msg.text&&!firedRef.current){
      const hits=[...msg.text.matchAll(/\*(https?:\/\/[^\s*]+)\*/g)];
      if(hits.length){firedRef.current=true;hits.forEach(([,url],i)=>setTimeout(()=>safeOpen(url),200+i*200));}
    }
  },[autoOpen,isLatest,msg.text]);

  if(msg.role==='user') return React.createElement('div',{className:'mrow u'},
    React.createElement('div',{className:'bub u'},
      msg.image && React.createElement('img',{src:msg.image,className:'msg-img',alt:''}),
      msg.text && React.createElement('span',null,msg.text)
    ));
  if(msg.thinking) return React.createElement('div',{className:'mrow a'},
    React.createElement('div',{className:'bub a think'},
      React.createElement('div',{className:'dots'},React.createElement('i'),React.createElement('i'),React.createElement('i'))));

  const segs=parseAI(msg.text||'');
  return React.createElement('div',{className:'mrow a'},
    React.createElement('div',{className:'bub a'},
      segs.map((s,i)=>{
        if(s.t==='code') return React.createElement(CodeWidget,{key:i,lang:s.lang,code:s.v});
        if(s.t==='cmd')  return React.createElement(CmdBtn,{key:i,url:s.v});
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

/* ─── CACHE CLEAR ────────────────────────────────────────── */
async function doClearCache(setMsg) {
  setMsg('Clearing…');
  const out=[];
  try{if(window.caches){const ks=await caches.keys();for(const k of ks)await caches.delete(k);out.push(`${ks.length} cache(s)`);}}catch(e){}
  try{if(indexedDB.databases){const dbs=await indexedDB.databases();for(const d of dbs)await new Promise(r=>{const q=indexedDB.deleteDatabase(d.name);q.onsuccess=q.onerror=r;});out.push(`${dbs.length} DB(s)`);}}catch(e){}
  localStorage.removeItem(SAVED_KEY);
  window._DE=null;
  setMsg('Cleared. Reload to re-download model.');
}

/* ─── SETTINGS PAGE ──────────────────────────────────────── */
const Settings = ({onClose,theme,setTheme,autoOpen,setAutoOpen,model,onClear,onLoadModel,profile,setProfile}) => {
  const [cm,setCm]=useState('');
  const [cb,setCb]=useState(false);
  const doCache=async()=>{setCb(true);await doClearCache(setCm);setCb(false);};

  return React.createElement('div',{className:'settings-page'},
    React.createElement('div',{className:'sp-topbar'},
      React.createElement('button',{className:'sp-back',onClick:onClose},
        React.createElement('span',{className:'material-symbols-outlined'},'arrow_back'),'Back'),
      React.createElement('span',{className:'sp-pagetitle'},'Settings')
    ),
    React.createElement('div',{className:'sp-body'},

      /* Performance — two icon buttons, no label */
      React.createElement('div',{className:'sp-sec'},
        React.createElement('div',{className:'sp-lbl'},'Performance'),
        React.createElement('div',{className:'perf-toggle'},
          ['desktop','mobile'].map(key => {
            const p=PROFILES[key], active=profile===key;
            return React.createElement('button',{key,className:`perf-btn${active?' active':''}`,title:p.label,
              onClick:()=>{localStorage.setItem(PROFILE_KEY,key);setProfile(key);}},
              React.createElement('span',{className:'material-symbols-outlined'},p.icon),
              React.createElement('span',{className:'perf-lbl'},p.label)
            );
          })
        )
      ),

      /* Appearance */
      React.createElement('div',{className:'sp-sec'},
        React.createElement('div',{className:'sp-lbl'},'Appearance'),
        React.createElement('div',{className:'sp-row'},
          React.createElement('span',{className:'sp-rl'},'Light Theme'),
          React.createElement('div',{className:`tog${theme==='light'?' on':''}`,onClick:()=>setTheme(t=>t==='dark'?'light':'dark')})
        )
      ),

      /* Browser */
      React.createElement('div',{className:'sp-sec'},
        React.createElement('div',{className:'sp-lbl'},'Browser'),
        React.createElement('div',{className:'sp-row'},
          React.createElement('span',{className:'sp-rl'},'Auto-open Links'),
          React.createElement('div',{className:`tog${autoOpen?' on':''}`,onClick:()=>setAutoOpen(v=>!v)})
        )
      ),

      /* Model */
      React.createElement('div',{className:'sp-sec'},
        React.createElement('div',{className:'sp-lbl'},'Model'),
        model && React.createElement('div',{className:'sp-info-row'},
          React.createElement('div',null,
            React.createElement('span',{className:'sp-rl'},model.name+' · '+model.tag),
            React.createElement('div',{className:'sp-sub'},model.size)
          )
        ),
        React.createElement('button',{className:'sp-btn',onClick:()=>{onClose();onLoadModel();}},
          React.createElement('span',{className:'material-symbols-outlined'},'swap_horiz'),
          model?'Switch Model':'Load Model')
      ),

      /* Data */
      React.createElement('div',{className:'sp-sec'},
        React.createElement('div',{className:'sp-lbl'},'Data'),
        React.createElement('button',{className:'sp-btn danger',style:{marginBottom:6},onClick:()=>{onClear();onClose();}},
          React.createElement('span',{className:'material-symbols-outlined'},'delete_sweep'),'Clear conversations'),
        React.createElement('button',{className:'sp-btn danger',disabled:cb,onClick:doCache},
          React.createElement('span',{className:'material-symbols-outlined'},cb?'hourglass_empty':'delete'),cb?'Clearing…':'Clear model cache'),
        cm && React.createElement('p',{className:'sp-hint',style:{marginTop:5}},cm)
      ),

      /* About */
      React.createElement('div',{className:'sp-sec'},
        React.createElement('div',{className:'sp-lbl'},'About'),
        React.createElement('div',{className:'sp-card'},
          React.createElement('p',{className:'sp-hint'},'DashAI runs AI entirely on your device via WebGPU. Nothing leaves your browser.'),
          React.createElement('div',{className:'sp-links'},
            React.createElement('a',{href:'privacy.html',className:'sp-link'},'Privacy'),
            React.createElement('a',{href:'terms.html',className:'sp-link'},'Terms'),
            React.createElement('a',{href:'contact.html',className:'sp-link'},'Contact')
          )
        )
      )
    )
  );
};

/* ─── ONBOARDING ─────────────────────────────────────────── */
const SLIDES = [
  {icon:null,     hed:['Meet ',React.createElement('em',{key:'e'},'DashAI.')],   sub:'AI running fully in your browser. No sign-up, no cloud, no data leaving your device.', feats:[{icon:'memory',label:'On-Device GPU'},{icon:'wifi_off',label:'Works Offline'},{icon:'lock',label:'100% Private'}]},
  {icon:'bolt',   hed:['Streams ',React.createElement('em',{key:'e'},'live.')],   sub:'Tokens appear word by word, just like ChatGPT — but privately on your hardware.',       feats:[{icon:'speed',label:'Token Streaming'},{icon:'code',label:'Writes Code'},{icon:'link',label:'Opens Sites'}]},
  {icon:'image',  hed:['Reads ',React.createElement('em',{key:'e'},'images.')],   sub:'Attach a photo — Dash reads text in it (OCR) and can answer questions about it.',      feats:[{icon:'document_scanner',label:'OCR Text'},{icon:'camera_alt',label:'Photo Input'},{icon:'translate',label:'Any Language'}]},
];
const Onboarding = ({onDone}) => {
  const [slide,setSlide]=useState(0);const [k,setK]=useState(0);
  const go=n=>{setSlide(n);setK(x=>x+1);};const s=SLIDES[slide];
  return React.createElement('div',{className:'onb'},
    React.createElement('div',{className:'onb-glow'}),
    React.createElement('div',{className:'onb-inner'},
      React.createElement('div',{key:k,className:'slide-content'},
        React.createElement('div',{className:'onb-loader-wrap'},
          slide===0
            ? React.createElement(Loader,{size:'loader-xl',cls:'pulsing'})
            : React.createElement('div',{className:'onb-icon-wrap'},
                React.createElement('span',{className:'material-symbols-outlined',style:{fontSize:34,color:'var(--ac)'}},s.icon))
        ),
        React.createElement('h1',{className:'onb-hed'},s.hed),
        React.createElement('p',{className:'onb-sub'},s.sub),
        React.createElement('div',{className:'feat-row'},s.feats.map((f,i)=>
          React.createElement('div',{key:i,className:'feat'},
            React.createElement('span',{className:'material-symbols-outlined'},f.icon),f.label)))
      ),
      React.createElement('div',{className:'onb-dots'},SLIDES.map((_,i)=>
        React.createElement('div',{key:i,className:`onb-dot${i===slide?' active':''}`,onClick:()=>go(i)}))),
      React.createElement('div',{className:'onb-btns'},
        slide>0 && React.createElement('button',{className:'onb-btn',onClick:()=>go(slide-1)},'Back'),
        React.createElement('button',{className:'onb-btn primary',onClick:()=>slide<SLIDES.length-1?go(slide+1):onDone()},
          slide===SLIDES.length-1?'Get Started →':'Next →')
      ),
      React.createElement('div',{className:'onb-skip',onClick:onDone},'Skip')
    )
  );
};

/* ─── MODEL SELECT ───────────────────────────────────────── */
const ModelSelect = ({onSelect,onSkip,gpuErr,isMobile}) =>
  React.createElement('div',{className:'msel'},
    React.createElement('div',{className:'msel-inner'},
      React.createElement('div',{className:'msel-loader'},React.createElement(Loader,{size:'loader-md'})),
      React.createElement('h2',{className:'msel-t'},'Choose a model'),
      React.createElement('p',{className:'msel-s'},'All models run locally. Nothing leaves your device.'),
      MODELS.map(m => {
        const warn = isMobile && m.heavy;
        return React.createElement('div',{key:m.id,className:`mcard${warn?' mcard-warn':''}`,onClick:()=>onSelect(m)},
          React.createElement('div',{style:{flex:1,minWidth:0}},
            React.createElement('h4',null,m.name),
            React.createElement('p',null,m.tag+' · '+m.desc+' · '+m.size),
            warn && React.createElement('p',{className:'mcard-warn-txt'},'⚠ May be slow on mobile — DashNano or DashLite recommended')
          ),
          React.createElement('span',{className:`mbadge ${m.bc}`},m.badge)
        );
      }),
      gpuErr && React.createElement('div',{className:'gpu-warn'},'⚠ WebGPU unavailable. Use Chrome 113+ or Edge 113+.'),
      React.createElement('div',{className:'msel-skip',onClick:onSkip},'Try without model')
    )
  );

/* ─── MAIN APP ───────────────────────────────────────────── */
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
  const [imgFile,  setImgFile]  = useState(null);
  const [imgSrc,   setImgSrc]   = useState('');
  const [ocrPct,   setOcrPct]   = useState(0);

  const liveRef   = useRef('');
  const endR      = useRef(null);
  const iRef      = useRef(null);
  const fileRef   = useRef(null);
  const initedRef = useRef(false);
  const loadStart = useRef(0);
  const lastProg  = useRef(0);
  const msgCount  = useRef(0);

  const prof   = PROFILES[profile];
  const mobile = profile === 'mobile';

  /* keyboard resize */
  useEffect(()=>{
    const vv=window.visualViewport; if(!vv) return;
    const up=()=>{ const el=document.getElementById('inputz-bar'); if(!el) return; el.style.bottom=Math.max(0,window.innerHeight-vv.height-vv.offsetTop)+'px'; };
    vv.addEventListener('resize',up); vv.addEventListener('scroll',up);
    return()=>{vv.removeEventListener('resize',up);vv.removeEventListener('scroll',up);};
  },[]);

  const cur  = convs.find(c=>c.id===curId)||convs[0];
  const msgs = cur?.msgs||[];

  useEffect(()=>{ if(!hasGPU()) setGpuErr(true); },[]);
  useEffect(()=>{ document.documentElement.classList.toggle('lt',theme==='light'); },[theme]);
  useEffect(()=>{
    if(msgs.length!==msgCount.current){ msgCount.current=msgs.length; endR.current?.scrollIntoView({behavior:'smooth'}); }
  },[msgs]);
  useEffect(()=>{ if(savedModel&&!initedRef.current){initedRef.current=true;initAI(savedModel);} },[]);

  const updateMsgs = (id,fn) => setConvs(cs=>cs.map(c=>c.id===id?{...c,msgs:fn(c.msgs)}:c));
  const newConv = () => { const id=uid(); setConvs(cs=>[...cs,{id,title:`Chat ${cs.length+1}`,msgs:[]}]); setCurId(id); setTimeout(()=>iRef.current?.focus(),80); };
  const delConv = id => setConvs(cs=>{
    const nx=cs.filter(c=>c.id!==id);
    if(!nx.length){const nc={id:uid(),title:'Chat 1',msgs:[]};setCurId(nc.id);return[nc];}
    if(curId===id) setCurId(nx[nx.length-1].id);
    return nx;
  });

  async function initAI(m) {
    if(!hasGPU()){setGpuErr(true);setStage('modelselect');return;}
    setModel(m); setStage('loading'); setLpct(0); setEta('');
    loadStart.current=performance.now();

    const onProg = p01 => {
      const now=performance.now();
      if(now-lastProg.current<250&&p01<0.99) return;
      lastProg.current=now;
      const pct=Math.round(p01*100); setLpct(pct);
      if(pct>2&&pct<99){
        const el=(now-loadStart.current)/1000;
        const bd=(pct/100)*m.bytes,sp=bd/el,rem=(m.bytes-bd)/sp;
        if(rem>0&&isFinite(rem)) setEta(fmtEta(rem));
      }
      if(pct>=99) setEta('');
    };

    try{
      await waitWLLM();
      const{CreateMLCEngine}=window.webllm;
      window._DE=await CreateMLCEngine(m.id,{initProgressCallback:r=>onProg(r.progress||0)});
      localStorage.setItem(SAVED_KEY,m.id);
      setEta(''); setStage('main');
      setTimeout(()=>iRef.current?.focus(),120);
    }catch(e){
      console.error(e);
      const ce=/cache|quota|storage|add to/i.test(e.message||'');
      if(ce&&window._DE){localStorage.setItem(SAVED_KEY,m.id);setEta('');setStage('main');return;}
      window._DE=null; setStage('modelselect');
      if(!ce) alert('Could not load model: '+e.message);
    }
  }

  const skipToMain = () => { setStage('main'); setTimeout(()=>iRef.current?.focus(),80); };
  const attachImg  = async f => { if(!f) return; setImgFile(f); setImgSrc(await fileToB64(f)); };

  const send = async (override) => {
    const text=(override||q).trim();
    if((!text&&!imgFile)||busy) return;
    window._popOk=true;

    if(!window._DE){
      setQ('');
      if(!msgs.length) setConvs(cs=>cs.map(c=>c.id===curId?{...c,title:(text||'Image').slice(0,34)}:c));
      updateMsgs(curId,m=>[...m,{id:uid(),role:'user',text:text||'[Image]',image:imgSrc||null}]);
      updateMsgs(curId,m=>[...m,{id:uid(),role:'ai',thinking:false,text:'__NO_MODEL__'}]);
      setImgFile(null);setImgSrc('');
      return;
    }

    const ci=imgSrc,cf=imgFile;
    setQ('');setBusy(true);setImgFile(null);setImgSrc('');setOcrPct(0);
    if(!msgs.length) setConvs(cs=>cs.map(c=>c.id===curId?{...c,title:(text||'Image').slice(0,34)}:c));

    const tid=uid();
    updateMsgs(curId,m=>[...m,{id:uid(),role:'user',text:text||'',image:ci||null}]);
    updateMsgs(curId,m=>[...m,{id:tid,role:'ai',thinking:true,text:''}]);

    try{
      let userContent=text;
      if(cf){
        let ocrText='';
        try{ ocrText=await runOCR(cf,p=>setOcrPct(p)); }catch(e){}
        setOcrPct(0);
        userContent=[text,ocrText?`[Image — extracted text:\n${ocrText}]`:'[Image — no readable text found]'].filter(Boolean).join('\n\n');
      }

      const ctxMsgs=msgs
        .filter(m=>m.text&&!m.thinking&&m.text!=='__NO_MODEL__')
        .slice(-prof.ctxLimit)
        .map(m=>({role:m.role==='ai'?'assistant':'user',content:m.text}));

      const maxTok = mobile && model?.heavy ? 200 : prof.maxTokens;
      const messages=[{role:'system',content:buildSys(autoOpen,model?.small??false)},...ctxMsgs,{role:'user',content:userContent||'(image attached)'}];

      liveRef.current='';
      setStreamId(tid);
      updateMsgs(curId,m=>{ const n=[...m]; const i=n.findIndex(x=>x.id===tid); if(i!==-1)n[i]={...n[i],thinking:false,text:''}; return n; });

      const stream=await window._DE.chat.completions.create({
        messages,stream:true,max_tokens:maxTok,temperature:0.7,
      });

      let acc='',tc=0;
      for await(const chunk of stream){
        const d=chunk.choices[0]?.delta?.content||''; if(!d) continue;
        acc+=d; liveRef.current=acc; tc++;
        if(tc%prof.yieldEvery===0) await yieldFrame();
      }

      liveRef.current='';
      updateMsgs(curId,m=>{ const n=[...m]; const i=n.findIndex(x=>x.id===tid); if(i!==-1)n[i]={...n[i],text:acc}; return n; });
      setStreamId(null);

    }catch(e){
      console.error(e);
      liveRef.current='';
      const dead=/Tokenizer|deleted|not loaded/i.test(e.message||'');
      updateMsgs(curId,m=>{ const n=[...m]; const i=n.findIndex(x=>x.id===tid); if(i!==-1)n[i]={...n[i],thinking:false,text:dead?'⚠ Model unloaded — reload from Settings.':`⚠ ${e.message}`}; return n; });
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
  if(stage==='modelselect') return React.createElement(ModelSelect,{onSelect:initAI,onSkip:skipToMain,gpuErr,isMobile:mobile});
  if(stage==='loading') return React.createElement('div',{className:'ldr'},
    React.createElement(Loader,{size:'loader-xl'}),
    React.createElement('div',{className:'ptrack',style:{marginTop:24}},React.createElement('div',{className:'pfill',style:{width:`${lpct}%`}})),
    React.createElement('p',{className:'ldr-eta'},lpct>0&&lpct<100?`${lpct}%${eta?' · ~'+eta+' left':''}`:lpct>=100?'Finalizing…':'Starting…')
  );
  if(sets) return React.createElement(Settings,{
    onClose:()=>setSets(false),theme,setTheme,autoOpen,setAutoOpen,model,
    onLoadModel:()=>setStage('modelselect'),
    onClear:()=>{ const id=uid();setConvs([{id,title:'Chat 1',msgs:[]}]);setCurId(id); },
    profile,setProfile
  });

  /* ── Main UI ── */
  const engineOk=!!window._DE;
  const noModelBanner=!engineOk&&React.createElement('div',{className:'no-model-banner'},
    React.createElement('div',{className:'no-model-pill',onClick:()=>setStage('modelselect')},
      React.createElement('span',{className:'material-symbols-outlined',style:{fontSize:13}},'download'),'No model — tap to load'
    )
  );

  return React.createElement(React.Fragment,null,
    noModelBanner,
    React.createElement('nav',{className:'nav'},
      React.createElement('div',{className:'nav-brand'},
        React.createElement(Loader,{size:'loader-nav',cls:busy?'pulsing':''}),
        React.createElement('span',{className:'wordmark'},'DashAI')
      ),
      React.createElement('div',{className:'nav-gap'}),
      React.createElement('div',{className:'nav-r'},
        React.createElement('a',{href:'index.html',className:'home-btn'},React.createElement('span',{className:'material-symbols-outlined'},'home')),
        React.createElement('button',{className:`ibtn${autoOpen?' ibtn-on':''}`,title:'Auto-open links',onClick:()=>{setAutoOpen(v=>!v);window._popOk=true;}},
          React.createElement('span',{className:'material-symbols-outlined'},autoOpen?'link':'link_off')),
        React.createElement('button',{className:'ibtn',title:`Mode: ${PROFILES[profile].label} — click to toggle`,
          onClick:()=>{ const n=profile==='desktop'?'mobile':'desktop'; localStorage.setItem(PROFILE_KEY,n);setProfile(n); }},
          React.createElement('span',{className:'material-symbols-outlined'},PROFILES[profile].icon)),
        React.createElement('button',{className:'ibtn',onClick:()=>setSets(true)},
          React.createElement('span',{className:'material-symbols-outlined'},'settings'))
      )
    ),
    React.createElement('div',{className:'tabs-bar'},
      convs.map(c=>React.createElement('div',{key:c.id,className:`tab${c.id===curId?' active':''}`,onClick:()=>setCurId(c.id)},
        React.createElement('span',{className:'tab-title'},c.title),
        React.createElement('span',{className:'tab-x',onClick:e=>{e.stopPropagation();delConv(c.id);}},
          React.createElement('span',{className:'material-symbols-outlined'},'close'))
      )),
      React.createElement('div',{className:'new-tab',onClick:newConv},React.createElement('span',{className:'material-symbols-outlined'},'add'))
    ),
    React.createElement('div',{className:'top-ad'},'ads go here'),
    React.createElement('div',{className:'layout'},
      React.createElement('div',{className:'chat-col'},
        React.createElement('div',{className:'msgs'},
          msgs.length===0
            ? React.createElement('div',{className:'welcome'},
                React.createElement('div',{className:'w-loader'},React.createElement(Loader,{size:'loader-xl',cls:engineOk?'pulsing':''})),
                React.createElement('h2',{className:'wt'},"Hey, I'm Dash."),
                React.createElement('p',{className:'ws'},engineOk?'Ask anything. Open sites. Read images.':'Load a model to get started.'),
                React.createElement('div',{className:'chips'},CHIPS.map(c=>
                  React.createElement('div',{key:c,className:'chip',onClick:()=>{window._popOk=true;send(c);}},c)))
              )
            : React.createElement('div',{className:'mlist'},
                msgs.map((msg,i)=>{
                  if(msg.role==='ai'&&msg.text==='__NO_MODEL__') return React.createElement('div',{key:msg.id||i,className:'mrow a'},
                    React.createElement('div',{className:'bub a'},
                      React.createElement('div',{className:'no-model-warn'},
                        React.createElement('span',{className:'material-symbols-outlined'},'warning'),
                        React.createElement('span',null,'No model — ',
                          React.createElement('span',{style:{color:'var(--ac)',cursor:'pointer',textDecoration:'underline'},onClick:()=>setStage('modelselect')},'load one'),'.')
                      )
                    )
                  );
                  if(msg.id===streamId) return React.createElement(StreamBubble,{key:msg.id,textRef:liveRef});
                  return React.createElement(Bubble,{key:msg.id||i,msg,isLatest:i===latestAI,autoOpen});
                }),
                React.createElement('div',{ref:endR})
              )
        ),
        React.createElement('div',{id:'inputz-bar',className:'inputz'},
          imgSrc && React.createElement('div',{className:'img-preview-strip'},
            React.createElement(ImgThumb,{src:imgSrc,onRemove:()=>{setImgFile(null);setImgSrc('');}})),
          ocrPct>0 && React.createElement('div',{className:'ocr-bar'},
            React.createElement('div',{className:'ocr-fill',style:{width:ocrPct+'%'}}),
            React.createElement('span',{className:'ocr-label'},`Reading… ${ocrPct}%`)),
          React.createElement('div',{className:'ibar'},
            React.createElement('div',{style:{flexShrink:0,opacity:.4,display:'flex',alignItems:'center'}},
              React.createElement(Loader,{size:'loader-inp',cls:busy?'pulsing':''})),
            React.createElement('input',{type:'file',accept:'image/*',style:{display:'none'},ref:fileRef,
              onChange:e=>{if(e.target.files[0])attachImg(e.target.files[0]);e.target.value=''}}),
            React.createElement('button',{className:'ibtn',style:{flexShrink:0},title:'Attach image',
              onClick:()=>fileRef.current?.click()},
              React.createElement('span',{className:'material-symbols-outlined'},'image')),
            React.createElement('input',{ref:iRef,
              placeholder:engineOk?'Ask Dash anything…':'Load a model first',
              value:q,onChange:e=>setQ(e.target.value),onKeyDown:onKey,
              onFocus:()=>{window._popOk=true;},disabled:busy})
          ),
          React.createElement('button',{className:'sbtn',onClick:()=>{window._popOk=true;send();},disabled:busy||(!q.trim()&&!imgFile)},
            React.createElement('span',{className:'material-symbols-outlined'},busy?'stop_circle':'arrow_upward'))
        )
      ),
      React.createElement('div',{className:'ad-col'},
        React.createElement('div',{className:'ad-block'},'ads'),
        React.createElement('div',{className:'ad-block-sm'},'ads')
      )
    )
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
