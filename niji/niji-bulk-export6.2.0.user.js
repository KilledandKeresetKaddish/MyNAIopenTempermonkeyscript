// ==UserScript==
// @name         Niji Journey 批量/逐组导出
// @name:zh-CN   Niji Journey 批量/逐组导出
// @namespace    https://nijijourney.com/
// @version      6.2.0
// @description  Niji/Midjourney 图片批量导出工具 | 选择模式批量导出 | 2x2 网格合成 | Lightbox 原图+Seed 下载 | 参考图批量下载 (SR/CR/IP) | WebP/PNG 格式 | 质量/缩放可调 | 自动获取 Seed (API) | 完整 prompt + 参数提取 (React fiber) | mem-portable-metadata-v1 XMP | PNG tEXt | NJEX 签名 | CreatorTool 标记
// @author       adonais & Claude
// @match        https://nijijourney.com/*
// @match        https://www.nijijourney.com/*
// @match        https://www.midjourney.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      cdn.midjourney.com
// @connect      cdn.nijijourney.com
// @connect      midjourney.com
// @connect      www.midjourney.com
// @connect      nijijourney.com
// @connect      s.mj.run
// @connect      *
// @run-at       document-start
// ==/UserScript==

/*
 * ╔═══════════════════════════════════════════════════════════════════╗
 * ║  Niji Journey 批量/逐组导出  v6.2.0                              ║
 * ╠═══════════════════════════════════════════════════════════════════╣
 * ║                                                                   ║
 * ║  ■ 数据获取                                                       ║
 * ║    · React fiber 遍历: 从页面 React 组件树中提取 job 对象          ║
 * ║    · prompt 对象解析: decodedPrompt / personalize / styleRef 等    ║
 * ║      均为数组嵌套对象, 逐字段正确提取                               ║
 * ║    · job_type 解析: "v6_raw_diffusion_anime" → --niji 6 --raw     ║
 * ║    · /api/get-seed API: 自动获取 seed (可关闭, 批量时加延迟)       ║
 * ║    · CDN URL 构造: 不在视口内的 job 直接用 jobId 拼图片地址        ║
 * ║    · fetch / XHR / WebSocket hook: 拦截页面网络请求捕获 job 数据   ║
 * ║    · Clipboard hook: 捕获用户手动复制的 seed                       ║
 * ║                                                                   ║
 * ║  ■ 图片处理                                                       ║
 * ║    · 4 图 → 2×2 网格合成 (单图直接输出)                            ║
 * ║    · 格式: WebP (有损, 可调质量) / PNG (无损)                      ║
 * ║    · 缩放: 10%-100% 滑块控制输出尺寸                               ║
 * ║    · 蓝通道 LSB 随机化: 防止 canvas 编码被误判为 LSB 水印          ║
 * ║    · NJEX 签名: 最后一行前 32px 蓝通道 LSB 写入 "NJEX" (PNG 可靠) ║
 * ║                                                                   ║
 * ║  ■ 元数据写入                                                     ║
 * ║    · WebP: XMP chunk (mem-portable-metadata-v1 schema)            ║
 * ║      - dc:description: 完整 prompt + flags + Job ID               ║
 * ║      - xmp:CreatorTool: "NijiExport" (用于来源识别)               ║
 * ║      - mem:PortableMetadata: JSON (prompt/jobId/seed/params/...)  ║
 * ║    · PNG: tEXt chunks                                             ║
 * ║      - Description: 完整 prompt + flags + Job ID                  ║
 * ║      - Software: "Midjourney / NijiExport"                        ║
 * ║      - Comment: JSON {prompt, jobId, seed}                        ║
 * ║                                                                   ║
 * ║  ■ 导出模式                                                       ║
 * ║    · 单个导出: 💾 按钮直接导出当前 job                             ║
 * ║    · 选择模式: ☐/☑ 多选 → 批量导出已选                            ║
 * ║    · 全选可见 / 取消全选                                           ║
 * ║    · 已导出记录 (localStorage): 跳过/标记已导出的 job              ║
 * ║    · Lightbox 增强下载: 详情页官方下载按钮旁增加 [↓+S] 按钮       ║
 * ║      下载 CDN 原始 PNG (零质量损失) + 注入 seed 和完整元数据       ║
 * ║    · 参考图批量下载: 📎 按钮下载 SR/CR/IP 参考图, 文件名标注类型  ║
 * ║      SR = Style Reference, CR = Character Reference, IP = Image   ║
 * ║                                                                   ║
 * ║  ■ 来源识别 (供外部工具检测)                                       ║
 * ║    · XMP CreatorTool == "NijiExport"  (WebP/PNG 均可靠)           ║
 * ║    · 蓝通道 LSB "NJEX" 签名          (仅 PNG 可靠)               ║
 * ║    · 不写 ColorProfile key, 不写 MEM LSB 水印                     ║
 * ║                                                                   ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 */

(function () {
  'use strict';
  const TAG='%c[NijiExport]',STY='color:#d14836;font-weight:600';
  const log=(...a)=>console.log(TAG,STY,...a),warn=(...a)=>console.warn(TAG,STY,...a);
  const uw=typeof unsafeWindow!=='undefined'?unsafeWindow:window;

  // ============================== CONFIG ==============================
  const CONFIG = {
    format: 'webp',      // 'webp' | 'png'
    quality: 0.85,       // webp quality 0-1
    scale: 100,          // % of original size
    downloadDelayMs: 300,
    fetchSeed: true,     // 是否调 API 获取 seed
    _batchMode: false,   // 内部: 批量模式时加延迟
  };

  const EXP_KEY='nijiExport.exportedJids';
  function loadExp(){try{return new Set(JSON.parse(localStorage.getItem(EXP_KEY)||'[]'));}catch{return new Set();}}
  function saveExp(s){try{localStorage.setItem(EXP_KEY,JSON.stringify([...s]));}catch{}}
  const exportedJids=loadExp();

  // ============================== CACHE ==============================
  const jobCache=new Map(),cacheListeners=new Set(),selectedJobs=new Set();
  const promptMemo=new Map(); // jobId -> { prompt, params, at }
  let reactDone=false, selectMode=false;
  function fire(){cacheListeners.forEach(fn=>{try{fn();}catch{}});}
  function upsertJobs(arr,tag=''){let a=0,e=0;for(const j of arr){if(!j||typeof j!=='object')continue;const id=j.id||j.uuid||j.job_id;if(!id||typeof id!=='string')continue;if(!(j.image_paths||j.imagePaths||j.paths||j.full_command||j.prompt||j.items))continue;const p=jobCache.get(id);if(!p){jobCache.set(id,Object.assign({},j,{id}));a++;}else{let g=false;const n=Object.assign({},p);for(const k of Object.keys(j)){if(p[k]==null&&j[k]!=null){n[k]=j[k];g=true;}}if(g){jobCache.set(id,n);e++;}}}if(a||e){log(`[${tag}] +${a}/~${e} (${jobCache.size})`);fire();}return a+e;}
  function extractArr(d){if(!d)return[];if(Array.isArray(d))return d;if((d.id||d.uuid)&&(d.image_paths||d.imagePaths||d.full_command||d.prompt||d.items))return[d];for(const k of['jobs','data','results','items','feed','records','messages','message','job','payload']){if(Array.isArray(d[k]))return d[k];if(d[k]&&typeof d[k]==='object'){const s=extractArr(d[k]);if(s.length)return s;}}for(const v of Object.values(d)){if(Array.isArray(v)&&v.length&&v[0]&&(v[0].image_paths||v[0].imagePaths||v[0].items))return v;}return[];}
  function tryCapture(s,d,t){try{const a=extractArr(d);if(a.length)upsertJobs(a,t||s);}catch{}}

  // ============================== HOOKS ==============================
  const oF=window.fetch;window.fetch=function(i,init){const p=oF.apply(this,arguments);p.then(r=>{try{const u=typeof i==='string'?i:i?.url||'';if(r.headers.get('content-type')?.includes('json')&&/\/api\//.test(u))r.clone().json().then(d=>tryCapture(u,d,'fetch')).catch(()=>{});}catch{}}).catch(()=>{});return p;};
  const oO=XMLHttpRequest.prototype.open,oS=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(m,u){this.__u=u;return oO.apply(this,arguments);};XMLHttpRequest.prototype.send=function(){const x=this;this.addEventListener('load',()=>{try{if(!/\/api\//.test(x.__u||''))return;const t=x.responseType===''||x.responseType==='text'?x.responseText:x.response;tryCapture(x.__u,typeof t==='string'?JSON.parse(t):t,'xhr');}catch{}});return oS.apply(this,arguments);};
  const OWS=window.WebSocket;try{window.WebSocket=new Proxy(OWS,{construct(t,a){const ws=Reflect.construct(t,a);ws.addEventListener('message',e=>{try{let p;if(typeof e.data==='string')try{p=JSON.parse(e.data);}catch{}if(p)tryCapture(a[0],p,'ws');}catch{}});return ws;}});['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(k=>{try{window.WebSocket[k]=OWS[k];}catch{}});}catch{}
  log('hooks 就绪');
  function readInit(){try{return JSON.parse(document.getElementById('initialProps')?.textContent);}catch{return null;}}

  // ============================== REACT FIBER ==============================
  function gFib(el){if(!el)return null;for(const k of Object.keys(el))if(k.startsWith('__reactFiber$')||k.startsWith('__reactInternalInstance$'))return el[k];return null;}
  function isJob(o){if(!o||typeof o!=='object')return false;const id=o.id||o.uuid;return!!(id&&typeof id==='string'&&/^[a-f0-9]{8}-/i.test(id)&&(o.image_paths||o.imagePaths||o.full_command||o.prompt||o.items));}
  function scanJ(n,r,v,d){if(!n||typeof n!=='object'||d>8||v.has(n))return;v.add(n);if(isJob(n)){r.push(n);return;}if(n.nodeType)return;if(Array.isArray(n)){for(const i of n)scanJ(i,r,v,d+1);}else{for(const val of Object.values(n))if(val&&typeof val==='object')scanJ(val,r,v,d+1);}}
  function findJobs(el,wId){if(!el)return[];const f=[];let e=el;for(let d=0;d<15&&e&&e!==document.body;d++){const fb=gFib(e);if(fb){let ff=fb;for(let i=0;i<50&&ff;i++){for(const c of[ff.memoizedProps,ff.pendingProps,ff.memoizedState]){if(!c)continue;const r=[];scanJ(c,r,new WeakSet(),0);for(const j of r){const jid=j.id||j.uuid;if(wId&&jid!==wId)continue;if(!f.some(x=>(x.id||x.uuid)===jid))f.push(j);}}ff=ff.return;}}if(wId&&f.length)break;e=e.parentElement;}return f;}
  function harvest(){try{const fb=gFib(document.getElementById('root'))||gFib(document.body);if(!fb)return 0;const res=[],vp=new WeakSet(),vf=new WeakSet();(function w(f,d){if(!f||d>200||vf.has(f))return;vf.add(f);for(const c of[f.memoizedProps,f.memoizedState]){if(c&&typeof c==='object'&&!vp.has(c)){vp.add(c);scanJ(c,res,new WeakSet(),0);}}if(f.child)w(f.child,d+1);if(f.sibling)w(f.sibling,d);})(fb,0);const u=new Map();for(const j of res){const id=j.id||j.uuid;if(id&&!u.has(id))u.set(id,j);}reactDone=true;return upsertJobs([...u.values()],'react');}catch(e){warn('harvest:',e.message);return 0;}}

  // ============================== PROMPT EXTRACTION ==============================
  function safeStr(v){if(v==null)return null;if(typeof v==='string')return v||null;if(typeof v==='number')return String(v);if(typeof v==='boolean')return v?'true':null;if(Array.isArray(v)){const f=v.map(x=>typeof x==='string'?x:typeof x==='object'&&x?(x.content||x.code||x.id||x.value||''):String(x));return f.filter(Boolean).join(',')||null;}if(typeof v==='object'){if('w' in v&&'h' in v)return`${v.w}:${v.h}`;if('width' in v&&'height' in v)return`${v.width}:${v.height}`;if(v.content)return String(v.content);if(v.code)return String(v.code);if(v.value)return String(v.value);return null;}return String(v);}

  function extractPromptObj(p){
    if(!p||typeof p!=='object')return null;
    let text='';
    const dp=p.decodedPrompt;
    if(typeof dp==='string'&&dp.length>2) text=dp;
    else if(Array.isArray(dp)&&dp.length) text=dp.map(i=>typeof i==='string'?i:(i?.content||'')).filter(Boolean).join(' ');
    if(!text){for(const k of['prompt','text','rawPrompt','input','description']){const v=p[k];if(typeof v==='string'&&v.length>5){text=v;break;}if(Array.isArray(v)&&v.length){const t=v.map(i=>typeof i==='string'?i:(i?.content||'')).filter(Boolean).join(' ');if(t.length>5){text=t;break;}}}}
    let seed=null;const rs=p.seed;if(typeof rs==='number'&&rs>0)seed=rs;else if(typeof rs==='string'&&/^\d+$/.test(rs))seed=parseInt(rs);
    const params={};
    const arVal=safeStr(p.ar);if(arVal&&arVal.includes(':'))params.ar=arVal;
    const sty=safeStr(p.stylize);if(sty&&sty!=='0')params.stylize=sty;
    if(p.styleRaw===true||p.styleRaw==='true'||p.styleRaw===1)params.raw='true';
    if(p.tile===true)params.tile='true';
    if(p.video===true)params.video='true';
    const chaos=safeStr(p.chaos);if(chaos&&chaos!=='0')params.chaos=chaos;
    const weird=safeStr(p.weird);if(weird&&weird!=='0')params.weird=weird;
    const quality=safeStr(p.quality);if(quality&&quality!=='1'&&quality!=='0')params.q=quality;
    const stop=safeStr(p.stop);if(stop&&stop!=='100'&&stop!=='0')params.stop=stop;
    const iw=safeStr(p.imageWeight);if(iw&&iw!=='0'&&iw!=='1')params.iw=iw;
    const noVal=safeStr(p.no);if(noVal)params.no=noVal;
    const pers=safeStr(p.personalize);if(pers&&pers!=='false'&&pers!=='0')params.profile=pers;
    const sref=safeStr(p.styleRef);if(sref)params.sref=sref;
    const cref=safeStr(p.characterRef);if(cref)params.cref=cref;
    const sw=safeStr(p.sw);if(sw&&sw!=='0'&&sw!=='100')params.sw=sw;
    const cw=safeStr(p.cw);if(cw&&cw!=='0'&&cw!=='100')params.cw=cw;
    const ver=safeStr(p.version);if(ver)params._version=ver;
    const profile=safeStr(p.profile);if(profile&&!params.profile)params.profile=profile;
    for(const k of['styleProfile','style_profile','profileCode']){if(!params.profile&&p[k]){const v=safeStr(p[k]);if(v)params.profile=v;}}
    return{text,seed,params};
  }

  function parseJobType(jt){if(!jt||typeof jt!=='string')return{};const r={};const m=jt.match(/v(\d+(?:\.\d+)?)/);if(m)r.version=m[1];r.isNiji=/anime|niji/i.test(jt);r.isRaw=/raw/i.test(jt);return r;}
  function firstStr(...v){for(const s of v)if(typeof s==='string'&&s.length)return s;return '';}
  const BOOL_RE=/^(raw|tile|turbo|relax|fast|draft|video|motion)$/i;
  function p2cli(params){return Object.entries(params).filter(([k,v])=>v&&v!=='null'&&v!=='undefined'&&!k.startsWith('_')).map(([k,v])=>(v==='true'||BOOL_RE.test(k))?`--${k}`:`--${k} ${v}`).join(' ');}
  function parsePromptAndParamsFromText(fc){
    const out={prompt:'',params:{}};
    if(typeof fc!=='string'||!fc.trim())return out;
    if(fc.includes('--')){
      const idx=fc.indexOf('--');
      out.prompt=fc.slice(0,idx).trim();
      const re=/--(\w+)(?:\s+([^-\s][^\s]*(?:\s+[^-\s][^\s]*)*?))?(?=\s+--|\s*$)/g;
      let m;while((m=re.exec(fc.slice(idx)))!==null)out.params[m[1]]=m[2]===undefined?'true':m[2].trim();
    }else out.prompt=fc.trim();
    return out;
  }
  function mergePromptFromJobRecord(jobLike, state){
    if(!jobLike||typeof jobLike!=='object')return;
    const pObj=jobLike.prompt;
    if(pObj&&typeof pObj==='object'&&!Array.isArray(pObj)){
      const ex=extractPromptObj(pObj);
      if(ex){
        if(!state.prompt&&ex.text)state.prompt=ex.text;
        Object.assign(state.params,ex.params);
      }
    }
    if(!state.prompt){
      const fc=firstStr(jobLike.full_command,typeof jobLike.prompt==='string'?jobLike.prompt:'',jobLike.prompt_text);
      const parsed=parsePromptAndParamsFromText(fc);
      if(parsed.prompt)state.prompt=parsed.prompt;
      Object.assign(state.params,parsed.params);
    }
  }
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));

  // ============================== IMAGE ==============================
  function gmBlob(u){return new Promise((ok,no)=>{GM_xmlhttpRequest({method:'GET',url:u,responseType:'blob',onload:r=>r.status<300?ok(r.response):no(new Error('HTTP '+r.status)),onerror:()=>no(new Error('Net')),ontimeout:()=>no(new Error('Timeout'))});});}
  function b2img(b){return new Promise((ok,no)=>{const u=URL.createObjectURL(b);const i=new Image();i.onload=()=>{URL.revokeObjectURL(u);ok(i);};i.onerror=()=>{URL.revokeObjectURL(u);no(new Error('dec'));};i.src=u;});}

  async function compose(blobs, scale) {
    const imgs = await Promise.all(blobs.map(b2img));
    const is2x2 = blobs.length >= 4;
    let tw, th;
    if (is2x2) {
      tw = imgs[0].naturalWidth; th = imgs[0].naturalHeight;
      const s = scale / 100;
      tw = Math.max(1, Math.round(tw * s)); th = Math.max(1, Math.round(th * s));
      const c = document.createElement('canvas');
      c.width = tw * 2; c.height = th * 2;
      const x = c.getContext('2d');
      [[0,0],[tw,0],[0,th],[tw,th]].forEach(([px,py],i) => x.drawImage(imgs[i], px, py, tw, th));
      return c;
    } else {
      const img = imgs[0];
      let w = img.naturalWidth, h = img.naturalHeight;
      const s = scale / 100;
      w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      return c;
    }
  }

  function canvasToBlob(canvas, format, quality) {
    const mime = format === 'png' ? 'image/png' : 'image/webp';
    return new Promise((ok, no) => {
      canvas.toBlob(b => b ? ok(b) : no(new Error(format + ' encode failed')), mime, format === 'webp' ? quality : undefined);
    });
  }

  // ============================== METADATA ==============================
  // WebP XMP
  async function embedWebpXmp(blob,xml,w,h){const b=new Uint8Array(await blob.arrayBuffer());const d=new DataView(b.buffer);const s=(o,l)=>String.fromCharCode(...b.subarray(o,o+l));if(s(0,4)!=='RIFF'||s(8,4)!=='WEBP')throw new Error('not webp');if(s(12,4)==='VP8X')throw new Error('VP8X');const fs=d.getUint32(16,true);const fp=fs+(fs&1);const pay=b.subarray(12,20+fp);const vp=new Uint8Array(18);vp.set([86,80,56,88],0);new DataView(vp.buffer).setUint32(4,10,true);vp[8]=4;const w1=w-1,h1=h-1;vp[12]=w1&255;vp[13]=(w1>>8)&255;vp[14]=(w1>>16)&255;vp[15]=h1&255;vp[16]=(h1>>8)&255;vp[17]=(h1>>16)&255;const xb=new TextEncoder().encode(xml);const xc=new Uint8Array(8+xb.length+(xb.length&1));xc.set([88,77,80,32],0);new DataView(xc.buffer).setUint32(4,xb.length,true);xc.set(xb,8);const inner=4+vp.length+pay.length+xc.length;const out=new Uint8Array(8+inner);out.set([82,73,70,70],0);new DataView(out.buffer).setUint32(4,inner,true);out.set([87,69,66,80],8);let o=12;out.set(vp,o);o+=vp.length;out.set(pay,o);o+=pay.length;out.set(xc,o);return new Blob([out],{type:'image/webp'});}

  // PNG tEXt chunk injection
  async function embedPngText(blob, entries) {
    // entries: [{keyword, text}]
    const buf = new Uint8Array(await blob.arrayBuffer());
    // PNG: 8-byte sig + chunks. Insert tEXt after IHDR (first chunk)
    const sig = buf.subarray(0, 8);
    // IHDR chunk: 4(len) + 4(IHDR) + 13(data) + 4(crc) = 25 bytes
    const ihdrLen = new DataView(buf.buffer).getUint32(8);
    const ihdrEnd = 8 + 12 + ihdrLen; // sig + len + type + data + crc
    const before = buf.subarray(0, ihdrEnd);
    const after = buf.subarray(ihdrEnd);

    // Build tEXt chunks
    const enc = new TextEncoder();
    const chunks = [];
    for (const {keyword, text} of entries) {
      const kw = enc.encode(keyword);
      const tx = enc.encode(text);
      const data = new Uint8Array(kw.length + 1 + tx.length);
      data.set(kw, 0);
      data[kw.length] = 0; // null separator
      data.set(tx, kw.length + 1);
      // chunk = len(4) + "tEXt"(4) + data + crc(4)
      const chunk = new Uint8Array(12 + data.length);
      new DataView(chunk.buffer).setUint32(0, data.length);
      chunk.set(enc.encode('tEXt'), 4);
      chunk.set(data, 8);
      const crc = crc32(chunk.subarray(4, 8 + data.length));
      new DataView(chunk.buffer).setUint32(8 + data.length, crc);
      chunks.push(chunk);
    }
    const totalChunkLen = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(before.length + totalChunkLen + after.length);
    out.set(before, 0);
    let off = before.length;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    out.set(after, off);
    return new Blob([out], { type: 'image/png' });
  }

  // CRC32 for PNG
  const crc32 = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c;
    }
    return (data) => {
      let crc = 0xFFFFFFFF;
      for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
      return (crc ^ 0xFFFFFFFF) >>> 0;
    };
  })();

  const xe=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  function buildXmpXml({prompt,fullCommand,jobId,seed,params,author}){const cli=fullCommand||(prompt+(Object.keys(params).length?' '+p2cli(params):'')).trim();const desc=`${cli}${jobId?' Job ID: '+jobId:''}`;const mem={schema:"mem-portable-metadata-v1",exportDate:new Date().toISOString(),imageFormat:CONFIG.format,note:"NijiExport",formData:{title:"",description:desc,software:"Midjourney",source:"",comment:{prompt:cli}},steganographyMetadata:null,detectedSourceType:"midjourney",comfyPromptData:null,comfyWorkflowData:null,sdParsedParams:null,mjMetadata:{description:desc,author:author||'',creationTime:new Date().toUTCString(),jobId:jobId||'',seed:seed??null,params:params||{}}};const json=JSON.stringify(mem).replace(/]]>/g,']]]]><![CDATA[>');return{desc,xmp:`<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/">\n <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n  <rdf:Description rdf:about="" xmlns:mem="https://mem.local/ns/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/">\n   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xe(desc)}</rdf:li></rdf:Alt></dc:description>\n   <photoshop:Source>Midjourney</photoshop:Source>\n   <xmp:CreatorTool>NijiExport</xmp:CreatorTool>\n   <mem:PortableMetadata><![CDATA[${json}]]></mem:PortableMetadata>\n  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>`};}

  // ============================== HELPERS ==============================
  const sanitize=(s,m=64)=>!s?'':s.replace(/[\\/:*?"<>|]/g,'').replace(/\s+/g,'_').replace(/[\x00-\x1f]/g,'').slice(0,m);
  function fmtDate(d){try{let dt;if(typeof d==='number')dt=new Date(d>1e12?d:d*1000);else if(d)dt=new Date(d);else dt=new Date();if(isNaN(dt))return'';const p=n=>String(n).padStart(2,'0');return`${dt.getFullYear()}${p(dt.getMonth()+1)}${p(dt.getDate())}`;}catch{return'';}}
  function dlBlob(b,fn){const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download=fn;document.body.appendChild(a);a.click();setTimeout(()=>{a.remove();URL.revokeObjectURL(u);},100);}
  const CDN='https://cdn.midjourney.com';
  function normUrl(p){if(!p||typeof p!=='string')return null;if(p.startsWith('http'))return p;if(p.startsWith('//'))return'https:'+p;return CDN+(p.startsWith('/')?'':'/')+p;}
  function fullQ(u){try{const x=new URL(u);x.pathname=x.pathname.replace(/(\/[^\/]+?)_\d+_N(\.(?:webp|png|jpe?g))$/i,'$1$2');x.search='';return x.toString();}catch{return u;}}

  // ============================== PROCESS JOB ==============================
  async function processJob(jobInput, rowAnchor) {
    let reactJob = null;
    if (rowAnchor) { const a = findJobs(rowAnchor, jobInput.id); if (a.length) reactJob = a[0]; }
    const cached = jobCache.get(jobInput.id) || {};
    const merged = Object.assign({}, cached, reactJob || {}, jobInput);

    let prompt = '', finalParams = {}, seed = null;

    const pObj = merged.prompt;
    if (pObj && typeof pObj === 'object' && !Array.isArray(pObj)) {
      const ex = extractPromptObj(pObj);
      if (ex) { prompt = ex.text; seed = ex.seed; Object.assign(finalParams, ex.params); }
    }
    if (!prompt) {
      const fc = firstStr(merged.full_command, typeof merged.prompt === 'string' ? merged.prompt : '', merged.prompt_text);
      if (fc.includes('--')) {
        const idx = fc.indexOf('--'); prompt = fc.slice(0, idx).trim();
        const re = /--(\w+)(?:\s+([^-\s][^\s]*(?:\s+[^-\s][^\s]*)*?))?(?=\s+--|\s*$)/g;
        let m; while ((m = re.exec(fc.slice(idx))) !== null) finalParams[m[1]] = m[2] === undefined ? 'true' : m[2].trim();
      } else { prompt = fc; }
    }

    const jt = parseJobType(merged.job_type);
    let verStr = finalParams._version || ''; delete finalParams._version;
    const nijiM = verStr.match(/niji\s*(\d+)/i), vM = verStr.match(/^(\d+(?:\.\d+)?)$/);
    if (nijiM) finalParams.niji = nijiM[1];
    else if (vM) { if (jt.isNiji) finalParams.niji = vM[1]; else finalParams.v = vM[1]; }
    else if (jt.version) { if (jt.isNiji && !finalParams.niji) finalParams.niji = jt.version; else if (!jt.isNiji && !finalParams.v) finalParams.v = jt.version; }
    if (jt.isRaw && !finalParams.raw) finalParams.raw = 'true';

    if (!finalParams.ar && merged.width && merged.height && merged.width !== merged.height) {
      const gcd = (a, b) => b ? gcd(b, a % b) : a, g = gcd(merged.width, merged.height);
      finalParams.ar = `${merged.width / g}:${merged.height / g}`;
    }

    const jobId = merged.id || '';

    // ★ 自动获取 seed (可关闭)
    if (seed == null && jobId && CONFIG.fetchSeed) {
      try {
        const r = await oF(`/api/get-seed?id=${encodeURIComponent(jobId)}`, {
          method: 'GET', credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Protection': '1' }
        });
        if (r.ok) {
          const d = await r.json();
          const sv = d?.seed ?? d;
          if (typeof sv === 'number' && sv > 0) seed = sv;
          else if (typeof sv === 'string' && /^\d+$/.test(sv)) seed = parseInt(sv);
        }
        // 批量时加延迟避免限流
        if (CONFIG._batchMode) await new Promise(r => setTimeout(r, 200));
      } catch {}
    }
    if (seed != null) finalParams.seed = String(seed);

    // 清理
    for (const k of Object.keys(finalParams)) {
      if (!finalParams[k] || finalParams[k] === 'null' || finalParams[k] === 'undefined' || finalParams[k] === '0' || finalParams[k] === 'false')
        delete finalParams[k];
    }

    const author = firstStr(merged.display_name, merged.username, readInit()?.profile?.display_name);
    const dateStr = fmtDate(merged.enqueue_time || merged.event_date || merged.created_at);

    // 图片
    let paths = (merged.image_paths || merged.imagePaths || merged.paths || []).map(normUrl).map(x => x ? fullQ(x) : x).filter(Boolean);
    if (!paths.length && Array.isArray(merged.items)) {
      for (const item of merged.items) { if (item) { const u = item.image_path || item.url || item.image_url || item.src; if (u) paths.push(fullQ(normUrl(u))); } }
    }
    if (!paths.length && rowAnchor) {
      const us = new Set();
      for (const img of rowAnchor.querySelectorAll('img')) { const s = img.currentSrc || img.src; if (s && findJidSrc(s) === jobId) us.add(fullQ(s)); }
      paths = [...us].sort();
    }
    // ★ 最终 fallback: 用 jobId 直接构造 CDN URL
    if (!paths.length && jobId) {
      paths = [0, 1, 2, 3].map(i => `${CDN}/${jobId}/0_${i}.webp`);
      log(`用 jobId 构造图片 URL: ${jobId.slice(0, 8)}`);
    }
    if (!paths.length) throw new Error('无图片');

    // 下载图片 (容忍部分失败,比如 upscale 只有 1 张)
    const blobResults = await Promise.allSettled(paths.map(gmBlob));
    const blobs = blobResults.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (!blobs.length) throw new Error('所有图片下载失败');
    const canvas = await compose(blobs.length >= 4 ? blobs.slice(0, 4) : blobs, CONFIG.scale);

    // ★ 蓝通道 LSB 处理:
    //   1. 全部随机化 (防止 canvas 编码规律被误判为 MEM 水印)
    //   2. 最后一行前 32px 写入 "NJEX" 签名 (4 bytes = 32 bits)
    //      检测方法: 读最后一行前 32 像素蓝通道 LSB,每 8 bit 一字节,== [0x4E,0x4A,0x45,0x58]
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = imgData.data;
    // 1) 随机化全部蓝通道 LSB
    for (let i = 2; i < px.length; i += 4) {
      px[i] = (px[i] & 0xFE) | (Math.random() > 0.5 ? 1 : 0);
    }
    // 2) 最后一行写入 NJEX 签名
    const SIG = [0x4E, 0x4A, 0x45, 0x58]; // "NJEX"
    const lastRowStart = (canvas.height - 1) * canvas.width * 4;
    if (canvas.width >= 32) {
      for (let byteIdx = 0; byteIdx < SIG.length; byteIdx++) {
        for (let bit = 7; bit >= 0; bit--) {
          const pixelIdx = byteIdx * 8 + (7 - bit);
          const offset = lastRowStart + pixelIdx * 4 + 2; // blue channel
          const bitVal = (SIG[byteIdx] >> bit) & 1;
          px[offset] = (px[offset] & 0xFE) | bitVal;
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);

    const format = CONFIG.format;
    let outBlob = await canvasToBlob(canvas, format, CONFIG.quality);

    // 嵌入 metadata
    const { desc, xmp } = buildXmpXml({ prompt, jobId, seed, params: finalParams, author });
    try {
      if (format === 'webp') {
        outBlob = await embedWebpXmp(outBlob, xmp, canvas.width, canvas.height);
      } else {
        // PNG: tEXt chunks
        outBlob = await embedPngText(outBlob, [
          { keyword: 'Description', text: desc },
          { keyword: 'Software', text: 'Midjourney / NijiExport' },
          { keyword: 'Comment', text: JSON.stringify({ prompt: (prompt + ' ' + p2cli(finalParams)).trim(), jobId, seed }) },
        ]);
      }
    } catch (e) { warn('metadata:', e.message); }

    const slug = sanitize(prompt.replace(/[,。.、]+/g, ' ').replace(/\s+/g, '_'), 48) || 'niji';
    const ext = format === 'png' ? 'png' : 'webp';
    const fn = `${dateStr || 'niji'}_${slug}_${jobId}.${ext}`;
    dlBlob(outBlob, fn);
    exportedJids.add(jobId); saveExp(exportedJids);
    return { fn, prompt, jobId, seed, params: finalParams };
  }

  // ============================== DOM SCAN ==============================
  const UUID_STR='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  const CDN_RE=new RegExp(`cdn\\.(?:midjourney|nijijourney)\\.com/(?:[^/]+/)*(${UUID_STR})/`,'i');
  const UUID_RE2=new RegExp(`(${UUID_STR})`,'i');
  function findJidSrc(s){if(!s||typeof s!=='string')return null;const m=s.match(CDN_RE)||s.match(UUID_RE2);return m?m[1].toLowerCase():null;}
  function findCont(imgs){let a=imgs[0];while(a&&a!==document.body){let ok=true;for(const i of imgs)if(!a.contains(i)){ok=false;break;}if(ok)return a;a=a.parentElement;}return null;}
  function findRow(imgs,jid){const t=findCont(imgs);if(!t)return null;let a=t;for(let i=0;i<6&&a?.parentElement&&a.parentElement!==document.body;i++){const p=a.parentElement;let other=false;for(const img of p.querySelectorAll('img')){const s=img.currentSrc||img.src;const j=findJidSrc(s);if(j&&j!==jid){other=true;break;}}if(other)break;a=p;if((a.textContent||'').replace(/\s/g,'').length>30)return a;}return a;}
  function collectImgs(jid){const r=[];for(const img of document.querySelectorAll('img')){const s=img.currentSrc||img.src;if(findJidSrc(s)===jid)r.push(img);}return r;}

  function scanInject() {
    const m = new Map();
    for (const img of document.querySelectorAll('img')) {
      const s = img.currentSrc || img.src; const j = findJidSrc(s);
      if (j) { if (!m.has(j)) m.set(j, []); m.get(j).push(img); }
    }
    for (const [jid, imgs] of m) {
      if (!imgs.length || (imgs.length !== 1 && imgs.length < 4)) continue;
      const t = findCont(imgs); if (!t) continue;
      if (t.querySelector(`.nj-btn-wrap[data-nj-job="${jid}"]`)) continue;
      addBtn(t, jid);
    }
  }

  // ============================== BUTTONS ==============================
  function addBtn(anchor, jid) {
    const cs = getComputedStyle(anchor);
    if (cs.position === 'static') anchor.style.position = 'relative';

    const wrap = document.createElement('div');
    wrap.className = 'nj-btn-wrap';
    wrap.setAttribute('data-nj-job', jid);

    // 选择 checkbox
    const cb = document.createElement('button');
    cb.type = 'button';
    cb.className = 'nj-sel-btn';
    cb.innerHTML = selectedJobs.has(jid) ? '☑' : '☐';
    if (selectedJobs.has(jid)) cb.classList.add('nj-selected');
    cb.style.display = selectMode ? '' : 'none';
    cb.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      if (selectedJobs.has(jid)) { selectedJobs.delete(jid); cb.innerHTML = '☐'; cb.classList.remove('nj-selected'); }
      else { selectedJobs.add(jid); cb.innerHTML = '☑'; cb.classList.add('nj-selected'); }
      fire();
    });
    cb.addEventListener('mousedown', e => e.stopPropagation());

    // 导出按钮
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nj-exp-btn';
    const done = exportedJids.has(jid);
    btn.innerHTML = done ? '↻' : '💾';
    if (done) btn.classList.add('nj-done');
    btn.title = jid.slice(0, 8);
    btn.addEventListener('click', async e => {
      e.preventDefault(); e.stopPropagation();
      if (btn.dataset.busy) return;
      btn.dataset.busy = '1'; btn.innerHTML = '⏳';
      try {
        const row = findRow(collectImgs(jid), jid) || anchor;
        const job = jobCache.get(jid) || { id: jid };
        const r = await processJob(job, row);
        btn.innerHTML = '✓'; btn.classList.add('nj-ok');
        log(`✓ ${r.fn} seed=${r.seed??'null'} ${p2cli(r.params)}`);
      } catch (err) {
        btn.innerHTML = '✗'; btn.classList.add('nj-bad');
        warn('err:', err);
      } finally {
        setTimeout(() => {
          btn.classList.remove('nj-ok', 'nj-bad');
          const d = exportedJids.has(jid);
          btn.innerHTML = d ? '↻' : '💾';
          if (d) btn.classList.add('nj-done');
          delete btn.dataset.busy;
        }, 2000);
      }
    });
    btn.addEventListener('mousedown', e => e.stopPropagation());

    wrap.appendChild(cb);
    wrap.appendChild(btn);
    anchor.appendChild(wrap);
  }

  function toggleSelectMode(on) {
    selectMode = on;
    for (const btn of document.querySelectorAll('.nj-sel-btn')) {
      btn.style.display = on ? '' : 'none';
    }
    if (!on) { selectedJobs.clear(); updateAllCheckboxes(); }
    fire();
  }

  function updateAllCheckboxes() {
    for (const wrap of document.querySelectorAll('.nj-btn-wrap')) {
      const jid = wrap.dataset.njJob;
      const cb = wrap.querySelector('.nj-sel-btn');
      if (cb) {
        const sel = selectedJobs.has(jid);
        cb.innerHTML = sel ? '☑' : '☐';
        cb.classList.toggle('nj-selected', sel);
      }
    }
  }

  function selectAll() {
    for (const wrap of document.querySelectorAll('.nj-btn-wrap')) {
      const jid = wrap.dataset.njJob;
      if (jid) selectedJobs.add(jid);
    }
    updateAllCheckboxes(); fire();
  }

  function selectNone() {
    selectedJobs.clear();
    updateAllCheckboxes(); fire();
  }

  // ============================== LIGHTBOX ENHANCED DOWNLOAD ==============================
  // 在 niji 的 lightbox (单图详情) 里,官方下载按钮旁加一个 "💾+seed" 按钮
  // 下载 CDN 原始 PNG → 注入 metadata (含 seed) → 保存

  function scanLightbox() {
    // 已经注入过就跳过
    if (document.querySelector('.nj-lb-btn')) return;

    // 找官方下载按钮: title="Download Image"
    const dlBtn = document.querySelector('button[title="Download Image"]');
    if (!dlBtn) return;

    // 从 URL 或图片 src 提取 jobId 和 index
    let jobId = null, imgIndex = null;

    // URL: /jobs/5f663a05-...?index=2
    const urlMatch = location.pathname.match(/\/jobs\/([a-f0-9-]{36})/i);
    if (urlMatch) jobId = urlMatch[1];
    const idxMatch = location.search.match(/index=(\d+)/);
    if (idxMatch) imgIndex = parseInt(idxMatch[1]);

    // fallback: 从 lightbox 里的大图 src 提取
    if (!jobId) {
      const lbImg = document.querySelector('.cursor-zoom-in img[src*="cdn.midjourney.com"], .cursor-zoom-out img[src*="cdn.midjourney.com"]');
      if (lbImg) {
        const src = lbImg.src || '';
        const m = src.match(/cdn\.midjourney\.com\/([a-f0-9-]{36})\/0_(\d+)/i);
        if (m) { jobId = m[1]; if (imgIndex == null) imgIndex = parseInt(m[2]); }
      }
    }

    if (!jobId) return;
    if (imgIndex == null) imgIndex = 0;

    // 创建按钮
    const btn = document.createElement('button');
    btn.className = 'nj-lb-btn';
    btn.title = '下载原图 + Seed 元数据 (NijiExport)';
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" height="18" class="shrink-0"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg><span class="nj-lb-badge">+S</span>`;

    btn.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      await lightboxDownload(btn, jobId, imgIndex);
    });

    // 插入到官方下载按钮旁边
    dlBtn.parentElement.insertBefore(btn, dlBtn.nextSibling);
    log(`lightbox 按钮已注入: ${jobId.slice(0, 8)} index=${imgIndex}`);
  }

  async function lightboxDownload(btn, jobId, imgIndex) {
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1';
    const origHtml = btn.innerHTML;
    btn.innerHTML = '⏳';

    try {
      // 1. 下载原始 PNG
      const pngUrl = `${CDN}/${jobId}/0_${imgIndex}.png`;
      log(`下载原图: ${pngUrl}`);
      const pngBlob = await gmBlob(pngUrl);

      // 2. 获取 seed
      let seed = null;
      try {
        const r = await oF(`/api/get-seed?id=${encodeURIComponent(jobId)}`, {
          method: 'GET', credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Protection': '1' }
        });
        if (r.ok) {
          const d = await r.json();
          const sv = d?.seed ?? d;
          if (typeof sv === 'number' && sv > 0) seed = sv;
          else if (typeof sv === 'string' && /^\d+$/.test(sv)) seed = parseInt(sv);
        }
      } catch {}

      // 3. 获取 prompt + params (从缓存 / fiber / DOM / 记忆)
      let prompt = '', finalParams = {};
      const memo = promptMemo.get(jobId);
      if (memo) {
        prompt = memo.prompt || '';
        Object.assign(finalParams, memo.params || {});
      }
      const cached = jobCache.get(jobId);
      if (cached) {
        const tmp = { prompt, params: finalParams };
        mergePromptFromJobRecord(cached, tmp);
        prompt = tmp.prompt;
        // job_type
        const jt = parseJobType(cached.job_type);
        let verStr = finalParams._version || ''; delete finalParams._version;
        const nijiM = verStr.match(/niji\s*(\d+)/i), vM = verStr.match(/^(\d+(?:\.\d+)?)$/);
        if (nijiM) finalParams.niji = nijiM[1];
        else if (vM) { if (jt.isNiji) finalParams.niji = vM[1]; else finalParams.v = vM[1]; }
        else if (jt.version) { if (jt.isNiji) finalParams.niji = jt.version; else finalParams.v = jt.version; }
        if (jt.isRaw && !finalParams.raw) finalParams.raw = 'true';
        if (!finalParams.ar && cached.width && cached.height && cached.width !== cached.height) {
          const gcd = (a, b) => b ? gcd(b, a % b) : a, g = gcd(cached.width, cached.height);
          finalParams.ar = `${cached.width / g}:${cached.height / g}`;
        }
      }
      // 再尝试从 lightbox 附近 React fiber 抓取一次（有时缓存尚未完整）
      if (!prompt) {
        const tmp = { prompt, params: finalParams };
        const near = findJobs(btn, jobId);
        if (near.length) {
          mergePromptFromJobRecord(near[0], tmp);
          prompt = tmp.prompt;
          if (cached) upsertJobs([near[0]], 'lightbox-fiber');
        }
      }

      // fallback: 从 lightbox DOM 读 prompt 文字
      if (!prompt) {
        const promptEl = document.querySelector('#lightboxPrompt .notranslate p');
        if (promptEl) prompt = promptEl.textContent?.trim() || '';
      }
      // ★ 随机性缺失通常是时序问题：lightbox 文案/缓存晚于点击，做短时重试
      if (!prompt) {
        for (let retry = 0; retry < 6 && !prompt; retry++) {
          await sleep(180);
          // 触发一次全量 fiber 扫描，尽量补齐 cache
          if (!cached && retry === 1) harvest();
          const latest = jobCache.get(jobId);
          if (latest) {
            const tmp = { prompt, params: finalParams };
            mergePromptFromJobRecord(latest, tmp);
            prompt = tmp.prompt;
          }
          if (!prompt) {
            const near2 = findJobs(btn, jobId);
            if (near2.length) {
              const tmp = { prompt, params: finalParams };
              mergePromptFromJobRecord(near2[0], tmp);
              prompt = tmp.prompt;
              upsertJobs([near2[0]], 'lightbox-retry-fiber');
            }
          }
          if (!prompt) {
            const promptEl2 = document.querySelector('#lightboxPrompt .notranslate p');
            if (promptEl2) prompt = promptEl2.textContent?.trim() || '';
          }
        }
      }
      // 读 tag buttons (无论是否命中缓存都补一遍，避免参数缺失)
      const tagBtns = document.querySelectorAll('#lightboxPrompt button[title]');
      for (const tb of tagBtns) {
        const span = tb.querySelector('span.text-transparent');
        if (!span) continue;
        const txt = span.textContent?.trim() || '';
        const m = txt.match(/^--(\w+)\s*(.*)/);
        if (m && !finalParams[m[1]]) finalParams[m[1]] = m[2] || 'true';
      }
      // 记忆本 job 的 prompt/params，避免同一 job 下一张图再次丢失
      if (prompt) {
        promptMemo.set(jobId, { prompt, params: Object.assign({}, finalParams), at: Date.now() });
      } else {
        warn(`lightbox prompt 为空: ${jobId.slice(0, 8)}，将只写参数。可在控制台运行 window.NijiExportDebug.dump("${jobId}") 排查`);
      }

      if (seed != null) finalParams.seed = String(seed);
      // 清理
      for (const k of Object.keys(finalParams)) {
        if (!finalParams[k] || finalParams[k] === 'null' || finalParams[k] === 'undefined' || finalParams[k] === '0' || finalParams[k] === 'false')
          delete finalParams[k];
      }

      const author = firstStr(cached?.display_name, readInit()?.profile?.display_name);
      const cli = (prompt + (Object.keys(finalParams).length ? ' ' + p2cli(finalParams) : '')).trim();
      const desc = `${cli} Job ID: ${jobId}`;

      // 4. 注入 tEXt metadata 到原始 PNG
      let outBlob = await embedPngText(pngBlob, [
        { keyword: 'Description', text: desc },
        { keyword: 'Software', text: 'Midjourney / NijiExport' },
        { keyword: 'Comment', text: JSON.stringify({ prompt: cli, jobId, seed }) },
      ]);

      // 5. 下载
      const slug = sanitize(prompt.replace(/[,。.、]+/g, ' ').replace(/\s+/g, '_'), 48) || 'niji';
      const dateStr = fmtDate(cached?.enqueue_time || cached?.created_at);
      const fn = `${dateStr || 'niji'}_${slug}_${jobId}_${imgIndex}.png`;
      dlBlob(outBlob, fn);

      btn.innerHTML = '✓';
      log(`✓ lightbox 下载: ${fn} seed=${seed ?? 'null'}`);
    } catch (err) {
      btn.innerHTML = '✗';
      warn('lightbox 下载失败:', err);
    } finally {
      setTimeout(() => { btn.innerHTML = origHtml; delete btn.dataset.busy; }, 2000);
    }
  }

  // ============================== REFERENCE IMAGE DOWNLOAD ==============================
  // 检测 sref / cref / image prompt 缩略图,添加批量下载按钮
  // 类型从 button[title] 判断:
  //   "Image Prompt"              → IP
  //   "Style Reference (--sref)"  → SR
  //   "Character Reference (--cref)" → CR

  function collectRefImages(container) {
    const refs = [];
    if (!container) return refs;
    // 缩略图按钮: <button title="Style Reference (--sref)"><img alt="https://s.mj.run/xxx">
    const btns = container.querySelectorAll('button[title*="Reference"], button[title="Image Prompt"]');
    for (const btn of btns) {
      const title = btn.getAttribute('title') || '';
      let type = 'REF';
      if (/style\s*reference/i.test(title)) type = 'SR';
      else if (/character\s*reference/i.test(title)) type = 'CR';
      else if (/image\s*prompt/i.test(title)) type = 'IP';

      const img = btn.querySelector('img');
      if (!img) continue;
      // alt 里是原始 URL (不带 ?thumb)
      let url = img.getAttribute('alt') || '';
      if (!url.startsWith('http')) continue;
      // 去掉 thumb 参数得到原图
      url = url.split('?')[0];
      refs.push({ type, url, thumbSrc: img.src });
    }
    return refs;
  }

  function scanRefButtons() {
    // 在列表页: 每组的参考图区域 (prompt 旁边的缩略图行)
    // 在 lightbox: #lightboxPrompt 里的缩略图
    const containers = new Set();

    // lightbox
    const lb = document.querySelector('#lightboxPrompt');
    if (lb) containers.add(lb);

    // 列表页: 找包含参考图缩略图的容器
    for (const btn of document.querySelectorAll('button[title*="Reference"], button[title="Image Prompt"]')) {
      // 向上找到包含所有参考图的行容器
      let parent = btn.parentElement;
      if (parent && !parent.querySelector('.nj-ref-dl')) {
        containers.add(parent);
      }
    }

    for (const container of containers) {
      if (container.querySelector('.nj-ref-dl')) continue;
      const refs = collectRefImages(container);
      if (!refs.length) continue;

      // 提取 jobId (从旁边的图片或 URL)
      let jobId = '';
      // 尝试从 URL
      const urlMatch = location.pathname.match(/\/jobs\/([a-f0-9-]{36})/i);
      if (urlMatch) jobId = urlMatch[1];
      // 尝试从附近的 CDN 图片
      if (!jobId) {
        const nearbyImgs = (container.closest('[data-nj-job]') || container.parentElement)?.querySelectorAll('img[src*="cdn.midjourney.com"]') || [];
        for (const img of nearbyImgs) {
          const m = (img.src || '').match(/cdn\.midjourney\.com\/([a-f0-9-]{36})/i);
          if (m) { jobId = m[1]; break; }
        }
      }

      // 创建下载按钮
      const dlBtn = document.createElement('button');
      dlBtn.type = 'button';
      dlBtn.className = 'nj-ref-dl';
      const summary = refs.map(r => r.type).join('+');
      dlBtn.innerHTML = `<span class="nj-ref-ico">📎</span><span class="nj-ref-label">${refs.length} 参考图</span>`;
      dlBtn.title = `下载 ${refs.length} 张参考图 (${summary})`;

      dlBtn.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        await downloadRefImages(dlBtn, refs, jobId);
      });
      dlBtn.addEventListener('mousedown', e => e.stopPropagation());

      container.appendChild(dlBtn);
    }
  }

  async function downloadRefImages(btn, refs, jobId) {
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1';
    const origHtml = btn.innerHTML;
    btn.innerHTML = `<span class="nj-ref-ico">⏳</span><span class="nj-ref-label">0/${refs.length}</span>`;

    let ok = 0, fail = 0;
    const prefix = jobId ? jobId.slice(0, 8) : 'niji';

    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      btn.innerHTML = `<span class="nj-ref-ico">⏳</span><span class="nj-ref-label">${i + 1}/${refs.length}</span>`;
      try {
        const blob = await gmBlob(ref.url);
        // 猜扩展名
        const ct = blob.type || '';
        let ext = 'jpg';
        if (ct.includes('png')) ext = 'png';
        else if (ct.includes('webp')) ext = 'webp';
        else if (ct.includes('gif')) ext = 'gif';

        // 从 URL 提取短 ID
        const urlSlug = ref.url.split('/').pop()?.slice(0, 12) || `${i}`;

        const fn = `${prefix}_${ref.type}_${i + 1}_${urlSlug}.${ext}`;
        dlBlob(blob, fn);
        ok++;
        log(`✓ 参考图: ${fn} (${ref.type})`);
      } catch (err) {
        fail++;
        warn(`✗ 参考图 ${ref.type}_${i + 1}:`, err.message);
      }
      // 短延迟避免浏览器拦截多次下载
      await new Promise(r => setTimeout(r, 200));
    }

    btn.innerHTML = `<span class="nj-ref-ico">${fail ? '⚠' : '✓'}</span><span class="nj-ref-label">${ok}✓${fail ? ' ' + fail + '✗' : ''}</span>`;
    setTimeout(() => { btn.innerHTML = origHtml; delete btn.dataset.busy; }, 2500);
  }

  // ============================== OBSERVER ==============================
  let st = null;
  function sched() { if (st) return; st = setTimeout(() => { st = null; try { scanInject(); scanLightbox(); scanRefButtons(); } catch (e) { warn(e); } }, 250); }
  function startObs() {
    if (!document.body) { setTimeout(startObs, 50); return; }
    new MutationObserver(sched).observe(document.body, { childList: true, subtree: true });
    sched();
    window.addEventListener('load', () => { sched(); setTimeout(() => { if (!reactDone) harvest(); }, 2000); });
    setInterval(sched, 3000);
  }

  // ============================== DEBUG HELPERS ==============================
  uw.NijiExportDebug = Object.assign(uw.NijiExportDebug || {}, {
    dump(jobId) {
      const id = (jobId || location.pathname.match(/\/jobs\/([a-f0-9-]{36})/i)?.[1] || '').toLowerCase();
      if (!id) { console.warn('[NijiExportDebug] 未提供 jobId 且当前 URL 不含 /jobs/{id}'); return null; }
      const cached = jobCache.get(id) || null;
      const memo = promptMemo.get(id) || null;
      const near = findJobs(document.querySelector('button[title="Download Image"]') || document.body, id);
      const promptEl = document.querySelector('#lightboxPrompt .notranslate p');
      const tags = [...document.querySelectorAll('#lightboxPrompt button[title] span.text-transparent')].map(x => x.textContent?.trim()).filter(Boolean);
      const report = {
        jobId: id,
        hasCache: !!cached,
        cachePromptType: cached ? (Array.isArray(cached.prompt) ? 'array' : typeof cached.prompt) : null,
        cacheDecodedPrompt: cached?.prompt?.decodedPrompt ?? null,
        cacheFullCommand: cached?.full_command ?? null,
        cachePromptText: cached?.prompt_text ?? null,
        memo,
        nearFiberCount: near.length,
        nearFiberSample: near[0] ? {
          prompt: near[0].prompt ?? null,
          full_command: near[0].full_command ?? null,
          prompt_text: near[0].prompt_text ?? null,
          job_type: near[0].job_type ?? null,
        } : null,
        domPrompt: promptEl?.textContent?.trim() || null,
        domTags: tags,
      };
      console.log('[NijiExportDebug] dump', report);
      return report;
    }
  });

  // ============================== UI ==============================
  const STYLE = `
.nj-btn-wrap{position:absolute;bottom:6px;right:6px;z-index:50;display:flex;gap:3px;align-items:center}
.nj-lb-btn{position:relative;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:6px;border-radius:9999px;color:inherit;background:transparent;border:none;transition:opacity .15s}
.nj-lb-btn:hover{opacity:.7}
.nj-lb-badge{position:absolute;bottom:0;right:-2px;background:#d14836;color:#fff;font-size:9px;font-weight:700;line-height:1;padding:1px 3px;border-radius:3px;pointer-events:none}
.nj-ref-dl{display:inline-flex;align-items:center;gap:4px;cursor:pointer;padding:3px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:rgba(30,30,34,.8);color:#ddd;font:600 11px/1.2 system-ui;backdrop-filter:blur(4px);user-select:none;transition:all .15s;margin-left:4px;vertical-align:middle}
.nj-ref-dl:hover{background:rgba(50,50,55,.95);transform:scale(1.03)}
.nj-ref-ico{font-size:13px}
.nj-ref-label{font-size:11px}
.nj-exp-btn,.nj-sel-btn{background:rgba(30,30,34,.85);color:#fff;border:1px solid rgba(255,255,255,.15);border-radius:5px;width:28px;height:28px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;opacity:.85;transition:all .15s;backdrop-filter:blur(4px);user-select:none;padding:0;line-height:1}
.nj-exp-btn:hover,.nj-sel-btn:hover{opacity:1;transform:scale(1.08)}
.nj-exp-btn.nj-done{opacity:.6}
.nj-exp-btn.nj-ok{background:rgba(51,148,89,.95);opacity:1}
.nj-exp-btn.nj-bad{background:rgba(180,50,50,.95);opacity:1}
.nj-sel-btn{font-size:16px;background:rgba(30,30,34,.7)}
.nj-sel-btn.nj-selected{background:rgba(59,130,246,.9);border-color:rgba(59,130,246,.5)}
#nj-fab{position:fixed;z-index:999998;bottom:20px;right:20px;background:#d14836;color:#fff;padding:10px 14px;border-radius:999px;cursor:pointer;font-weight:600;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.35);font-family:system-ui;user-select:none;display:flex;align-items:center;gap:6px}
#nj-fab:hover{filter:brightness(1.12)}
#nj-fab .ct{background:rgba(0,0,0,.28);padding:1px 7px;border-radius:999px;font-size:11px}
#nj-panel{position:fixed;z-index:999999;top:16px;right:16px;width:320px;background:rgba(22,22,24,.96);color:#eaeaea;border:1px solid #333;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.4);font:13px/1.5 system-ui;backdrop-filter:blur(10px)}
#nj-panel .hd{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;border-bottom:1px solid #2a2a2a;cursor:move;user-select:none}
#nj-panel .hd b{font-weight:600}
#nj-panel .cls{cursor:pointer;opacity:.6;padding:0 4px;font-size:16px}
#nj-panel .cls:hover{opacity:1}
#nj-panel .bd{padding:10px 12px}
#nj-panel .stat{background:#17181b;border:1px solid #262626;border-radius:6px;padding:7px 10px;margin-bottom:8px;font-size:12px;line-height:1.7}
#nj-panel .stat b{color:#f4a259}
#nj-panel .stat .sel-n{color:#5b9cf4}
#nj-panel .row{display:flex;gap:6px;align-items:center;margin-bottom:7px;flex-wrap:wrap}
#nj-panel label{font-size:11.5px;color:#bbb}
#nj-panel input[type="number"],#nj-panel input[type="range"],#nj-panel select{background:#1a1a1d;color:#eee;border:1px solid #333;border-radius:4px;padding:3px 5px;font-size:12px}
#nj-panel input[type="number"]{width:56px}
#nj-panel input[type="range"]{flex:1;min-width:80px;accent-color:#d14836}
#nj-panel select{padding:3px 4px}
#nj-panel .btn{color:#fff;border:none;padding:7px 10px;border-radius:6px;cursor:pointer;font-weight:600;font-size:12px;width:100%;margin-top:3px}
#nj-panel .btn:disabled{opacity:.5;cursor:not-allowed}
#nj-panel .btn-p{background:#d14836}
#nj-panel .btn-s{background:#2d2d31}
#nj-panel .btn-s:hover{background:#36363b}
#nj-panel .btn-d{background:#8a2a2a}
#nj-panel .btn-sel{background:#3b82f6}
#nj-panel .bar{height:4px;background:#2a2a2a;border-radius:2px;overflow:hidden;margin-top:8px}
#nj-panel .bar>div{height:100%;background:linear-gradient(90deg,#d14836,#f4a259);transition:width .2s;width:0%}
#nj-panel .prog{font-size:11px;color:#aaa;margin-top:6px;max-height:180px;overflow:auto;font-family:ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all}
#nj-panel .prog>.ok{color:#8fd19e}
#nj-panel .prog>.bad{color:#f47a7a}
#nj-panel .hint{font-size:10.5px;color:#666;margin-top:6px}
#nj-panel .sep{border:0;border-top:1px solid #2a2a2a;margin:8px 0}
`;

  function injectCSS() { const s = document.createElement('style'); s.textContent = STYLE; (document.head || document.documentElement).appendChild(s); }
  function createFab() {
    if (document.getElementById('nj-fab')) return;
    const b = document.createElement('div'); b.id = 'nj-fab';
    b.innerHTML = `<span>📦</span><span class="ct" id="nj-ct">0</span>`;
    b.addEventListener('click', showPanel);
    document.body.appendChild(b);
    cacheListeners.add(() => { const e = document.getElementById('nj-ct'); if (e) e.textContent = jobCache.size; });
  }

  let panelEl = null;
  const state = { running: false, cancel: false };

  function showPanel() {
    if (panelEl) { panelEl.style.display = 'block'; refreshStat(); return; }
    panelEl = document.createElement('div'); panelEl.id = 'nj-panel';
    panelEl.innerHTML = `
<div class="hd"><b>Niji 导出 v6.2</b><span class="cls">×</span></div>
<div class="bd">
  <div class="stat" id="nj-stat"></div>

  <div class="row">
    <label>格式</label>
    <select id="nj-fmt"><option value="webp">WebP</option><option value="png">PNG</option></select>
    <label>质量</label>
    <input type="number" id="nj-q" value="${CONFIG.quality}" min="0.1" max="1" step="0.05"/>
  </div>
  <div class="row">
    <label>大小</label>
    <input type="range" id="nj-scale" min="10" max="100" value="${CONFIG.scale}" step="5"/>
    <span id="nj-scale-v">${CONFIG.scale}%</span>
  </div>
  <div class="row">
    <label><input type="checkbox" id="nj-seed" checked/> 获取 Seed (每条调一次 API，批量时较慢)</label>
  </div>

  <hr class="sep">

  <button class="btn btn-sel" id="nj-sel-toggle">开启选择模式</button>
  <div id="nj-sel-controls" style="display:none">
    <div class="row" style="margin-top:6px">
      <button class="btn btn-s" id="nj-sel-all" style="width:auto;flex:1">全选可见</button>
      <button class="btn btn-s" id="nj-sel-none" style="width:auto;flex:1">取消全选</button>
    </div>
    <button class="btn btn-p" id="nj-go" disabled>导出已选 (0)</button>
  </div>

  <hr class="sep">
  <button class="btn btn-s" id="nj-hv">刷新 React 缓存</button>
  <button class="btn btn-d" id="nj-rst">清空已导出记录</button>

  <div class="bar"><div id="nj-bf"></div></div>
  <div class="prog" id="nj-prog"></div>
  <div class="hint">💾 = 单独导出　☐/☑ = 选择模式<br>取消勾选 Seed 可加速批量导出 (不请求 API)</div>
</div>`;
    document.body.appendChild(panelEl);

    panelEl.querySelector('.cls').addEventListener('click', () => {
      if (state.running) { state.cancel = true; return; }
      panelEl.style.display = 'none';
    });

    // 格式切换
    panelEl.querySelector('#nj-fmt').addEventListener('change', e => {
      CONFIG.format = e.target.value;
      panelEl.querySelector('#nj-q').disabled = CONFIG.format === 'png';
    });
    panelEl.querySelector('#nj-q').addEventListener('change', e => {
      CONFIG.quality = Math.min(1, Math.max(0.1, parseFloat(e.target.value) || 0.85));
    });
    panelEl.querySelector('#nj-scale').addEventListener('input', e => {
      CONFIG.scale = parseInt(e.target.value) || 100;
      panelEl.querySelector('#nj-scale-v').textContent = CONFIG.scale + '%';
    });
    panelEl.querySelector('#nj-seed').addEventListener('change', e => {
      CONFIG.fetchSeed = e.target.checked;
    });

    // 选择模式
    panelEl.querySelector('#nj-sel-toggle').addEventListener('click', () => {
      const on = !selectMode;
      toggleSelectMode(on);
      panelEl.querySelector('#nj-sel-toggle').textContent = on ? '关闭选择模式' : '开启选择模式';
      panelEl.querySelector('#nj-sel-toggle').className = `btn ${on ? 'btn-s' : 'btn-sel'}`;
      panelEl.querySelector('#nj-sel-controls').style.display = on ? 'block' : 'none';
    });
    panelEl.querySelector('#nj-sel-all').addEventListener('click', selectAll);
    panelEl.querySelector('#nj-sel-none').addEventListener('click', selectNone);
    panelEl.querySelector('#nj-go').addEventListener('click', onBatch);
    panelEl.querySelector('#nj-hv').addEventListener('click', () => alog(`React: ${harvest()}`));
    panelEl.querySelector('#nj-rst').addEventListener('click', () => {
      if (!confirm(`清空 ${exportedJids.size} 条？`)) return;
      exportedJids.clear(); saveExp(exportedJids);
      for (const b of document.querySelectorAll('.nj-exp-btn.nj-done')) { b.classList.remove('nj-done'); b.innerHTML = '💾'; }
      alog('已清空'); refreshStat();
    });

    makeDrag(panelEl, panelEl.querySelector('.hd'));
    cacheListeners.add(refreshStat);
    setInterval(refreshStat, 1200);
    refreshStat();
  }

  function refreshStat() {
    if (!panelEl) return;
    const domN = document.querySelectorAll('.nj-btn-wrap').length;
    const selN = selectedJobs.size;
    const el = panelEl.querySelector('#nj-stat');
    if (el) el.innerHTML = `缓存 <b>${jobCache.size}</b>　可见 <b>${domN}</b>　已导 <b>${exportedJids.size}</b><br><span class="sel-n">${selectMode ? `已选 <b>${selN}</b>` : ''}</span>`;
    const goBtn = panelEl.querySelector('#nj-go');
    if (goBtn && !state.running) {
      goBtn.textContent = `导出已选 (${selN})`;
      goBtn.disabled = selN === 0;
    }
  }

  function makeDrag(el, h) {
    let sx, sy, sl, st, dr = false;
    h.addEventListener('mousedown', e => { dr = true; sx = e.clientX; sy = e.clientY; const r = el.getBoundingClientRect(); sl = r.left; st = r.top; el.style.right = 'auto'; e.preventDefault(); });
    document.addEventListener('mousemove', e => { if (!dr) return; el.style.left = (sl + e.clientX - sx) + 'px'; el.style.top = Math.max(0, st + e.clientY - sy) + 'px'; });
    document.addEventListener('mouseup', () => dr = false);
  }
  function alog(msg, cls = '') { const p = panelEl?.querySelector('#nj-prog'); if (!p) return; const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = msg; p.appendChild(d); p.scrollTop = p.scrollHeight; log(msg); }
  function setBar(pct) { const b = panelEl?.querySelector('#nj-bf'); if (b) b.style.width = pct + '%'; }

  async function onBatch() {
    if (state.running || !selectedJobs.size) return;
    state.running = true; state.cancel = false;
    const btn = panelEl.querySelector('#nj-go'); btn.disabled = true;
    const list = [...selectedJobs];
    let done = 0, fail = 0;
    CONFIG._batchMode = true;
    alog(`📊 导出 ${list.length} 条 (${CONFIG.format.toUpperCase()}, ${CONFIG.scale}%, q=${CONFIG.quality}, seed=${CONFIG.fetchSeed ? 'ON' : 'OFF'})`);
    for (let i = 0; i < list.length; i++) {
      if (state.cancel) break;
      const jid = list[i];
      btn.textContent = `${i + 1}/${list.length}`;
      try {
        const job = jobCache.get(jid) || { id: jid };
        const row = findRow(collectImgs(jid), jid);
        const r = await processJob(job, row);
        done++;
        alog(`[${i + 1}] ✓ ${r.fn}`, 'ok');
      } catch (e) {
        fail++;
        alog(`[${i + 1}] ✗ ${jid.slice(0, 8)}: ${e.message}`, 'bad');
      }
      setBar(Math.round((i + 1) / list.length * 100));
      if (CONFIG.downloadDelayMs > 0) await new Promise(r => setTimeout(r, CONFIG.downloadDelayMs));
    }
    alog(`🎉 ${done}✓ ${fail}✗`, done && !fail ? 'ok' : '');
    CONFIG._batchMode = false;
    state.running = false; state.cancel = false;
    btn.disabled = false; refreshStat();
  }

  // ============================== INIT ==============================
  function init() {
    if (!document.body) { setTimeout(init, 50); return; }
    injectCSS(); createFab(); startObs();
    try { uw.nijiExport = { jobCache, CONFIG, harvest, selectedJobs, exportedJids }; } catch {}
    log('v6.2 ready');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
