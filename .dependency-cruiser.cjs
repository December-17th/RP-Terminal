/**
 * Module-boundary rules for RP Terminal (enforced by `npm run check:deps`).
 *
 * These encode the boundaries documented in CLAUDE.md. Crossing one is a deliberate act: change the
 * relevant rule here in the SAME change, with justification — do NOT add an eslint-disable or bypass
 * the check. See CLAUDE.md "Module boundaries".
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make modules hard to reason about, test, and tree-shake.',
      from: {},
      to: { circular: true }
    },
    {
      name: 'shared-no-renderer-or-main',
      severity: 'error',
      comment:
        'src/shared/* is the environment-agnostic common layer; it must NOT import from renderer ' +
        'or main (CLAUDE.md). Move the shared piece down, or invert the dependency.',
      from: { path: '^src/shared/' },
      to: { path: '^src/(renderer|main)/' }
    },
    {
      name: 'combat-engine-is-pure',
      severity: 'error',
      comment:
        'The combat/game engine (src/shared/combat) must stay pure: no renderer, main, preload, ' +
        'Electron, or IPC. Wire side effects in from outside the engine (CLAUDE.md).',
      from: { path: '^src/shared/combat/' },
      to: { path: '^src/(renderer|main|preload)/|^electron($|/)' }
    },
    {
      name: 'renderer-no-main-internals',
      severity: 'error',
      comment:
        'Renderer imports main ONLY through the typed IPC surface / preload bridge — never main ' +
        'internals (CLAUDE.md).',
      from: { path: '^src/renderer/' },
      to: { path: '^src/main/' }
    },
    {
      name: 'main-no-renderer',
      severity: 'error',
      comment: 'The main process must not import renderer code (CLAUDE.md).',
      from: { path: '^src/main/' },
      to: { path: '^src/renderer/' }
    },
    {
      name: 'preload-no-main-internals',
      severity: 'error',
      comment:
        'Preload is the bridge between main and renderer; it must not reach into main internals ' +
        '(it shares only types via src/shared).',
      from: { path: '^src/preload/' },
      to: { path: '^src/main/' }
    },
    {
      name: 'card-transports-stay-at-parity',
      severity: 'error',
      comment:
        'The two card transports — inline cardBridge and WCV wcvPreload — must stay at parity via ' +
        'the shared runtime (src/shared/thRuntime) and never import each other (CLAUDE.md).',
      from: { path: '^src/renderer/src/cardBridge/' },
      to: { path: '^src/preload/wcvPreload' }
    },
    {
      name: 'card-transports-stay-at-parity-rev',
      severity: 'error',
      comment:
        'The two card transports must stay at parity via the shared runtime and never import each ' +
        'other (CLAUDE.md).',
      from: { path: '^src/preload/wcvPreload' },
      to: { path: '^src/renderer/src/cardBridge/' }
    }
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    includeOnly: '^src/',
    tsConfig: { fileName: 'tsconfig.web.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json']
    }
  }
}
