/**
 * Clean-room minimal jQuery-compatible `$` for the sandbox (replaces the old no-op stub).
 * It operates on the iframe's OWN document, so Tavern-Helper "frontend cards" that use
 * basic jQuery DOM ops work, and `$(sel).load(url)` fetches a remote UI and injects it
 * (executing its <script> tags) — the fetch only succeeds when the world's network grant
 * has opened the CSP. ST-DOM-coupled selectors that match nothing degrade to no-ops, as
 * before. NOT real jQuery — a small compatible subset, reimplemented from public behavior.
 */
export const JQUERY_SHIM = `
(function () {
  if (window.$ && window.jQuery) return;
  function toArr(x){ return [].slice.call(x); }
  function JQ(nodes){ this.length = nodes.length; for (var i=0;i<nodes.length;i++) this[i]=nodes[i]; }
  var p = JQ.prototype;
  p.each = function(fn){ for (var i=0;i<this.length;i++) fn.call(this[i], i, this[i]); return this; };
  p.get = function(i){ return this[i]; };
  p.html = function(v){ if (v===undefined) return this[0] && this[0].innerHTML; return this.each(function(){ this.innerHTML = v; }); };
  p.text = function(v){ if (v===undefined) return this[0] && this[0].textContent; return this.each(function(){ this.textContent = v; }); };
  p.val = function(v){ if (v===undefined) return this[0] && this[0].value; return this.each(function(){ this.value = v; }); };
  p.attr = function(k,v){ if (v===undefined) return this[0] && this[0].getAttribute(k); return this.each(function(){ this.setAttribute(k,v); }); };
  p.prop = function(k,v){ if (v===undefined) return this[0] ? this[0][k] : undefined; return this.each(function(){ this[k]=v; }); };
  p.css = function(k,v){ if (k && typeof k==='object'){ return this.each(function(){ for (var n in k) this.style[n]=k[n]; }); } if (v===undefined) return this[0] && getComputedStyle(this[0])[k]; return this.each(function(){ this.style[k]=v; }); };
  p.addClass = function(c){ return this.each(function(){ var el=this; String(c).split(/\\s+/).forEach(function(x){ if(x) el.classList.add(x); }); }); };
  p.removeClass = function(c){ return this.each(function(){ var el=this; String(c).split(/\\s+/).forEach(function(x){ if(x) el.classList.remove(x); }); }); };
  p.toggleClass = function(c){ return this.each(function(){ this.classList.toggle(c); }); };
  p.hasClass = function(c){ return this[0] ? this[0].classList.contains(c) : false; };
  p.append = function(v){ return this.each(function(){ var t=this; if (typeof v==='string') t.insertAdjacentHTML('beforeend', v); else if (v instanceof JQ) v.each(function(){ t.appendChild(this); }); else if (v && v.nodeType) t.appendChild(v); }); };
  p.prepend = function(v){ return this.each(function(){ if (typeof v==='string') this.insertAdjacentHTML('afterbegin', v); else if (v && v.nodeType) this.insertBefore(v, this.firstChild); }); };
  p.remove = function(){ return this.each(function(){ this.parentNode && this.parentNode.removeChild(this); }); };
  p.empty = function(){ return this.each(function(){ this.innerHTML=''; }); };
  p.hide = function(){ return this.each(function(){ this.style.display='none'; }); };
  p.show = function(){ return this.each(function(){ this.style.display=''; }); };
  p.on = function(ev, a, b){ var fn = (typeof a==='function') ? a : b; return this.each(function(){ var el=this; String(ev).split(/\\s+/).forEach(function(e){ el.addEventListener(e, fn); }); }); };
  p.off = function(ev, fn){ return this.each(function(){ this.removeEventListener(ev, fn); }); };
  p.click = function(fn){ return fn ? this.on('click', fn) : this.each(function(){ this.click(); }); };
  p.trigger = function(ev){ return this.each(function(){ this.dispatchEvent(new Event(ev, {bubbles:true})); }); };
  p.find = function(sel){ var out=[]; this.each(function(){ out = out.concat(toArr(this.querySelectorAll(sel))); }); return new JQ(out); };
  p.children = function(){ var out=[]; this.each(function(){ out = out.concat(toArr(this.children)); }); return new JQ(out); };
  p.parent = function(){ var out=[]; this.each(function(){ this.parentNode && out.push(this.parentNode); }); return new JQ(out); };
  p.closest = function(sel){ var out=[]; this.each(function(){ var e=this.closest && this.closest(sel); e && out.push(e); }); return new JQ(out); };
  p.is = function(sel){ return this[0] ? this[0].matches(sel) : false; };
  p.data = function(k,v){ if (v===undefined) return this[0] ? this[0].dataset[k] : undefined; return this.each(function(){ this.dataset[k]=v; }); };
  p.ready = function(fn){ if (document.readyState!=='loading') fn(); else document.addEventListener('DOMContentLoaded', function(){ fn(); }); return this; };
  function llog(m){ try{ parent.postMessage({__rptlog:1,msg:'[jquery.load] '+m},'*'); }catch(_){} }
  // Re-create a parsed <script> so it actually executes (innerHTML-injected scripts don't),
  // preserving its attributes (src/type=module/crossorigin/…) and inline body.
  function execScript(old, target){ var s=document.createElement('script'); for (var i=0;i<old.attributes.length;i++){ s.setAttribute(old.attributes[i].name, old.attributes[i].value); } if (!old.src) s.textContent = old.textContent; target.appendChild(s); }
  // Prefer the host-mediated fetch (runs in main — no opaque-origin CORS wall); fall back to
  // a direct fetch when the rpt bridge isn't present.
  function getText(u){
    if (window.rpt && rpt.fetchText) return rpt.fetchText(u);
    return fetch(u).then(function(r){ if (!r.ok) throw new Error(r.status + ' ' + r.statusText); return r.text(); });
  }
  // Pull import specifiers out of a module's source (static from-imports, side-effect
  // imports, and dynamic import()).
  function moduleImports(src){
    var specs=[], m;
    var re1=/from\\s*['"]([^'"]+)['"]/g; while((m=re1.exec(src))) specs.push(m[1]);
    var re2=/\\bimport\\s*['"]([^'"]+)['"]/g; while((m=re2.exec(src))) specs.push(m[1]);
    var re3=/\\bimport\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)/g; while((m=re3.exec(src))) specs.push(m[1]);
    return specs;
  }
  // Fetch a (possibly full-document) page and mount it: rewrite its relative asset URLs to
  // absolute against the page URL (so a built SPA's /assets/* resolve), pull its <head>
  // styles/links into our document, resolve the entry module's imports to same-origin
  // blob: URLs via an import map (cross-origin import() fails in the opaque sandbox), inject
  // its <body>, and execute its scripts.
  p.load = function(url, cb){
    var self=this, u=String(url);
    llog('fetching ' + u);
    getText(u).then(async function(html){
      await Promise.resolve(window.__rptLibsReady).catch(function(){}); // Vue global ready
      var doc = new DOMParser().parseFromString(html, 'text/html');
      function abs(el, attr){ var v=el.getAttribute(attr); if (v){ try { el.setAttribute(attr, new URL(v, u).href); } catch(e){} } }
      toArr(doc.querySelectorAll('[src]')).forEach(function(el){ abs(el, 'src'); });
      toArr(doc.querySelectorAll('link[href]')).forEach(function(el){ abs(el, 'href'); });
      var head = document.head || document.getElementsByTagName('head')[0];
      // Pull the page's <head> styles in (a built SPA's CSS lives here).
      if (doc.head && head) toArr(doc.head.querySelectorAll('link[rel="stylesheet"], style')).forEach(function(el){ head.appendChild(el.cloneNode(true)); });
      // Collect ALL scripts (head entry bundle + body), in document order. Strip body
      // scripts from the markup so innerHTML doesn't leave inert duplicates.
      var scripts = (doc.head ? toArr(doc.head.querySelectorAll('script')) : []).concat(doc.body ? toArr(doc.body.querySelectorAll('script')) : []);
      if (doc.body) toArr(doc.body.querySelectorAll('script')).forEach(function(s){ if (s.parentNode) s.parentNode.removeChild(s); });

      // Resolve the entry modules' imports to blob: URLs via an import map.
      var modUrls = [];
      scripts.forEach(function(sc){
        if ((sc.getAttribute('type')||'').indexOf('module') < 0) return;
        if (sc.getAttribute('src')) { try { modUrls.push(new URL(sc.getAttribute('src'), u).href); } catch(e){} }
        else moduleImports(sc.textContent||'').forEach(function(spec){ try { var a=new URL(spec, u).href; if(/^https:/i.test(a)) modUrls.push(a); }catch(e){} });
      });
      if (modUrls.length && window.rpt && rpt.fetchModuleGraph) {
        try {
          var graph = await rpt.fetchModuleGraph(modUrls);
          var imports = {};
          (graph||[]).forEach(function(mod){ imports[mod.url] = URL.createObjectURL(new Blob([mod.source], {type:'application/javascript'})); });
          var im = document.createElement('script'); im.type='importmap'; im.textContent = JSON.stringify({ imports: imports });
          (document.head||document.documentElement).appendChild(im);
          llog('importmap: ' + (graph?graph.length:0) + ' module(s)');
        } catch(e){ llog('module graph fail: ' + ((e&&e.message)||e)); }
      }

      var bodyHtml = doc.body ? doc.body.innerHTML : html;
      self.each(function(){ this.innerHTML = bodyHtml; });
      var target = self[0] || document.body;
      scripts.forEach(function(old){ execScript(old, target); });
      llog('mounted ' + u + ' (' + scripts.length + ' script(s); Vue=' + (!!window.Vue) + ')');
      // Confirm the app actually rendered into its mount point (vs a height-only issue).
      setTimeout(function(){ try { var app=document.getElementById('app'); llog('post-mount: #app=' + (app?('children:'+app.childElementCount):'missing') + ', bodyH=' + document.body.scrollHeight); } catch(e){} }, 500);
      if (typeof cb === 'function') cb();
    }).catch(function(e){ llog((e && e.message) || e); });
    return this;
  };
  function $(sel){
    if (sel instanceof JQ) return sel;
    if (typeof sel === 'function') return new JQ([document]).ready(sel);
    if (sel && (sel.nodeType || sel===window)) return new JQ([sel]);
    if (typeof sel === 'string'){
      var s = sel.trim();
      if (s.charAt(0)==='<'){ var d=document.createElement('div'); d.innerHTML=s; return new JQ(toArr(d.childNodes).filter(function(n){ return n.nodeType===1; })); }
      try { return new JQ(toArr(document.querySelectorAll(s))); } catch(e){ return new JQ([]); }
    }
    return new JQ([]);
  }
  $.fn = p;
  $.noop = function(){};
  $.extend = Object.assign;
  $.get = function(url, cb){ return fetch(String(url)).then(function(r){ return r.text(); }).then(function(d){ if (cb) cb(d); return d; }); };
  $.ajax = function(o){ o=o||{}; return fetch(String(o.url), { method: o.type||o.method||'GET' }).then(function(r){ return o.dataType==='json' ? r.json() : r.text(); }).then(function(d){ if (o.success) o.success(d); return d; }).catch(function(e){ if (o.error) o.error(e); }); };
  window.$ = window.jQuery = $;
})();
`
