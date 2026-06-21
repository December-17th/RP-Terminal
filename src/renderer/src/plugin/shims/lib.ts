/** Clean-room `_` (lodash subset) + `YAML` shim, and the optional CDN lib-loader
 * (real lodash/zod under the remoteScripts grant). JS-as-a-string for the sandbox. */

/**
 * Minimal, clean-room `_` (lodash subset) + `YAML` injected into the sandbox so MVU
 * front-end UI scripts — which lean on `_.get/set/cloneDeep/merge/...` and `YAML.parse`
 * — run without their CDN deps. Standard implementations, no code copied. YAML is a
 * best-effort JSON-passthrough (a full YAML parser is out of scope).
 */
export const LIB_SHIM = `
(function(){
  function parts(p){ return Array.isArray(p) ? p : String(p).replace(/\\[(\\w+)\\]/g,'.$1').split('.').filter(Boolean); }
  function getPath(o,p){ var ks=parts(p); for(var i=0;i<ks.length;i++){ if(o==null) return undefined; o=o[ks[i]]; } return o; }
  function setPath(o,p,v){ var ks=parts(p), c=o; for(var i=0;i<ks.length-1;i++){ if(typeof c[ks[i]]!=='object'||c[ks[i]]==null) c[ks[i]]={}; c=c[ks[i]]; } c[ks[ks.length-1]]=v; return o; }
  function isObj(v){ return v!==null && typeof v==='object' && !Array.isArray(v); }
  function cloneDeep(v){ return v===undefined ? v : JSON.parse(JSON.stringify(v)); }
  function merge(t){ for(var a=1;a<arguments.length;a++){ var s=arguments[a]; if(!s) continue; for(var k in s){ if(isObj(s[k])&&isObj(t[k])) merge(t[k],s[k]); else t[k]=s[k]; } } return t; }
  var _ = {
    get: function(o,p,d){ var v=getPath(o,p); return v===undefined?d:v; },
    set: setPath,
    has: function(o,p){ return getPath(o,p)!==undefined; },
    cloneDeep: cloneDeep, clone: cloneDeep,
    merge: merge,
    isEqual: function(a,b){ return JSON.stringify(a)===JSON.stringify(b); },
    isObject: function(v){ return v!==null && (typeof v==='object'||typeof v==='function'); },
    isArray: Array.isArray,
    isEmpty: function(v){ if(v==null) return true; if(Array.isArray(v)||typeof v==='string') return v.length===0; if(typeof v==='object') return Object.keys(v).length===0; return false; },
    clamp: function(n,lo,hi){ return Math.min(hi, Math.max(lo, n)); },
    pick: function(o,ks){ var r={}; (Array.isArray(ks)?ks:[ks]).forEach(function(k){ if(o&&k in o) r[k]=o[k]; }); return r; },
    omit: function(o,ks){ var r=Object.assign({},o); (Array.isArray(ks)?ks:[ks]).forEach(function(k){ delete r[k]; }); return r; },
    uniq: function(a){ return Array.isArray(a)?a.filter(function(x,i){ return a.indexOf(x)===i; }):a; },
    size: function(v){ if(v==null) return 0; if(Array.isArray(v)||typeof v==='string') return v.length; if(typeof v==='object') return Object.keys(v).length; return 0; },
    keys: function(o){ return o?Object.keys(o):[]; },
    values: function(o){ return o?Object.values(o):[]; },
    forEach: function(c,fn){ if(Array.isArray(c)) c.forEach(fn); else if(isObj(c)) Object.keys(c).forEach(function(k){ fn(c[k],k); }); return c; },
    map: function(c,fn){ if(Array.isArray(c)) return c.map(fn); if(isObj(c)) return Object.keys(c).map(function(k){ return fn(c[k],k); }); return []; },
    defaultTo: function(v,d){ return (v==null||v!==v)?d:v; }
  };
  if (!window._) window._ = _;
  if (!window.lodash) window.lodash = _;
  if (!window.YAML) window.YAML = {
    parse: function(s){ try { return JSON.parse(s); } catch(e){ return {}; } },
    stringify: function(o){ try { return JSON.stringify(o,null,2); } catch(e){ return ''; } }
  };
})();
`

/**
 * When remote scripts are allowed, load REAL lodash + zod from a CDN and expose the
 * globals that Tavern Helper / MVU scripts assume exist: a callable/chainable `_`
 * (`_(x).sortBy()…`) and `z` shaped as `{ z: <zod v4> }` (the MVU zod wrapper —
 * `z.z.object`, `z.z.coerce`, …). It's a `type="module"` with TOP-LEVEL AWAIT, so it
 * finishes setting the globals before any user module (or its imports) evaluates. Falls
 * back silently to the clean-room LIB_SHIM `_` if the CDN is unreachable. The clean-room
 * stance is intact: lodash/zod are MIT npm libs, not js-slash-runner code.
 */
export const LIB_LOADER =
  `<script type="module">` +
  // Publish a readiness promise so dynamically-injected page scripts (jQuery .load) can
  // await the libs before running — the deferred-module ordering doesn't cover them.
  `window.__rptLibsReady = (async () => {` +
  `try{const m=await import('https://testingcf.jsdelivr.net/npm/lodash/+esm');window._=window.lodash=(m&&m.default)||m;}catch(e){}` +
  `try{const m=await import('https://testingcf.jsdelivr.net/npm/zod/+esm');window.z={z:(m&&(m.z||m.default))||m};}catch(e){}` +
  // Vue 3 global for frontend cards built as Vue apps (they reference `Vue` directly, as
  // the ST host page provides it). The namespace carries the named exports
  // (createApp/ref/defineComponent/…) the cards use.
  `try{const m=await import('https://testingcf.jsdelivr.net/npm/vue/+esm');window.Vue=(m&&m.createApp)?m:((m&&m.default)||m);}catch(e){}` +
  `})();` +
  `</script>`
