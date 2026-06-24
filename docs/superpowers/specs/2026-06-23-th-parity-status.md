# TavernHelper Host — Parity Status

> Status of the JSR faithful-host card-API surface after the SP1→SP3 + worldbook + var-macros + events +
> macros work. Records what's complete, and the remaining intentional stubs + why.

## Inline ↔ WCV parity: COMPLETE

Every card-facing method behaves the **same** across the two transports (inline `cardBridge` + WCV
`wcvPreload`), built from the one `shared/thRuntime` over a `Host` seam. The **last real asymmetry** was the
inline `onHostEvent` no-op (inline cards missed lifecycle/stream events) — fixed by the `cardHostEvents`
renderer bus (`6d04763`). With that, the architecture goal — *any ST/JSR card runs identically in either
mode* — holds for the implemented surface.

## Functional surface (works, both transports)

Variables/MVU · chat read + write (set/delete/save/reload/setInput) · worldbook read + **CRUD/bind** (full
library) · char/preset reads · regex **read + format** · `generate`/`generateRaw` · the `tavern_events`
lifecycle/mutation/**stream** events · `EjsTemplate.*` (the EJS engine) · **`substitudeMacros`/
`substituteParams`** (now expand `{{macros}}`) · `{{get_X_variable}}`/`{{format_X_variable}}` macros · the
assumed render-env libs + sizing + `window.top` surface.

## Remaining: intentional at-parity stubs (both transports identical)

Each is stubbed the SAME in both transports (so parity holds) and deferred for a real reason. Filling any
needs the same pattern as the worldbook/chat-write WCV work: a renderer impl for inline + a ctx-scoped
`wcv-host-*` IPC for WCV.

| Method | Why deferred | To fill |
| --- | --- | --- |
| `triggerSlash` (STScript) | The roadmap's explicit **XL "last" track**; the runner (`plugin/slash.ts`/`stscript.ts`) is renderer-side; the home onboarding works via the composer-inject path already, so it's not blocking. | Inline → `runSlash`/`runScript`; WCV → a `wcv-host-trigger-slash` IPC round-tripped to the renderer runner. |
| `audio*` (`audioPlay`/Pause/Import/Mode/Enable) | Cards play audio **natively** (`<audio>`/WebAudio) under the card CSP — the real path; the TH audio API is redundant. | Inline → `plugin/audioService`; WCV → an audio IPC (only if a card insists on the API over native). |
| `replaceTavernRegexes` (regex **write**) | **Risky** (a runtime regex rewrite can break the card's own beautification) and **rare**; the read + `formatAsTavernRegexedString` cover the real cases. | `scriptApiService` regex write, gated. |
| `registerMacroLike` | Cross-process (a card's custom macro must reach prompt-time expansion in **main**) and low-demand. | A render-time macro registry + a main bridge. |

## Net

The card-API **parity goal is met**, and the high-value functional gaps are closed. The four items above are
honest, documented stubs — each fillable on demand with the established renderer-impl + WCV-IPC pattern, but
not worth forcing low-value/risky cross-process code speculatively.
