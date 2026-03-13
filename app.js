/* DashAI — app.js  v4 */
const { useState, useEffect, useRef } = React;

const MODELS = [
  { id:'Llama-3.2-1B-Instruct-q4f16_1-MLC', name:'DashLite', desc:'Fast & efficient · 1.2B params', size:'~700 MB', badge:'Recommended', bc:'mb-r' },
  { id:'Llama-3.2-3B-Instruct-q4f16_1-MLC', name:'DashMid',  desc:'Balanced · 3B params',           size:'~2 GB',   badge:'Balanced',    bc:'mb-b' },
  { id:'Llama-3.1-8B-Instruct-q4f16_1-MLC', name:'DashPro',  desc:'Maximum power · 8B params',      size:'~5 GB',   badge:'Heavy',        bc:'mb-h' },
];
const LANG_EXT = {python:'py',javascript:'js',typescript:'ts',html:'html',css:'css',bash:'sh',json:'json',java:'java',cpp:'cpp',c:'c',rust:'rs',go:'go',ruby:'rb',php:'php',sql:'sql',plaintext:'txt'};
const CHIPS = ['Who are you?','Open YouTube','Open GitHub','Write a Python scraper','Search Google for AI','Explain WebGPU','Show me a glass card CSS'];
const SAVED_MODEL_KEY = 'dashai_last_model';
const IS_MOBILE = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 680;

/* Engine on window — never GC'd */
if (!window._DE) window._DE = null;

/* ─── System prompt ─── */
const buildSys = (autoOpen) => `You are Dash, the AI inside DashAI — a browser app running AI locally via WebGPU.

IDENTITY: Your name is Dash. If asked who you are, say you are Dash, an on-device AI.

OPENING WEBSITES
================
To open a website, wrap the full URL in asterisks like this: *https://site.com*
DashAI detects this pattern and ${autoOpen ? 'opens it automatically in a new tab.' : 'shows it as a button the user can tap.'}

Examples — copy exactly:
- "open youtube"     → Here you go! *https://youtube.com*
- "open github"      → Opening GitHub *https://github.com*
- "search for dogs"  → *https://google.com/search?q=dogs*
- "open reddit"      → *https://reddit.com*
- "hacker news"      → *https://news.ycombinator.com*
- "open maps"        → *https://maps.google.com*
- "open twitter"     → *https://twitter.com*

Rules:
1. ALWAYS use *https://full-url* with the asterisks wrapping the complete https:// URL
2. Put it inline with your text, never isolated on its own line
3. Never explain or mention this syntax unless the user specifically asks how links work
4. Guess the URL if unsure — https://www.sitename.com works for most sites

CODE: fenced blocks with language tag. STYLE: concise, no "Of course!" / "Sure!" openers.`;

/* ─── Utils ─── */
const waitWLLM = () => new Promise(r => { if (window._wllm) r(); else window.addEventListener('wllm', r, {once:true}); });
const hasGPU = () => !!navigator.gpu;
const uid = () => Math.random().toString(36).slice(2,9);

/* ─── Parse AI response — extract *url* commands and code blocks ─── */
function parseAI(raw) {
  const cmds = [];
  let text = raw.replace(/\*(https?:\/\/[^\s*]+)\*/g, (_, u) => { cmds.push(u); return ''; });
  const segs = []; const re = /```(\w*)\r?\n?([\s\S]*?)```/g; let last=0,m;
  while ((m = re.exec(text)) !== null) {
    const b = text.slice(last, m.index).trim(); if (b) segs.push({t:'txt',v:b});
    segs.push({t:'code', lang:m[1]||'plaintext', v:m[2].trim()});
    last = m.index + m[0].length;
  }
  const tail = text.slice(last).trim(); if (tail) segs.push({t:'txt',v:tail});
  cmds.forEach(u => segs.push({t:'cmd',v:u}));
  return segs;
}
function iMd(s) {
  return s.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
    .replace(/(?<!\*)\*(?!\*)(.*?)(?<!\*)\*(?!\*)/g,'<em>$1</em>')
    .replace(/`([^`]+)`/g,'<code>$1</code>');
}

/* ─────────────────────────────────────────────────────────────
   STREAMING TEXT — word-by-word blur-fade
   Key insight: we write directly to a single <span> DOM node
   via a ref, bypassing React state entirely during streaming.
   This means NO re-renders, NO animation resets, NO lag.
───────────────────────────────────────────────────────────── */
const StreamingText = ({ textRef }) => {
  const containerRef = useRef(null);
  const wordCountRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let raf;
    let lastText = '';

    const paint = () => {
      const text = textRef.current || '';
      if (text !== lastText) {
        lastText = text;
        // Split into word-tokens (words + whitespace alternating)
        const tokens = text.split(/(\s+)/);
        const prevCount = wordCountRef.current;

        if (tokens.length > prevCount) {
          // Clear and repaint with new words fading in
          container.innerHTML = '';
          tokens.forEach((tok, i) => {
            const span = document.createElement('span');
            span.innerHTML = tok.replace(/\n/g, '<br>');
            if (i >= prevCount) {
              span.className = 'wf';
              // Stagger: each new word fades in slightly after the previous
              const delay = Math.min((i - prevCount) * 0.025, 0.6);
              span.style.animationDelay = delay + 's';
            }
            container.appendChild(span);
          });
          wordCountRef.current = tokens.length;
        }
      }
      raf = requestAnimationFrame(paint);
    };

    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, []);

  return React.createElement('div', { className: 'btxt', ref: containerRef });
};

/* ─── Loader spinner ─── */
const Loader = ({size='loader-md', cls=''}) => React.createElement('div', {className:`loader ${size} ${cls}`},
  React.createElement('div',{className:'inner one'}),
  React.createElement('div',{className:'inner two'}),
  React.createElement('div',{className:'inner three'})
);

/* ─── Code block ─── */
const CodeWidget = ({lang, code}) => {
  const [ok, setOk] = useState(false);
  const ref = useRef(null);
  useEffect(() => { if (ref.current && window.Prism) { const el = ref.current.querySelector('code'); if (el) window.Prism.highlightElement(el); } }, [code]);
  const copy = () => navigator.clipboard.writeText(code).then(() => { setOk(true); setTimeout(() => setOk(false), 2000); });
  const dl = () => { const ext = LANG_EXT[lang.toLowerCase()]||'txt'; const a = Object.assign(document.createElement('a'),{href:URL.createObjectURL(new Blob([code],{type:'text/plain'})),download:`dash-snippet.${ext}`}); a.click(); URL.revokeObjectURL(a.href); };
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
  const p = url.replace(/^https?:\/\/(www\.)?/,'').replace(/\/$/,'');
  return React.createElement('a',{className:'cmdbtn',href:url,target:'_blank',rel:'noopener',onClick:e=>{e.preventDefault();window.open(url,'_blank');}},
    React.createElement('span',{className:'material-symbols-outlined'},'open_in_new'), `Open ${p}`);
};

/* ─────────────────────────────────────────────
   STREAM BUBBLE — wraps StreamingText
   Holds textRef that gets mutated during streaming
   WITHOUT triggering re-renders
───────────────────────────────────────────── */
const StreamBubble = ({ textRef }) => {
  return React.createElement('div',{className:'mrow a'},
    React.createElement('div',{className:'bub a'},
      React.createElement('div',{className:'bi'},
        React.createElement(StreamingText, {textRef})
      )
    )
  );
};

/* ─── Regular (finished) bubble ─── */
const Bubble = React.memo(({msg, isLatest, autoOpen}) => {
  const firedRef = useRef(false);
  useEffect(() => {
    if (autoOpen && isLatest && msg.role==='ai' && msg.text && !firedRef.current) {
      const hits = [...msg.text.matchAll(/\*(https?:\/\/[^\s*]+)\*/g)];
      if (hits.length) { firedRef.current=true; hits.forEach(([,url],i) => setTimeout(() => window.open(url,'_blank'), 300+i*200)); }
    }
  }, [autoOpen, isLatest, msg.text]);

  if (msg.role==='user') return React.createElement('div',{className:'mrow u'},React.createElement('div',{className:'bub u'},msg.text));
  if (msg.thinking) return React.createElement('div',{className:'mrow a'},React.createElement('div',{className:'bub a think'},React.createElement('div',{className:'dots'},React.createElement('i'),React.createElement('i'),React.createElement('i'))));

  const segs = parseAI(msg.text||'');
  return React.createElement('div',{className:'mrow a'},
    React.createElement('div',{className:'bub a'},
      React.createElement('div',{className:'bi'},segs.map((s,i) => {
        if (s.t==='code') return React.createElement(CodeWidget,{key:i,lang:s.lang,code:s.v});
        if (s.t==='cmd') return React.createElement(CmdBtn,{key:i,url:s.v});
        const lines = s.v.split(/\n/).filter(l=>l.trim());
        return React.createElement('div',{key:i,className:'btxt'},lines.map((ln,j) => {
          const li = ln.match(/^[-•*]\s+(.*)/);
          if (li) return React.createElement('p',{key:j,style:{paddingLeft:'13px',position:'relative'}},
            React.createElement('span',{style:{position:'absolute',left:0,color:'var(--ac)',fontSize:'.58rem',top:'6px'}},'▸'),
            React.createElement('span',{dangerouslySetInnerHTML:{__html:iMd(li[1])}}));
          const h = ln.match(/^#{1,3}\s+(.*)/);
          if (h) return React.createElement('p',{key:j,style:{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:'.94rem'},dangerouslySetInnerHTML:{__html:iMd(h[1])}});
          return React.createElement('p',{key:j,dangerouslySetInnerHTML:{__html:iMd(ln)}});
        }));
      }))
    )
  );
});

/* ─── Cache clear — robust, handles Chromium quirks ─── */
async function doClearCache(setMsg) {
  setMsg('Clearing…');
  let out = [];
  try {
    if (window.caches) {
      const keys = await caches.keys();
      for (const k of keys) await caches.delete(k);
      out.push(`${keys.length} cache entries removed`);
    }
  } catch(e) { out.push('Cache API unavailable'); }

  try {
    // indexedDB.databases() not available in all browsers — guard it
    if (indexedDB.databases) {
      const dbs = await indexedDB.databases();
      let n = 0;
      for (const d of dbs) {
        await new Promise((res) => {
          const req = indexedDB.deleteDatabase(d.name);
          req.onsuccess = req.onerror = () => res();
        });
        n++;
      }
      out.push(`${n} IndexedDB stores removed`);
    }
  } catch(e) { /* silent */ }

  localStorage.removeItem(SAVED_MODEL_KEY);
  window._DE = null;
  setMsg('Done — ' + (out.join(', ') || 'storage cleared') + '. Reload the page to download again.');
}

/* ─── Settings panel ─── */
const Settings = ({onClose, theme, setTheme, autoOpen, setAutoOpen, model, onClear, onLoadModel}) => {
  const [cm, setCm] = useState('');
  const [cbusy, setCbusy] = useState(false);
  const doCache = async () => { setCbusy(true); await doClearCache(setCm); setCbusy(false); };
  return React.createElement('div',{className:'sov',onClick:e=>e.target===e.currentTarget&&onClose()},
    React.createElement('div',{className:'spanel'},
      React.createElement('div',{className:'sp-hd'},
        React.createElement('span',{className:'sp-title'},'Settings'),
        React.createElement('button',{className:'ibtn',onClick:onClose},React.createElement('span',{className:'material-symbols-outlined'},'close'))
      ),
      React.createElement('div',{className:'sp-sec'},
        React.createElement('div',{className:'sp-lbl'},'Appearance'),
        React.createElement('div',{className:'sp-row'},
          React.createElement('div',null,React.createElement('div',{className:'sp-rl'},'Light Theme')),
          React.createElement('div',{className:`tog${theme==='light'?' on':''}`,onClick:()=>setTheme(t=>t==='dark'?'light':'dark')})
        )
      ),
      React.createElement('div',{className:'sp-sec'},
        React.createElement('div',{className:'sp-lbl'},'Browser Control'),
        React.createElement('div',{className:'sp-row'},
          React.createElement('div',null,React.createElement('div',{className:'sp-rl'},'Auto-open Links'),React.createElement('div',{className:'sp-rs'},'URLs open automatically when Dash mentions them')),
          React.createElement('div',{className:`tog${autoOpen?' on':''}`,onClick:()=>setAutoOpen(v=>!v)})
        )
      ),
      React.createElement('div',{className:'sp-sec'},
        React.createElement('div',{className:'sp-lbl'},'Model'),
        React.createElement('div',{className:'sp-row'},
          React.createElement('div',null,
            React.createElement('div',{className:'sp-rl'},model?.name||'No model loaded'),
            React.createElement('div',{className:'sp-rs'},model?.size||'')
          ),
          model&&React.createElement('span',{className:'sp-model'},React.createElement('span',{className:'material-symbols-outlined'},'memory'),model.size)
        ),
        React.createElement('button',{className:'onb-btn primary',style:{width:'100%',marginTop:6},onClick:()=>{onClose();onLoadModel();}},model?'Switch Model':'Load Model')
      ),
      React.createElement('div',{className:'sp-sec'},
        React.createElement('div',{className:'sp-lbl'},'Data'),
        React.createElement('button',{className:'danger-btn',style:{marginBottom:6},onClick:()=>{onClear();onClose();}},'Clear conversations'),
        React.createElement('button',{className:'danger-btn',disabled:cbusy,onClick:doCache},cbusy?'Clearing…':'Clear model cache'),
        cm&&React.createElement('div',{style:{fontSize:'.72rem',color:'var(--sub)',marginTop:6,lineHeight:1.5}},cm)
      )
    )
  );
};

/* ─── Onboarding ─── */
const SLIDES = [
  {icon:null,hed:['Meet ',React.createElement('em',{key:'e'},'DashAI.')],sub:'A fast AI assistant that lives in your browser — no accounts, no cloud after setup.',feats:[{icon:'memory',label:'Runs on Your GPU'},{icon:'wifi_off',label:'Works Offline'},{icon:'tab',label:'Multi-tab Chats'}]},
  {icon:'bolt',hed:['Powered by ',React.createElement('em',{key:'e'},'WebGPU.')],sub:'Your GPU does the work — same tech as browser games, now running a full language model.',feats:[{icon:'speed',label:'Streaming Responses'},{icon:'devices',label:'Chrome & Edge'},{icon:'code',label:'Writes Code'}]},
  {icon:'open_in_new',hed:['Open sites, ',React.createElement('em',{key:'e'},'instantly.')],sub:'Ask Dash to open any site — it figures out the URL and opens it.',feats:[{icon:'link',label:'Smart Links'},{icon:'search',label:'Search Anything'},{icon:'bolt',label:'Instant'}]},
];
const Onboarding = ({onDone}) => {
  const [slide, setSlide] = useState(0); const [key, setKey] = useState(0);
  const go = n => { setSlide(n); setKey(k=>k+1); }; const s = SLIDES[slide];
  return React.createElement('div',{className:'onb'},
    React.createElement('div',{className:'onb-glow'}),
    React.createElement('div',{className:'onb-inner'},
      React.createElement('div',{key,className:'slide-content',style:{display:'flex',flexDirection:'column',alignItems:'center',width:'100%'}},
        React.createElement('div',{className:'onb-loader-wrap'},
          slide===0 ? React.createElement(Loader,{size:'loader-xl',cls:'pulsing'})
          : React.createElement('div',{style:{width:80,height:80,borderRadius:'50%',background:'var(--acd)',border:'1px solid var(--acb)',display:'flex',alignItems:'center',justifyContent:'center'}},
              React.createElement('span',{className:'material-symbols-outlined',style:{fontSize:38,color:'var(--ac)'}},s.icon))
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

const ModelSelect = ({onSelect, onSkip, gpuErr}) => React.createElement('div',{className:'msel'},
  React.createElement('div',{className:'msel-inner'},
    React.createElement('div',{className:'msel-loader'},React.createElement(Loader,{size:'loader-md'})),
    React.createElement('h2',{className:'msel-t'},'Choose your model'),
    React.createElement('p',{className:'msel-s'},'All models run on your device. Pick based on your GPU memory.'),
    MODELS.map(m=>React.createElement('div',{key:m.id,className:'mcard',onClick:()=>onSelect(m)},
      React.createElement('div',null,React.createElement('h4',null,m.name),React.createElement('p',null,`${m.desc} · ${m.size}`)),
      React.createElement('span',{className:`mbadge ${m.bc}`},m.badge)
    )),
    gpuErr&&React.createElement('div',{className:'gpu-warn'},'⚠️ WebGPU not detected. Use Chrome 113+ or Edge 113+. Enable: ',React.createElement('code',null,'chrome://flags/#enable-unsafe-webgpu')),
    React.createElement('div',{className:'msel-skip',onClick:onSkip},'Try UI without a model')
  )
);

/* ════════════════════════════════════════
   MAIN APP
════════════════════════════════════════ */
const App = () => {
  const savedModelId = localStorage.getItem(SAVED_MODEL_KEY);
  const savedModel = savedModelId ? MODELS.find(m=>m.id===savedModelId)||null : null;

  // If model was previously downloaded → go straight to loading, skip all screens
  const [stage, setStage] = useState(savedModel ? 'loading' : 'onboarding');
  const [lpct, setLpct] = useState(0);
  const [convs, setConvs] = useState([{id:'c1',title:'Chat 1',msgs:[]}]);
  const [curId, setCurId] = useState('c1');
  const [q, setQ] = useState('');
  const [autoOpen, setAutoOpen] = useState(false);
  const [theme, setTheme] = useState('dark');
  const [sets, setSets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState(savedModel);
  const [gpuErr, setGpuErr] = useState(false);

  // Streaming state: null = not streaming, else the id of the streaming message
  const [streamingMsgId, setStreamingMsgId] = useState(null);
  // textRef holds the live accumulating text — mutated directly, no re-renders during stream
  const liveTextRef = useRef('');

  const endR = useRef(null);
  const iRef = useRef(null);
  const initedRef = useRef(false); // prevent double-init in StrictMode

  const cur = convs.find(c=>c.id===curId)||convs[0];
  const msgs = cur?.msgs||[];

  useEffect(() => { if (!hasGPU()) setGpuErr(true); }, []);
  useEffect(() => { document.documentElement.classList.toggle('lt', theme==='light'); }, [theme]);
  useEffect(() => { endR.current?.scrollIntoView({behavior:'smooth'}); }, [msgs]);

  // Auto-load on mount if we have a saved model
  useEffect(() => {
    if (savedModel && !initedRef.current) {
      initedRef.current = true;
      initAI(savedModel);
    }
  }, []);

  const updateMsgs = (id, fn) => setConvs(cs => cs.map(c => c.id===id ? {...c, msgs:fn(c.msgs)} : c));
  const newConv = () => { const id=uid(); setConvs(cs=>[...cs,{id,title:`Chat ${cs.length+1}`,msgs:[]}]); setCurId(id); setTimeout(()=>iRef.current?.focus(),80); };
  const deleteConv = (id) => setConvs(cs => { const next=cs.filter(c=>c.id!==id); if(!next.length){const nc={id:uid(),title:'Chat 1',msgs:[]};setCurId(nc.id);return[nc];}; if(curId===id) setCurId(next[next.length-1].id); return next; });

  async function initAI(m) {
    if (!hasGPU()) { setGpuErr(true); setStage('modelselect'); return; }
    setModel(m); setStage('loading'); setLpct(0);
    try {
      await waitWLLM();
      const { CreateMLCEngine } = window.webllm;
      window._DE = await CreateMLCEngine(m.id, {
        initProgressCallback: r => setLpct(Math.round((r.progress||0)*100))
      });
      localStorage.setItem(SAVED_MODEL_KEY, m.id);
      setStage('main');
      setTimeout(() => iRef.current?.focus(), 120);
    } catch(e) {
      console.error(e);
      window._DE = null;
      // "Failed to add to cache" is a known Chromium IndexedDB bug.
      // WebLLM may still have loaded the model in memory — check before giving up.
      if (e.message && /cache|quota|storage/i.test(e.message) && window._DE) {
        // Engine actually loaded despite the cache error — just continue
        localStorage.setItem(SAVED_MODEL_KEY, m.id);
        setStage('main');
        setTimeout(() => iRef.current?.focus(), 120);
      } else {
        setStage('modelselect');
        alert(`Could not load model: ${e.message}\n\nIf WebGPU isn't enabled: chrome://flags/#enable-unsafe-webgpu`);
      }
    }
  }

  const skipToMain = () => { setStage('main'); setTimeout(()=>iRef.current?.focus(), 80); };

  const send = async (override) => {
    const text = (override||q).trim();
    if (!text || busy) return;

    if (!window._DE) {
      setQ('');
      if (!msgs.length) setConvs(cs => cs.map(c => c.id===curId ? {...c,title:text.slice(0,34)} : c));
      updateMsgs(curId, m => [...m, {id:uid(),role:'user',text}]);
      updateMsgs(curId, m => [...m, {id:uid(),role:'ai',thinking:false,text:'__NO_MODEL__'}]);
      return;
    }

    setQ(''); setBusy(true);
    if (!msgs.length) setConvs(cs => cs.map(c => c.id===curId ? {...c,title:text.length>34?text.slice(0,32)+'…':text} : c));

    const tid = uid();
    updateMsgs(curId, m => [...m, {id:uid(),role:'user',text}]);
    // Add thinking bubble
    updateMsgs(curId, m => [...m, {id:tid,role:'ai',thinking:true,text:''}]);

    try {
      const ctxLimit = IS_MOBILE() ? 4 : 12;
      const ctx = msgs.slice(-ctxLimit)
        .filter(m => m.text && !m.thinking && m.text!=='__NO_MODEL__')
        .map(m => ({role: m.role==='ai'?'assistant':'user', content:m.text}));

      const stream = await window._DE.chat.completions.create({
        messages: [{role:'system',content:buildSys(autoOpen)}, ...ctx, {role:'user',content:text}],
        stream: true,
        max_tokens: IS_MOBILE() ? 400 : 900,
        temperature: 0.7,
      });

      // Flip thinking→streaming: mount StreamBubble (shows blank bub immediately)
      liveTextRef.current = '';
      // Replace thinking bubble with a streaming placeholder
      updateMsgs(curId, m => { const n=[...m]; const i=n.findIndex(x=>x.id===tid); if(i!==-1) n[i]={...n[i],thinking:false,text:''}; return n; });
      setStreamingMsgId(tid);

      let acc = '';
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || '';
        if (!delta) continue;
        acc += delta;
        // Write to ref — StreamingText's rAF loop reads this without triggering re-renders
        liveTextRef.current = acc;
        // Yield every ~60 chars so mobile stays alive
        if (acc.length % 60 === 0) await new Promise(r => setTimeout(r, 0));
      }

      // Streaming done — commit final text to React state and unmount StreamBubble
      setStreamingMsgId(null);
      liveTextRef.current = '';
      updateMsgs(curId, m => { const n=[...m]; const i=n.findIndex(x=>x.id===tid); if(i!==-1) n[i]={...n[i],text:acc}; return n; });

    } catch(e) {
      console.error('Stream error:', e);
      setStreamingMsgId(null);
      liveTextRef.current = '';
      const errText = /Tokenizer|deleted|not loaded/i.test(e.message||'')
        ? '⚠️ Model was unloaded. Go to Settings → Load Model to reload it.'
        : `⚠️ ${e.message}`;
      updateMsgs(curId, m => { const n=[...m]; const i=n.findIndex(x=>x.id===tid); if(i!==-1) n[i]={...n[i],thinking:false,text:errText}; return n; });
      if (/Tokenizer|deleted|not loaded/i.test(e.message||'')) { window._DE=null; setModel(null); }
    }

    setBusy(false);
    setTimeout(() => iRef.current?.focus(), 50);
  };

  const onKey = e => { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  const latestAI = (() => { for (let i=msgs.length-1;i>=0;i--) if (msgs[i].role==='ai') return i; return -1; })();

  /* ── Stage gates ── */
  if (stage==='onboarding') return React.createElement(Onboarding, {onDone:()=>setStage('modelselect')});
  if (stage==='modelselect') return React.createElement(ModelSelect, {onSelect:initAI, onSkip:skipToMain, gpuErr});

  if (stage==='loading') return React.createElement('div',{className:'ldr'},
    React.createElement(Loader,{size:'loader-xl',cls:'pulsing'}),
    React.createElement('div',{className:'ptrack',style:{marginTop:28}},
      React.createElement('div',{className:'pfill',style:{width:`${lpct}%`,transition:'width .2s ease'}})
    ),
    React.createElement('p',{className:'ldr-hint',style:{marginTop:8,fontSize:'.8rem'}}, lpct > 0 ? `${lpct}%` : 'Starting…')
  );

  /* ── Main UI ── */
  const noModelBanner = !window._DE && React.createElement('div',{style:{position:'fixed',bottom:'calc(var(--inp) + 8px)',left:'50%',transform:'translateX(-50%)',zIndex:800,whiteSpace:'nowrap'}},
    React.createElement('div',{style:{display:'flex',alignItems:'center',gap:8,padding:'7px 14px',borderRadius:10,background:'rgba(168,156,247,.12)',border:'1px solid rgba(168,156,247,.28)',fontSize:'.75rem',color:'var(--ac)',cursor:'pointer'},onClick:()=>setStage('modelselect')},
      React.createElement('span',{className:'material-symbols-outlined',style:{fontSize:15}},'download'), 'No AI model — tap to load'
    )
  );

  return React.createElement(React.Fragment, null,
    sets && React.createElement(Settings,{onClose:()=>setSets(false),theme,setTheme,autoOpen,setAutoOpen,model,
      onLoadModel:()=>setStage('modelselect'),
      onClear:()=>{const id=uid();setConvs([{id,title:'Chat 1',msgs:[]}]);setCurId(id);}
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
        React.createElement('a',{href:'index.html',className:'home-btn'},React.createElement('span',{className:'material-symbols-outlined'},'home'),'Home'),
        React.createElement('div',{className:`auto-pill${autoOpen?' on':''}`,onClick:()=>setAutoOpen(v=>!v)},
          React.createElement('span',{className:'material-symbols-outlined'},autoOpen?'link':'link_off'),
          React.createElement('span',{className:'label'},'Auto-open'),
          React.createElement('div',{className:`tog-sm${autoOpen?' on':''}`})
        ),
        React.createElement('button',{className:'ibtn',onClick:()=>setSets(true)},React.createElement('span',{className:'material-symbols-outlined'},'settings'))
      )
    ),

    /* TABS */
    React.createElement('div',{className:'tabs-bar'},
      convs.map(c => React.createElement('div',{key:c.id,className:`tab${c.id===curId?' active':''}`,onClick:()=>setCurId(c.id)},
        React.createElement('span',{className:'tab-title'},c.title),
        React.createElement('span',{className:'tab-x',onClick:e=>{e.stopPropagation();deleteConv(c.id);}},React.createElement('span',{className:'material-symbols-outlined'},'close'))
      )),
      React.createElement('div',{className:'new-tab',onClick:newConv,title:'New chat'},React.createElement('span',{className:'material-symbols-outlined'},'add'))
    ),

    React.createElement('div',{className:'top-ad'},'ads go here'),

    /* LAYOUT */
    React.createElement('div',{className:'layout'},
      React.createElement('div',{className:'chat-col'},
        React.createElement('div',{className:'msgs'},
          msgs.length===0
            ? React.createElement('div',{className:'welcome'},
                React.createElement('div',{className:'w-loader'},React.createElement(Loader,{size:'loader-xl',cls:window._DE?'pulsing':''})),
                React.createElement('h2',{className:'wt'},"Hey, I'm Dash."),
                React.createElement('p',{className:'ws'},window._DE?'Ask me anything. Open websites. Write code.':'Load a model to get started.'),
                React.createElement('div',{className:'chips'},CHIPS.map(c=>React.createElement('div',{key:c,className:'chip',onClick:()=>send(c)},c)))
              )
            : React.createElement('div',{className:'mlist'},
                msgs.map((msg, i) => {
                  if (msg.role==='ai' && msg.text==='__NO_MODEL__') return React.createElement('div',{key:msg.id||i,className:'mrow a'},
                    React.createElement('div',{className:'bub a'},
                      React.createElement('div',{className:'no-model-warn'},
                        React.createElement('span',{className:'material-symbols-outlined'},'warning'),
                        React.createElement('span',null,'No model loaded. ',
                          React.createElement('span',{style:{color:'var(--ac)',cursor:'pointer',textDecoration:'underline'},onClick:()=>setStage('modelselect')},'Tap here to load one'),
                          '.')
                      )
                    )
                  );
                  // Streaming message — use DOM-direct bubble
                  if (msg.id===streamingMsgId) {
                    return React.createElement(StreamBubble,{key:msg.id,textRef:liveTextRef});
                  }
                  return React.createElement(Bubble,{key:msg.id||i,msg,isLatest:i===latestAI,autoOpen});
                }),
                React.createElement('div',{ref:endR})
              )
        ),
        React.createElement('div',{className:'inputz'},
          React.createElement('div',{className:'ibar'},
            React.createElement('div',{style:{flexShrink:0,opacity:.5,display:'flex',alignItems:'center'}},React.createElement(Loader,{size:'loader-inp',cls:busy?'pulsing':''})),
            React.createElement('input',{ref:iRef,
              placeholder:window._DE?'Ask Dash anything…':'No model — tap banner to load',
              value:q, onChange:e=>setQ(e.target.value), onKeyDown:onKey, disabled:busy})
          ),
          React.createElement('button',{className:'sbtn',onClick:()=>send(),disabled:busy||!q.trim()},
            React.createElement('span',{className:'material-symbols-outlined'},busy?'stop_circle':'arrow_upward')
          )
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
