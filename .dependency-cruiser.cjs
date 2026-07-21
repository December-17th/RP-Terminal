// Module-boundary gate (CLAUDE.md "Module boundaries"). Run via `npm run check:deps`.
// Encodes the architecture's load-bearing import rules so a boundary crossing fails CI/the
// verification gate instead of silently rotting. Crossing a boundary on purpose = change the
// relevant rule here, deliberately, in the same PR (CLAUDE.md) — do NOT bypass the check.
//
// Verified clean at introduction (2026-06-26, WS-10): the rules below match the code as-is; no
// existing violations. See docs/structural-cleanup-log-2026-06-26.md.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'shared-not-to-main-renderer',
      comment:
        'shared/* is pure (runs in BOTH processes + tests) — it must not import from main or renderer.',
      severity: 'error',
      from: { path: '^src/shared' },
      to: { path: '^src/(main|renderer)' }
    },
    {
      name: 'shared-not-to-electron',
      comment: 'shared/* must not depend on electron (it runs outside the electron process too).',
      severity: 'error',
      from: { path: '^src/shared' },
      to: { path: 'node_modules/electron/' }
    },
    {
      name: 'renderer-not-to-main',
      comment:
        'renderer reaches main ONLY through the typed IPC surface (window.api / preload), never main internals.',
      severity: 'error',
      from: { path: '^src/renderer' },
      to: { path: '^src/main' }
    },
    {
      name: 'combat-engine-pure',
      comment:
        'The combat/game engine (src/shared/combat) must NOT import renderer, electron, IPC, or main.',
      severity: 'error',
      from: { path: '^src/shared/combat' },
      to: { path: '^src/(main|renderer|preload)|node_modules/electron/' }
    },
    {
      name: 'agent-contracts-pure',
      comment:
        'AgentContracts (src/shared/agentRuntime) is a pure shared Module and must not import renderer, main, preload, or electron.',
      severity: 'error',
      from: { path: '^src/shared/agentRuntime(?:/|$)' },
      to: { path: '^src/(main|renderer|preload)|node_modules/electron/' }
    },
    {
      name: 'transports-no-cross-import-inline-to-wcv',
      comment:
        'The card transports never import each other: inline cardBridge must not reach the WCV transport.',
      severity: 'error',
      from: { path: '^src/renderer/src/cardBridge' },
      to: { path: '^src/preload/wcv' }
    },
    {
      name: 'transports-no-cross-import-wcv-to-inline',
      comment:
        'The card transports never import each other: the WCV transport must not reach the inline cardBridge.',
      severity: 'error',
      from: { path: '^src/preload/wcv' },
      to: { path: '^src/renderer/src/cardBridge' }
    },
    {
      // Informational (does not fail the gate) — surfaces accidental cycles without blocking.
      name: 'no-circular',
      comment: 'Warn on circular dependencies (informational).',
      severity: 'warn',
      from: {},
      to: { circular: true }
    }
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Follow type-only imports too, so a renderer→main *type* import is caught like a value one.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.web.json' },
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json']
    }
  }
}
