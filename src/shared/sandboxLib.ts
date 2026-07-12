// Clean-room lodash (`_`) + faker + no-op `console` subset injected into the EJS quickjs sandbox.
// Extracted verbatim from templateEngine's boot (WS-4) so it gets its own file + lint/format + the direct
// tests in test/sandboxLib.test.ts. It is ES5-only JS (it runs inside quickjs via vm.evalCode), NOT
// type-checked TS — keep it ES5 (no spread/optional-chaining/let-const-arrow). Reimplemented from the
// public lodash API contract; no lodash source is copied. The engine appends this to its boot glue.
export const SANDBOX_LIB_JS = `
    // Minimal clean-room faker subset for generated placeholder data (not the real lib).
    var faker = {
      number: function(a,b){ if(a==null){a=0;b=100;} if(b==null){b=a;a=0;} return Math.floor(Math.random()*(b-a+1))+a; },
      float: function(a,b){ a=a||0; b=(b==null)?1:b; return a+Math.random()*(b-a); },
      bool: function(){ return Math.random()<0.5; },
      pick: function(arr){ return (arr&&arr.length)?arr[Math.floor(Math.random()*arr.length)]:undefined; },
      uuid: function(){ return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;return (c==='x'?r:(r&0x3|0x8)).toString(16);}); },
      name: function(){ return faker.pick(['Aria','Bjorn','Cora','Darian','Eira','Finn','Gwen','Hale','Iris','Joran']); },
      word: function(){ return faker.pick(['ember','hollow','thorn','willow','quartz','raven','mist','dawn','vale','cinder']); },
      lorem: function(n){ n=n||8; var w=[]; for(var i=0;i<n;i++) w.push(faker.word()); return w.join(' '); }
    };
    // Clean-room lodash subset (dot-path get/set + the common collection/object/lang helpers a card's
    // status panel uses) + a no-op console — ST-PT exposes _ and console. Reimplemented from the public
    // lodash API contract; no lodash source is copied. cloneDeep is JSON-based (stat_data is plain JSON,
    // so this is faithful + loses nothing that matters). Key args accept a string OR array (lodash does).
    function __ks(p){ return String(p==null?'':p).split('.').filter(Boolean); }
    function __arr(k){ return Array.isArray(k)?k:(k==null?[]:[k]); }
    function __it(fn){ if(fn==null) return function(x){return x;}; return typeof fn==='function'?fn:function(x){return x==null?undefined:x[fn];}; }
    var _ = {
      get: function(o,p,d){ var ks=__ks(p),c=o; for(var i=0;i<ks.length;i++){ if(c==null) return d; c=c[ks[i]]; } return c===undefined?d:c; },
      set: function(o,p,v){ var ks=__ks(p),c=o; for(var i=0;i<ks.length-1;i++){ if(typeof c[ks[i]]!=='object'||c[ks[i]]==null) c[ks[i]]={}; c=c[ks[i]]; } if(ks.length) c[ks[ks.length-1]]=v; return o; },
      has: function(o,p){ return _.get(o,p,undefined)!==undefined; },
      keys: function(o){ return o?Object.keys(o):[]; },
      values: function(o){ return o?Object.keys(o).map(function(k){return o[k];}):[]; },
      isEmpty: function(o){ if(o==null) return true; if(Array.isArray(o)||typeof o==='string') return o.length===0; return Object.keys(o).length===0; },
      clamp: function(n,a,b){ return Math.min(Math.max(n,a),b); },
      random: function(a,b){ if(b==null){b=a;a=0;} return a+Math.floor(Math.random()*(b-a+1)); },
      sample: function(a){ return (a&&a.length)?a[Math.floor(Math.random()*a.length)]:undefined; },
      uniq: function(a){ return Array.isArray(a)?a.filter(function(x,i){return a.indexOf(x)===i;}):[]; },
      range: function(a,b,s){ if(b==null){b=a;a=0;} s=s||1; var r=[]; for(var i=a;(s>0?i<b:i>b);i+=s) r.push(i); return r; },
      capitalize: function(s){ s=String(s==null?'':s); return s.charAt(0).toUpperCase()+s.slice(1).toLowerCase(); },
      upperFirst: function(s){ s=String(s==null?'':s); return s.charAt(0).toUpperCase()+s.slice(1); },
      merge: function(t){ for(var i=1;i<arguments.length;i++){ var s=arguments[i]; if(s) for(var k in s) t[k]=s[k]; } return t; },
      pick: function(o,ks){ var r={}; __arr(ks).forEach(function(k){ if(o&&k in o) r[k]=o[k]; }); return r; },
      omit: function(o,ks){ var ex=__arr(ks),r={}; for(var k in o){ if(ex.indexOf(k)<0) r[k]=o[k]; } return r; },
      cloneDeep: function(o){ if(o==null||typeof o!=='object') return o; try { return JSON.parse(JSON.stringify(o)); } catch(e){ return o; } },
      clone: function(o){ if(o==null||typeof o!=='object') return o; return Array.isArray(o)?o.slice():Object.assign({},o); },
      defaults: function(t){ t=t||{}; for(var i=1;i<arguments.length;i++){ var s=arguments[i]; if(s) for(var k in s){ if(t[k]===undefined) t[k]=s[k]; } } return t; },
      defaultTo: function(v,d){ return (v==null||(typeof v==='number'&&isNaN(v)))?d:v; },
      isEqual: function(a,b){ try { return JSON.stringify(a)===JSON.stringify(b); } catch(e){ return a===b; } },
      isNil: function(v){ return v==null; },
      isArray: Array.isArray,
      isObject: function(v){ return v!=null && typeof v==='object'; },
      isPlainObject: function(v){ return v!=null && typeof v==='object' && !Array.isArray(v); },
      isString: function(v){ return typeof v==='string'; },
      isNumber: function(v){ return typeof v==='number' && !isNaN(v); },
      isFunction: function(v){ return typeof v==='function'; },
      size: function(o){ if(o==null) return 0; if(Array.isArray(o)||typeof o==='string') return o.length; return Object.keys(o).length; },
      forEach: function(c,fn){ if(Array.isArray(c)){ for(var i=0;i<c.length;i++) fn(c[i],i,c); } else if(c){ for(var k in c) fn(c[k],k,c); } return c; },
      map: function(c,fn){ var g=__it(fn),r=[]; if(Array.isArray(c)){ for(var i=0;i<c.length;i++) r.push(g(c[i],i,c)); } else if(c){ for(var k in c) r.push(g(c[k],k,c)); } return r; },
      filter: function(c,fn){ var g=__it(fn),r=[]; if(Array.isArray(c)){ for(var i=0;i<c.length;i++) if(g(c[i],i,c)) r.push(c[i]); } else if(c){ for(var k in c) if(g(c[k],k,c)) r.push(c[k]); } return r; },
      find: function(c,fn){ var g=__it(fn); if(Array.isArray(c)){ for(var i=0;i<c.length;i++) if(g(c[i],i,c)) return c[i]; } else if(c){ for(var k in c) if(g(c[k],k,c)) return c[k]; } return undefined; },
      some: function(c,fn){ var g=__it(fn); if(Array.isArray(c)){ for(var i=0;i<c.length;i++) if(g(c[i],i,c)) return true; } return false; },
      every: function(c,fn){ var g=__it(fn); if(Array.isArray(c)){ for(var i=0;i<c.length;i++) if(!g(c[i],i,c)) return false; } return true; },
      reduce: function(c,fn,acc){ if(Array.isArray(c)){ for(var i=0;i<c.length;i++) acc=fn(acc,c[i],i,c); } else if(c){ for(var k in c) acc=fn(acc,c[k],k,c); } return acc; },
      includes: function(c,v){ if(Array.isArray(c)||typeof c==='string') return c.indexOf(v)>=0; if(c){ for(var k in c){ if(c[k]===v) return true; } } return false; },
      first: function(a){ return Array.isArray(a)&&a.length?a[0]:undefined; },
      head: function(a){ return Array.isArray(a)&&a.length?a[0]:undefined; },
      last: function(a){ return Array.isArray(a)&&a.length?a[a.length-1]:undefined; },
      compact: function(a){ return Array.isArray(a)?a.filter(function(x){return !!x;}):[]; },
      flatten: function(a){ return Array.isArray(a)?a.reduce(function(r,x){ return r.concat(x); },[]):[]; },
      toPairs: function(o){ return o?Object.keys(o).map(function(k){return [k,o[k]];}):[]; },
      fromPairs: function(p){ var r={}; (p||[]).forEach(function(kv){ if(kv) r[kv[0]]=kv[1]; }); return r; },
      entries: function(o){ return o?Object.keys(o).map(function(k){return [k,o[k]];}):[]; },
      mapValues: function(o,fn){ var g=__it(fn),r={}; if(o) for(var k in o) r[k]=g(o[k],k,o); return r; },
      groupBy: function(c,fn){ var g=__it(fn),r={}; (Array.isArray(c)?c:[]).forEach(function(x){ var key=g(x); (r[key]=r[key]||[]).push(x); }); return r; },
      keyBy: function(c,fn){ var g=__it(fn),r={}; (Array.isArray(c)?c:[]).forEach(function(x){ r[g(x)]=x; }); return r; },
      sortBy: function(c,fn){ var g=__it(fn); return (Array.isArray(c)?c.slice():[]).sort(function(a,b){ var av=g(a),bv=g(b); return av<bv?-1:av>bv?1:0; }); },
      sum: function(a){ return (Array.isArray(a)?a:[]).reduce(function(s,x){ return s+(Number(x)||0); },0); },
      sumBy: function(c,fn){ var g=__it(fn); return (Array.isArray(c)?c:[]).reduce(function(s,x){ return s+(Number(g(x))||0); },0); },
      maxBy: function(c,fn){ var g=__it(fn),best,bv=-Infinity; (Array.isArray(c)?c:[]).forEach(function(x){ var v=Number(g(x)); if(v>bv){bv=v;best=x;} }); return best; },
      minBy: function(c,fn){ var g=__it(fn),best,bv=Infinity; (Array.isArray(c)?c:[]).forEach(function(x){ var v=Number(g(x)); if(v<bv){bv=v;best=x;} }); return best; },
      round: function(n,p){ p=p||0; var f=Math.pow(10,p); return Math.round((Number(n)||0)*f)/f; },
      padStart: function(s,len,ch){ s=String(s==null?'':s); ch=ch||' '; while(s.length<len) s=ch+s; return s.slice(s.length-Math.max(len,s.length)); }
    };
    // Aliases + a second batch of common methods (added as properties so they can reference the above).
    _.each = _.forEach; _.forOwn = _.forEach; _.collect = _.map; _.detect = _.find;
    _.orderBy = _.sortBy; // single-key ascending approximation of lodash orderBy
    _.reject = function(c,fn){ var g=__it(fn); return _.filter(c,function(x,i,cc){ return !g(x,i,cc); }); };
    _.findKey = function(o,fn){ var g=__it(fn); for(var k in o){ if(g(o[k],k,o)) return k; } return undefined; };
    _.mapKeys = function(o,fn){ var g=__it(fn),r={}; for(var k in o) r[g(o[k],k,o)]=o[k]; return r; };
    _.countBy = function(c,fn){ var g=__it(fn),r={}; (Array.isArray(c)?c:[]).forEach(function(x){ var key=g(x); r[key]=(r[key]||0)+1; }); return r; };
    _.flatMap = function(c,fn){ var g=__it(fn); return _.flatten(_.map(c,g)); };
    _.times = function(n,fn){ n=Number(n)||0; var r=[]; for(var i=0;i<n;i++) r.push(fn?fn(i):i); return r; };
    _.max = function(a){ return (Array.isArray(a)&&a.length)?a.reduce(function(m,x){return x>m?x:m;}):undefined; };
    _.min = function(a){ return (Array.isArray(a)&&a.length)?a.reduce(function(m,x){return x<m?x:m;}):undefined; };
    _.mean = function(a){ a=Array.isArray(a)?a:[]; return a.length?_.sum(a)/a.length:0; };
    _.meanBy = function(c,fn){ c=Array.isArray(c)?c:[]; return c.length?_.sumBy(c,fn)/c.length:0; };
    _.toNumber = function(v){ var n=Number(v); return isNaN(n)?0:n; };
    _.toString = function(v){ return v==null?'':String(v); };
    _.trim = function(s){ return String(s==null?'':s).trim(); };
    _.startsWith = function(s,t){ return String(s==null?'':s).indexOf(t)===0; };
    _.endsWith = function(s,t){ s=String(s==null?'':s); t=String(t); return t===''?true:s.indexOf(t,s.length-t.length)!==-1; };
    _.repeat = function(s,n){ s=String(s==null?'':s); n=Number(n)||0; var r=''; for(var i=0;i<n;i++) r+=s; return r; };
    _.isUndefined = function(v){ return v===undefined; };
    _.isNull = function(v){ return v===null; };
    _.isBoolean = function(v){ return typeof v==='boolean'; };
    _.isInteger = function(v){ return typeof v==='number' && isFinite(v) && Math.floor(v)===v; };
    _.noop = function(){};
    _.identity = function(v){ return v; };
    _.take = function(a,n){ return Array.isArray(a)?a.slice(0,n==null?1:n):[]; };
    _.takeRight = function(a,n){ n=n==null?1:n; return Array.isArray(a)?a.slice(Math.max(a.length-n,0)):[]; };
    _.drop = function(a,n){ return Array.isArray(a)?a.slice(n==null?1:n):[]; };
    _.chunk = function(a,n){ n=Math.max(Number(n)||1,1); var r=[]; a=Array.isArray(a)?a:[]; for(var i=0;i<a.length;i+=n) r.push(a.slice(i,i+n)); return r; };
    _.findIndex = function(a,fn){ var g=__it(fn); a=Array.isArray(a)?a:[]; for(var i=0;i<a.length;i++) if(g(a[i],i,a)) return i; return -1; };
    _.nth = function(a,i){ if(!Array.isArray(a)) return undefined; i=Number(i)||0; return i<0?a[a.length+i]:a[i]; };
    _.invert = function(o){ var r={}; for(var k in o) r[o[k]]=k; return r; };
    _.uniqBy = function(c,fn){ var g=__it(fn),seen={},r=[]; (Array.isArray(c)?c:[]).forEach(function(x){ var k=g(x); if(!seen[k]){seen[k]=1;r.push(x);} }); return r; };
    _.concat = function(){ var r=[]; for(var i=0;i<arguments.length;i++){ var a=arguments[i]; if(Array.isArray(a)) r=r.concat(a); else r.push(a); } return r; };
    _.difference = function(a){ var ex=Array.prototype.slice.call(arguments,1).reduce(function(s,x){return s.concat(x);},[]); return (Array.isArray(a)?a:[]).filter(function(x){return ex.indexOf(x)<0;}); };
    // Explicit lodash chaining: _.chain(v).method(...)....value(). The wrapper proxies every _ method,
    // threading the wrapped value as the first arg and re-wrapping the result; .value()/.valueOf()/toJSON
    // unwrap. (Explicit _.chain only — no implicit _() call chaining, which cards here don't use.)
    _.chain = function(value){
      function wrap(v){
        var w = { __wrapped__: v };
        var names = Object.keys(_);
        for (var i=0;i<names.length;i++){
          (function(name){
            var fn = _[name];
            if (typeof fn !== 'function') return;
            w[name] = function(){
              var args=[w.__wrapped__];
              for (var j=0;j<arguments.length;j++) args.push(arguments[j]);
              return wrap(fn.apply(_, args));
            };
          })(names[i]);
        }
        w.value = function(){ return w.__wrapped__; };
        w.valueOf = w.value; w.toJSON = w.value;
        return w;
      }
      return wrap(value);
    };
    _.tap = function(v, fn){ if (typeof fn==='function') fn(v); return v; };
    _.thru = function(v, fn){ return typeof fn==='function' ? fn(v) : v; };
    var console = { log: function(){}, info: function(){}, warn: function(){}, error: function(){} };
`
