/**
 * Source rewrites applied to a frontend card's fetched scripts before they run in the
 * process-isolated (opaque) frame — redirecting cross-origin runtime reaches to the
 * frame-local shim.
 *
 * `window.top` / `window.parent` are non-configurable readonly (can't be shadowed) and throw
 * cross-origin in an opaque frame, so a card's `window.top?.SillyTavern…` would die. We rewrite
 * those *qualified* member accesses to plain `window`, where ST_RUNTIME_SHIM injects
 * SillyTavern/Mvu. Only `window.top`/`window.parent` are touched — bare `top`/`parent` are too
 * risky (they collide with ordinary identifiers), and `window.parentNode`/`window.parentElement`
 * are preserved by the `\b` after `parent`.
 *
 * Kept here as a shared constant so the in-frame loader (shims/jquery.ts) and the unit tests use
 * the exact same pattern.
 */
export const STRIP_PARENT_RE = /\bwindow\s*\.\s*(?:top|parent)\b/

export const stripParentRefs = (src: string): string =>
  String(src == null ? '' : src).replace(new RegExp(STRIP_PARENT_RE.source, 'g'), 'window')

// --- Remote ES-module inlining ---------------------------------------------------------
//
// A static `import 'https://…'` fails inside the process-isolated (opaque-origin) frame —
// native cross-origin module resolution doesn't work there. The fix (used by `$.load()` and,
// via these helpers, by the card-script runtime): host-fetch the whole module graph, then
// rewrite every import specifier to a self-contained `data:` URL so the import resolves
// frame-locally. These helpers are pure so both the in-frame loader and the host can share them.

// Matches a static/dynamic import or re-export specifier: group 1 = the `from `/`import `/
// `import(` prefix, 2 = open quote, 3 = the specifier, 4 = close quote.
const IMPORT_SPEC_RE = /((?:from|import)\s*\(?\s*)(['"])([^'"]+)(['"])/g

/** Absolute `https:` module specifiers a module's source imports (deduped). */
export const remoteImportUrls = (code: string): string[] => {
  const out: string[] = []
  const re = new RegExp(IMPORT_SPEC_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(code || ''))) {
    if (/^https:\/\//i.test(m[3])) out.push(m[3])
  }
  return Array.from(new Set(out))
}

export interface ModuleSource {
  url: string
  source: string
}

/**
 * Rewrite an entry module's source so its (transitive) remote imports resolve to self-contained
 * `data:` URLs, given the host-fetched module graph. Modules are encoded in dependency order so
 * a parent's deps already have `data:` URLs when it's encoded; each module's `window.top/parent`
 * reaches are neutralized (`stripParentRefs`). Specifiers not present in the graph are left as-is.
 * Pure.
 */
export const inlineRemoteModuleGraph = (entryCode: string, graph: ModuleSource[]): string => {
  const srcByUrl = new Map(graph.map((m) => [m.url, m.source]))
  const dataByUrl = new Map<string, string>()

  const mkmod = (src: string): string =>
    'data:text/javascript;charset=utf-8,' + encodeURIComponent(stripParentRefs(src))

  // In-graph dependency URLs of a module (specifiers resolved against its own URL).
  const depUrls = (src: string, base: string): string[] => {
    const deps: string[] = []
    const re = new RegExp(IMPORT_SPEC_RE.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      try {
        const abs = new URL(m[3], base).href
        if (srcByUrl.has(abs)) deps.push(abs)
      } catch {
        /* unresolvable specifier — skip */
      }
    }
    return deps
  }

  // Replace each in-graph specifier with its data: URL. Always double-quote the replacement:
  // encodeURIComponent leaves raw single quotes (would close a '…' specifier) but escapes ".
  const rewrite = (src: string, base: string): string =>
    src.replace(new RegExp(IMPORT_SPEC_RE.source, 'g'), (whole, pre, _q1, spec) => {
      try {
        const data = dataByUrl.get(new URL(spec, base).href)
        if (data) return pre + '"' + data + '"'
      } catch {
        /* unresolvable specifier — leave untouched */
      }
      return whole
    })

  const urls = [...srcByUrl.keys()]
  let guard = 0
  while (urls.some((u) => !dataByUrl.has(u)) && guard++ < urls.length + 2) {
    for (const u of urls) {
      if (dataByUrl.has(u)) continue
      if (depUrls(srcByUrl.get(u) as string, u).every((d) => dataByUrl.has(d))) {
        dataByUrl.set(u, mkmod(rewrite(srcByUrl.get(u) as string, u)))
      }
    }
  }
  // Any leftover (e.g. a dependency cycle) still gets encoded so nothing is left unresolved.
  for (const u of urls) {
    if (!dataByUrl.has(u)) dataByUrl.set(u, mkmod(rewrite(srcByUrl.get(u) as string, u)))
  }

  // Rewrite the entry script's imports. A bare side-effect `import '…'` becomes a NON-BLOCKING
  // dynamic import so a failed/slow bundle load can't abort the rest of the script — notably its
  // baked action-button registration (which must run for the button to appear in the menu). This
  // also strips the entry's static module syntax, so it runs as a classic script and its
  // top-level (the button IIFE) executes synchronously. Bound/dynamic imports keep their data: URL.
  return entryCode.replace(new RegExp(IMPORT_SPEC_RE.source, 'g'), (whole, pre, _q1, spec) => {
    try {
      const data = dataByUrl.get(new URL(spec, 'https://rpt.local/').href)
      if (!data) return whole
      if (/^import\s*$/.test(pre)) return 'import("' + data + '").catch(function () {})'
      return pre + '"' + data + '"'
    } catch {
      return whole
    }
  })
}
