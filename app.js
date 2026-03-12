/* DashAI — app.js */
const { useState, useEffect, useRef } = React;

const MODELS = [
  { id:'Llama-3.2-1B-Instruct-q4f16_1-MLC', name:'DashLite', desc:'Fast & efficient · 1.2B params', size:'~700 MB', badge:'Recommended', bc:'mb-r' },
  { id:'Llama-3.2-3B-Instruct-q4f16_1-MLC', name:'DashMid',  desc:'Balanced · 3B params',           size:'~2 GB',   badge:'Balanced',    bc:'mb-b' },
  { id:'Llama-3.1-8B-Instruct-q4f16_1-MLC', name:'DashPro',  desc:'Maximum power · 8B params',      size:'~5 GB',   badge:'Heavy',        bc:'mb-h' },
];
const LANG_EXT={python:'py',javascript:'js',typescript:'ts',html:'html',css:'css',bash:'sh',json:'json',java:'java',cpp:'cpp',c:'c',rust:'rs',go:'go',ruby:'rb',php:'php',sql:'sql',plaintext:'txt'};
const CHIPS=['Who are you?','Open YouTube','Search Google for AI','Write a Python scraper','Open GitHub','How do you open links?','What runs you?','Show me a glass card CSS'];
const SAVED_MODEL_KEY='dashai_last_model';

const SLIDES=[
  {icon:null,hed:['Meet ',React.createElement('em',{key:'e'},'DashAI.')],sub:'An AI assistant that lives entirely in your browser — no accounts, no cloud, no internet required after setup.',feats:[{icon:'lock',label:'100% Private'},{icon:'wifi_off',label:'Works Offline'},{icon:'memory',label:'Runs on Your GPU'}]},
  {icon:'security',hed:['Your data never ',React.createElement('em',{key:'e'},'leaves.')],sub:'Everything you type stays on your device. DashAI has zero telemetry, zero data collection, and zero servers listening in.',feats:[{icon:'cloud_off',label:'No Cloud Storage'},{icon:'visibility_off',label:'Zero Telemetry'},{icon:'vpn_lock',label:'End-to-End Local'}]},
  {icon:'bolt',hed:['Powerful ',React.createElement('em',{key:'e'},'on-device'),' AI.'],sub:'Powered by WebGPU — the same technology that runs games in your browser. Choose from multiple model sizes to match your hardware.',feats:[{icon:'speed',label:'Sub-second Responses'},{icon:'devices',label:'Any Modern Browser'},{icon:'code',label:'Writes & Runs Code'}]},
  {icon:'open_in_new',hed:['Browse smarter, ',React.createElement('em',{key:'e'},'hands-free.')],sub:'Ask Dash to open any website and it opens it — instantly. Just say the word, no copy-pasting URLs.',feats:[{icon:'link',label:'Auto-open Links'},{icon:'search',label:'Search Anything'},{icon:'tab',label:'Multi-tab Chats'}]},
];

const buildSys=(autoOpen)=>`You are Dash — the AI assistant built into DashAI, a browser-native AI that runs 100% on the user's device using WebGPU. Zero servers. Zero cloud. Completely private.

Your name is Dash. If asked who you are: you're Dash, the on-device AI inside DashAI.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OPENING LINKS — THIS IS CRITICAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When a user asks you to open, visit, go to, or navigate to ANY website, you MUST include:
  [CMD:open:https://full-url-here.com]

The DashAI client detects it and ${autoOpen?'opens the URL automatically in a new tab.':'shows the user a clickable button to open the URL.'}

RULES:
1. ALWAYS include [CMD:open:URL] when the user wants to visit a site.
2. Guess the URL from context — "open google" → [CMD:open:https://google.com], "search for cats" → [CMD:open:https://google.com/search?q=cats]
3. Never expose the raw syntax unless asked how it works.
4. Keep messages natural — e.g. "Opening GitHub for you!" then include the tag.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CODE — always use fenced blocks with language identifier.

RESPONSE STYLE — natural sentences, no "Of course!" padding, bold/bullets only when helpful.`;

const waitWLLM=()=>new Promise(r=>{if(window._wllm)r();else window.addEventListener('wllm',r,{once:true});});
const hasGPU=()=>!!navigator.gpu;
const uid=()=>Math.random().toString(36).slice(2,9);

function parseAI(raw){
  const cmds=[];
  let text=raw.replace(/\[CMD:open:(.*?)\]/g,(_,u)=>{cmds.push(u.trim());return'';});
  const segs=[];
  const re=/```(\w*)\r?\n?([\s\S]*?)```/g;
  let last=0,m;
  while((m=re.exec(text))!==null){
    const b=text.slice(last,m.index).trim();
    if(b)segs.push({t:'txt',v:b});
    segs.push({t:'code',lang:m[1]||'plaintext',v:m[2].trim()});
    last=m.index+m[0].length;
  }
  const tail=text.slice(last).trim();
  if(tail)segs.push({t:'txt',v:tail});
  cmds.forEach(u=>segs.push({t:'cmd',v:u}));
  return segs;
}
function iMd(s){return s.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\*(.*?)\*/g,'<em>$1</em>').replace(/`([^`]+)`/g,'<code>$1</code>');}

/* ══ LOADER COMPONENT ══ */
const Loader=({size='loader-md',cls=''})=>React.createElement('div',{className:`loader ${size} ${cls}`},
  React.createElement('div',{className:'inner one'}),
  React.createElement('div',{className:'inner two'}),
  React.createElement('div',{className:'inner three'})
);

/* ══ CODE WIDGET ══ */
const CodeWidget=({lang,code})=>{
  const[ok,setOk]=useState(false);
  const ref=useRef(null);
  useEffect(()=>{if(ref.current&&window.Prism){const el=ref.current.querySelector('code');if(el)window.Prism.highlightElement(el);}},[code]);
  const copy=()=>navigator.clipboard.writeText(code).then(()=>{setOk(true);setTimeout(()=>setOk(false),2000);});
  const dl=()=>{const ext=LANG_EXT[lang.toLowerCase()]||'txt';const a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(new Blob([code],{type:'text/plain'})),download:`dash-snippet.${ext}`});a.click();URL.revokeObjectURL(a.href);};
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

/* ══ BUBBLE ══ */
const Bubble=({msg,isLatest,autoOpen})=>{
  const[revealed,setRevealed]=useState(false);
  useEffect(()=>{if(msg.role==='ai'&&!msg.thinking&&isLatest){const t=setTimeout(()=>setRevealed(true),40);return()=>clearTimeout(t);};},[msg.role,msg.thinking,isLatest]);
  useEffect(()=>{if(autoOpen&&msg.role==='ai'&&!msg.thinking&&isLatest&&msg.text){const ms=msg.text.match(/\[CMD:open:(.*?)\]/g);if(ms)ms.forEach(tag=>{const url=tag.replace('[CMD:open:','').replace(']','').trim();setTimeout(()=>window.open(url,'_blank'),500);});}},[msg.text,msg.thinking]);
  if(msg.role==='user')return React.createElement('div',{className:'mrow u'},React.createElement('div',{className:'bub u'},msg.text));
  if(msg.thinking)return React.createElement('div',{className:'mrow a'},React.createElement('div',{className:'bub a think'},React.createElement('div',{className:'dots'},React.createElement('i'),React.createElement('i'),React.createElement('i'))));
  const segs=parseAI(msg.text);
  const cls=`bub a${isLatest?(revealed?' reveal':''):''}`;
  return React.createElement('div',{className:'mrow a'},
    React.createElement('div',{className:cls,style:isLatest&&!revealed?{opacity:0}:{}},
      React.createElement('div',{className:'bi'},segs.map((s,i)=>{
        if(s.t==='code')return React.createElement(CodeWidget,{key:i,lang:s.lang,code:s.v});
        if(s.t==='cmd'){const pretty=s.v.replace(/^https?:\/\/(www\.)?/,'').replace(/\/$/,'');return React.createElement('a',{key:i,className:'cmdbtn',href:s.v,target:'_blank',rel:'noopener',onClick:e=>{e.preventDefault();window.open(s.v,'_blank');}},React.createElement('span',{className:'material-symbols-outlined'},'open_in_new'),`Open ${pretty}`);}
        const lines=s.v.split(/\n/).filter(l=>l.trim());
        return React.createElement('div',{key:i,className:'btxt'},lines.map((ln,j)=>{
          const li=ln.match(/^[-•*]\s+(.*)/);
          if(li)return React.createElement('p',{key:j,style:{paddingLeft:'13px',position:'relative'}},React.createElement('span',{style:{position:'absolute',left:0,color:'var(--ac)',fontSize:'.58rem',top:'6px'}},'▸'),React.createElement('span',{dangerouslySetInnerHTML:{__html:iMd(li[1])}}));
          const h=ln.match(/^#{1,3}\s+(.*)/);
          if(h)return React.createElement('p',{key:j,style:{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:'.94rem',marginBottom:'1px'},dangerouslySetInnerHTML:{__html:iMd(h[1])}});
          return React.createElement('p',{key:j,dangerouslySetInnerHTML:{__html:iMd(ln)}});
        }));
      }))
    )
  );
};

/* ══ SETTINGS ══ */
const Settings=({onClose,theme,setTheme,autoOpen,setAutoOpen,model,onClear,onLoadModel})=>React.createElement('div',{className:'sov',onClick:e=>e.target===e.currentTarget&&onClose()},
  React.createElement('div',{className:'spanel'},
    React.createElement('div',{className:'sp-hd'},React.createElement('span',{className:'sp-title'},'Settings'),React.createElement('button',{className:'ibtn',onClick:onClose},React.createElement('span',{className:'material-symbols-outlined'},'close'))),
    React.createElement('div',{className:'sp-sec'},
      React.createElement('div',{className:'sp-lbl'},'Appearance'),
      React.createElement('div',{className:'sp-row'},React.createElement('div',null,React.createElement('div',{className:'sp-rl'},'Light Theme'),React.createElement('div',{className:'sp-rs'},'Switch to light mode')),React.createElement('div',{className:`tog${theme==='light'?' on':''}`,onClick:()=>setTheme(t=>t==='dark'?'light':'dark')}))
    ),
    React.createElement('div',{className:'sp-sec'},
      React.createElement('div',{className:'sp-lbl'},'Browser Control'),
      React.createElement('div',{className:'sp-row'},React.createElement('div',null,React.createElement('div',{className:'sp-rl'},'Auto-open Links'),React.createElement('div',{className:'sp-rs'},'Links open instantly, no confirmation')),React.createElement('div',{className:`tog${autoOpen?' on':''}`,onClick:()=>setAutoOpen(v=>!v)}))
    ),
    React.createElement('div',{className:'sp-sec'},
      React.createElement('div',{className:'sp-lbl'},'Active Model'),
      React.createElement('div',{className:'sp-row'},
        React.createElement('div',null,React.createElement('div',{className:'sp-rl'},model?.name||'No model loaded'),React.createElement('div',{className:'sp-rs'},model?.desc||'Click below to load a model')),
        model&&React.createElement('span',{className:'sp-model'},React.createElement('span',{className:'material-symbols-outlined'},'memory'),model.size)
      ),
      !model&&React.createElement('button',{className:'onb-btn primary',style:{width:'100%',marginTop:6},onClick:()=>{onClose();onLoadModel();}},'Load a Model')
    ),
    React.createElement('div',{className:'sp-sec'},
      React.createElement('div',{className:'sp-lbl'},'Danger Zone'),
      React.createElement('button',{className:'danger-btn',onClick:()=>{onClear();onClose();}},'Clear all conversations')
    )
  )
);

/* ══ ONBOARDING ══ */
const Onboarding=({onDone})=>{
  const[slide,setSlide]=useState(0);
  const[key,setKey]=useState(0);
  const total=SLIDES.length;
  const go=(n)=>{setSlide(n);setKey(k=>k+1);};
  const s=SLIDES[slide];
  return React.createElement('div',{className:'onb'},
    React.createElement('div',{className:'onb-glow'}),
    React.createElement('div',{className:'onb-inner'},
      React.createElement('div',{key,className:'slide-content',style:{display:'flex',flexDirection:'column',alignItems:'center',width:'100%'}},
        React.createElement('div',{className:'onb-loader-wrap'},
          slide===0
            ?React.createElement(Loader,{size:'loader-xl',cls:'pulsing'})
            :React.createElement('div',{style:{width:80,height:80,borderRadius:'50%',background:'var(--acd)',border:'1px solid var(--acb)',display:'flex',alignItems:'center',justifyContent:'center'}},React.createElement('span',{className:'material-symbols-outlined',style:{fontSize:38,color:'var(--ac)'}},s.icon))
        ),
        React.createElement('h1',{className:'onb-hed'},s.hed),
        React.createElement('p',{className:'onb-sub'},s.sub),
        React.createElement('div',{className:'feat-row'},s.feats.map((f,i)=>React.createElement('div',{key:i,className:'feat'},React.createElement('span',{className:'material-symbols-outlined'},f.icon),f.label)))
      ),
      React.createElement('div',{className:'onb-dots'},SLIDES.map((_,i)=>React.createElement('div',{key:i,className:`onb-dot${i===slide?' active':''}`,onClick:()=>go(i)}))),
      React.createElement('div',{className:'onb-btns'},
        slide>0&&React.createElement('button',{className:'onb-btn',onClick:()=>go(slide-1)},'Back'),
        React.createElement('button',{className:'onb-btn primary',onClick:()=>slide<total-1?go(slide+1):onDone()},slide===total-1?'Get Started →':'Next →')
      ),
      React.createElement('div',{className:'onb-skip',onClick:onDone},'Skip intro')
    )
  );
};

/* ══ MODEL SELECT ══ */
const ModelSelect=({onSelect,onSkip,gpuErr})=>React.createElement('div',{className:'msel'},
  React.createElement('div',{className:'msel-inner'},
    React.createElement('div',{className:'msel-loader'},React.createElement(Loader,{size:'loader-md'})),
    React.createElement('h2',{className:'msel-t'},'Choose your model'),
    React.createElement('p',{className:'msel-s'},'All models run on your device. Pick based on your GPU memory.'),
    MODELS.map(m=>React.createElement('div',{key:m.id,className:'mcard',onClick:()=>onSelect(m)},
      React.createElement('div',null,React.createElement('h4',null,m.name),React.createElement('p',null,`${m.desc} · ${m.size}`)),
      React.createElement('span',{className:`mbadge ${m.bc}`},m.badge)
    )),
    gpuErr&&React.createElement('div',{className:'gpu-warn'},'⚠️ ',React.createElement('strong',null,'WebGPU not detected.'),' Use Chrome 113+ or Edge 113+.',React.createElement('br'),'Enable at: ',React.createElement('code',null,'chrome://flags/#enable-unsafe-webgpu')),
    React.createElement('div',{className:'msel-skip',onClick:onSkip},'Skip for now — enter the app without a model')
  )
);

/* ══ MAIN APP ══ */
const App=()=>{
  const savedModelId=localStorage.getItem(SAVED_MODEL_KEY);
  const savedModel=savedModelId?MODELS.find(m=>m.id===savedModelId)||null:null;

  const[stage,setStage]=useState(savedModel?'modelselect':'onboarding');
  const[lmsg,setLmsg]=useState('');
  const[lpct,setLpct]=useState(0);
  const[convs,setConvs]=useState([{id:'c1',title:'Chat 1',msgs:[]}]);
  const[curId,setCurId]=useState('c1');
  const[q,setQ]=useState('');
  const[autoOpen,setAutoOpen]=useState(false);
  const[theme,setTheme]=useState('dark');
  const[sets,setSets]=useState(false);
  const[busy,setBusy]=useState(false);
  const[model,setModel]=useState(null); // null = no model loaded
  const[gpuErr,setGpuErr]=useState(false);

  const eng=useRef(null);
  const endR=useRef(null);
  const iRef=useRef(null);

  const cur=convs.find(c=>c.id===curId)||convs[0];
  const msgs=cur?.msgs||[];
  const chatActive=msgs.filter(m=>!m.thinking&&m.text).length>0;

  useEffect(()=>{if(!hasGPU())setGpuErr(true);},[]);
  useEffect(()=>{document.documentElement.classList.toggle('lt',theme==='light');},[theme]);
  useEffect(()=>{endR.current?.scrollIntoView({behavior:'smooth'});},[msgs]);

  const updateMsgs=(id,fn)=>setConvs(cs=>cs.map(c=>c.id===id?{...c,msgs:fn(c.msgs)}:c));
  const updateTitle=(id,t)=>setConvs(cs=>cs.map(c=>c.id===id?{...c,title:t}:c));

  const newConv=()=>{const id=uid();setConvs(cs=>[...cs,{id,title:`Chat ${cs.length+1}`,msgs:[]}]);setCurId(id);setTimeout(()=>iRef.current?.focus(),80);};
  const deleteConv=(id)=>{setConvs(cs=>{const next=cs.filter(c=>c.id!==id);if(next.length===0){const nc={id:uid(),title:'Chat 1',msgs:[]};setCurId(nc.id);return[nc];}if(curId===id)setCurId(next[next.length-1].id);return next;});};

  const initAI=async(m)=>{
    if(!hasGPU()){setGpuErr(true);return;}
    setModel(m);setStage('loading');setLmsg('Connecting…');
    try{
      await waitWLLM();
      const{CreateMLCEngine}=window.webllm;
      eng.current=await CreateMLCEngine(m.id,{initProgressCallback:r=>{setLpct(Math.round((r.progress||0)*100));setLmsg(r.text||`Loading ${m.name}…`);}});
      localStorage.setItem(SAVED_MODEL_KEY,m.id);
      setStage('main');
      setTimeout(()=>iRef.current?.focus(),120);
    }catch(e){
      console.error(e);setStage('modelselect');
      alert(`Failed to load: ${e.message}\n\nEnable WebGPU: chrome://flags/#enable-unsafe-webgpu`);
    }
  };

  /* skip model load — go straight to UI, engine stays null */
  const skipToMain=()=>{setStage('main');setTimeout(()=>iRef.current?.focus(),80);};

  const send=async(override)=>{
    const text=(override||q).trim();
    if(!text||busy)return;

    /* No model loaded — show a friendly inline warning */
    if(!eng.current){
      setQ('');
      if(msgs.length===0)updateTitle(curId,text.length>34?text.slice(0,32)+'…':text);
      updateMsgs(curId,m=>[...m,{id:uid(),role:'user',text}]);
      updateMsgs(curId,m=>[...m,{id:uid(),role:'ai',thinking:false,text:'__NO_MODEL__',isNew:true}]);
      return;
    }

    setQ('');setBusy(true);
    if(msgs.length===0)updateTitle(curId,text.length>34?text.slice(0,32)+'…':text);
    const tid=uid();
    updateMsgs(curId,m=>[...m,{id:uid(),role:'user',text}]);
    updateMsgs(curId,m=>[...m,{id:tid,role:'ai',thinking:true,text:''}]);
    try{
      const sys=buildSys(autoOpen);
      const ctx=msgs.slice(-10).filter(m=>m.text&&!m.thinking&&m.text!=='__NO_MODEL__').map(m=>({role:m.role==='ai'?'assistant':'user',content:m.text}));
      const[result]=await Promise.all([
        eng.current.chat.completions.create({messages:[{role:'system',content:sys},...ctx,{role:'user',content:text}],stream:false}),
        new Promise(r=>setTimeout(r,700))
      ]);
      const aiText=result.choices[0].message.content;
      updateMsgs(curId,m=>{const n=[...m];const i=n.findIndex(x=>x.id===tid);if(i!==-1)n[i]={...n[i],thinking:false,text:aiText,isNew:true};return n;});
    }catch(e){
      console.error(e);
      updateMsgs(curId,m=>{const n=[...m];const i=n.findIndex(x=>x.id===tid);if(i!==-1)n[i]={...n[i],thinking:false,text:`⚠️ Error: ${e.message}`,isNew:true};return n;});
    }
    setBusy(false);
    setTimeout(()=>iRef.current?.focus(),50);
  };

  const onKey=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}};
  const latestAI=(()=>{for(let i=msgs.length-1;i>=0;i--)if(msgs[i].role==='ai')return i;return-1;})();

  /* ── stages ── */
  if(stage==='onboarding')return React.createElement(Onboarding,{onDone:()=>setStage('modelselect')});
  if(stage==='modelselect')return React.createElement(ModelSelect,{onSelect:initAI,onSkip:skipToMain,gpuErr});
  if(stage==='loading')return React.createElement('div',{className:'ldr'},
    React.createElement(Loader,{size:'loader-md',cls:'pulsing'}),
    React.createElement('p',{className:'ldr-msg'},lmsg),
    React.createElement('div',{className:'ptrack'},React.createElement('div',{className:'pfill',style:{width:`${lpct}%`}})),
    React.createElement('p',{className:'ldr-hint'},'Cached after first download — next load is instant.')
  );

  /* ── MAIN ── */
  const noModelBanner=!model&&React.createElement('div',{style:{position:'fixed',bottom:'calc(var(--inp) + 8px)',left:'50%',transform:'translateX(-50%)',zIndex:800,whiteSpace:'nowrap'}},
    React.createElement('div',{style:{display:'flex',alignItems:'center',gap:8,padding:'7px 14px',borderRadius:10,background:'rgba(168,156,247,.12)',border:'1px solid rgba(168,156,247,.28)',fontSize:'.75rem',color:'var(--ac)',cursor:'pointer'},onClick:()=>setStage('modelselect')},
      React.createElement('span',{className:'material-symbols-outlined',style:{fontSize:15}},'download'),
      'No AI model loaded — click to load one'
    )
  );

  return React.createElement(React.Fragment,null,
    sets&&React.createElement(Settings,{onClose:()=>setSets(false),theme,setTheme,autoOpen,setAutoOpen,model,onLoadModel:()=>setStage('modelselect'),onClear:()=>{const id=uid();setConvs([{id,title:'Chat 1',msgs:[]}]);setCurId(id);}}),
    noModelBanner,

    /* NAV */
    React.createElement('nav',{className:'nav'},
      React.createElement('div',{className:'nav-brand'},
        React.createElement(Loader,{size:'loader-nav',cls:chatActive?'pulsing':''}),
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
      convs.map(c=>React.createElement('div',{key:c.id,className:`tab${c.id===curId?' active':''}`,onClick:()=>setCurId(c.id)},
        React.createElement('span',{className:'tab-title'},c.title),
        React.createElement('span',{className:'tab-x',onClick:e=>{e.stopPropagation();deleteConv(c.id);}},React.createElement('span',{className:'material-symbols-outlined'},'close'))
      )),
      React.createElement('div',{className:'new-tab',onClick:newConv,title:'New chat'},React.createElement('span',{className:'material-symbols-outlined'},'add'))
    ),

    /* TOP AD */
    React.createElement('div',{className:'top-ad'},'ads go here'),

    /* LAYOUT */
    React.createElement('div',{className:'layout'},
      React.createElement('div',{className:'chat-col'},
        React.createElement('div',{className:'msgs'},
          msgs.length===0
            ?React.createElement('div',{className:'welcome'},
                React.createElement('div',{className:'w-loader'},React.createElement(Loader,{size:'loader-xl',cls:model?'':''})),
                React.createElement('h2',{className:'wt'},"Hey, I'm Dash."),
                React.createElement('p',{className:'ws'},model?'Your on-device AI. Ask me anything, open sites, write code — totally offline.':'Load a model from settings to get started, or explore the UI first.'),
                React.createElement('div',{className:'chips'},CHIPS.map(c=>React.createElement('div',{key:c,className:'chip',onClick:()=>send(c)},c)))
              )
            :React.createElement('div',{className:'mlist'},
                msgs.map((msg,i)=>{
                  /* Special no-model message */
                  if(msg.role==='ai'&&msg.text==='__NO_MODEL__')return React.createElement('div',{key:msg.id||i,className:'mrow a'},
                    React.createElement('div',{className:'bub a'},
                      React.createElement('div',{className:'no-model-warn'},
                        React.createElement('span',{className:'material-symbols-outlined'},'warning'),
                        React.createElement('span',null,'Please load an AI model first. ',
                          React.createElement('span',{style:{color:'var(--ac)',cursor:'pointer',textDecoration:'underline'},onClick:()=>setStage('modelselect')},'Click here to load one'),
                          ' — it downloads once and is cached.'
                        )
                      )
                    )
                  );
                  return React.createElement(Bubble,{key:msg.id||i,msg,isLatest:i===latestAI,autoOpen});
                }),
                React.createElement('div',{ref:endR})
              )
        ),
        React.createElement('div',{className:'inputz'},
          React.createElement('div',{className:'ibar'},
            React.createElement('div',{style:{flexShrink:0,opacity:.45,display:'flex',alignItems:'center'}},React.createElement(Loader,{size:'loader-inp',cls:busy?'pulsing':''})),
            React.createElement('input',{ref:iRef,
              placeholder:model?(autoOpen?'Ask Dash — links open automatically…':'Ask Dash anything…'):'No model loaded — load one from settings to start chatting',
              value:q,onChange:e=>setQ(e.target.value),onKeyDown:onKey,disabled:busy})
          ),
          React.createElement('button',{className:'sbtn',onClick:()=>send(),disabled:busy||!q.trim()},React.createElement('span',{className:'material-symbols-outlined'},busy?'hourglass_top':'arrow_upward'))
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
