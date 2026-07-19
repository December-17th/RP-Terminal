# Agents assemble prompts through the existing engine, never inside the Harness

**Status: Accepted (2026-07-19), partially implemented.** Extends
[ADR 0020](0020-agent-runtime-replaces-workflow-system.md) and the
[Agent Runtime design](../agent-system/agent-runtime-design.md) §3, §10.

Implemented on `agent-system` 2026-07-19:

- **§4 (templating for every Agent)** — Agent prompt messages render through the existing engine via
  an injected renderer: `agentRuntime/prompt/agentPromptRenderer.ts`, an optional `render?` on
  `HarnessExecuteRequest` consumed by `harness/attemptLog.ts`, an `InvocationPromptRendererPort` on
  `InvocationRuntime`, wired at the `InvocationRuntimeService` composition root. The Harness imports
  no engine; `HarnessPreparedRequest` has no `render` field, so Classic's prepared path cannot
  acquire one and stays byte-identical.
- **§1/§3/§5 (preset-driven assembly)** — `agentRuntime/prompt/agentPresetAssembler.ts` holds the
  registration slot + the planner that decides, per attempt, between rendering and assembly;
  `generation/agentPresetAssembly.ts` is the real assembler (owning floor's `buildGenContext`,
  `matchAcross`, `assemblePrompt`), installed by `services/agentPresetAssemblyBridge.ts` — the same
  bridge shape `cardAgentCatalogBridge.ts` uses, because `generation → agentRuntime` already exists
  and the reverse import would close a cycle. The assembled messages substitute for
  `definition.prompt` via `HarnessExecuteRequest.prompt`, so a preset Agent still runs the FULL
  `execute` path (tools, retries, result contract). `HarnessPreparedRequest` gained nothing.
  History is `[]` unless a `HistoryPolicy` is declared, and `maxFloors`/`maxTokens`/
  `includeUserMessages`/`includePlayerResults` are enforced in `historyMessages`.
- **§2 (parameter precedence)** — one layer inserted in `ProviderDispatch.resolve` as
  `ProviderSelection.presetBundleParameters`: resolved generation preset → bundle → invocation
  override. `AgentHarness.execute` forwards it from `definition.preset.generationParameters`.
- **Unspecified by this ADR, decided in implementation:** `includePlayerResults` renders the owning
  floor's `variables.__rpt.agent_results` as ONE trailing system block, not a per-floor diff; entry
  filters match by `comment` and therefore match every entry sharing a title (documented in
  `filterEntries`); an explicit lorebook name that resolves to nothing is logged and skipped.

Known gap: `initTemplates()` is fire-and-forget at `src/main/index.ts:194`, so an Agent invoked in the
first moments of startup can find the engine unready and fall open to raw prompt text. Classic shares
this property; it is not introduced by this work.

## Context

An `AgentDefinition` currently carries a literal `prompt: PromptMessage[]`, and
`buildAttemptLog` (`src/main/services/agentRuntime/harness/attemptLog.ts:46-66`) sends those messages
verbatim after a harness-policy system line. Nothing evaluates them.

That is wrong for real Agents, and the two converted shujuku consumers prove it. Their prompts are
**already ST-Prompt-Template EJS**:

```text
character-progression.rptagent : 14 `<%` tags
world-progression.rptagent     :  8 `<%` tags
<%= getvar('系统核心名') %>
<% const WorldDynamic = getMessageVar('世界后台状态.世界时局与经济简报', { defaults: '' }); %>
```

Sent as-is, the model receives the literal tag text. These prompts are inert templates today.

RP Terminal already owns the engine they need: `src/shared/templateEngine.ts` registers `getvar`
(:270) plus `getLocalVar`/`getGlobalVar`/`getMessageVar`/`getChatVar` (:441-455) in a quickjs sandbox,
and `assemblePrompt` (`src/main/services/generation/assemble.ts:119`) is the full preset-driven
assembler used by Classic.

The constraint is that the
[Classic Narrator plan](../agent-system/classic-narrator-first-execution-plan.md) states the Harness
"does not become the owner of prompt policy, floor replay, transports, tools, scheduling, or workflow
composition."

## Decision

**Assembly happens BEFORE the Harness. The Harness never assembles; it receives finished messages.**

Both Agent kinds resolve their messages outside the Harness and hand them in:

```text
messages Agent → templateEngine (EJS + macros + TH shim) ─┐
                                                          ├→ HarnessExecuteRequest.prompt → execute
preset Agent   → assemblePrompt(GenContext + bundle) ─────┘
```

They enter through `execute`, NOT `executePrepared`. That correction matters and was made during
implementation: a preset Agent still needs the full `execute` path — tools, retries, Result Contract —
so routing it to the prepared path would have silently stripped those. The assembled messages instead
substitute for `definition.prompt` via `HarnessExecuteRequest.prompt`. `executePrepared` remains
Classic's private door and gained nothing, which is what keeps Classic byte-identical.

Consequences of that placement: the Harness gains nothing, its tool loop is untouched, and prompt
policy stays in `generation/`. `agentRuntime` must NOT import `generation/` — that inverts the
existing `generation → agentRuntime` direction and closes a cycle. `agentRuntime` therefore owns an
empty registration slot that a generation-side bridge fills at startup, the same shape
`cardAgentCatalogBridge.ts` uses.

### 1. An Agent declares either messages or a bundled preset

`prompt` stays and remains the simple path. A new optional `preset` bundle turns on full assembly.
When both are present, the preset assembles the context and the `prompt` messages are the Agent's
task instruction, appended after assembly. This keeps every existing definition valid.

### 2. The bundle carries a prompt preset plus optional parameter overrides

The bundle contains the ST **prompt** preset (prompts, order, injection depths) and MAY carry
generation-parameter overrides. It does NOT carry a connection or model: design §10's rule that a
portable Agent cannot reference a user-local preset id stands. Parameter precedence gains one layer,
the Agent's overrides sitting directly above the resolved API preset.

### 3. Assembly context is full, history is opt-in, lorebooks are selectable

A preset Agent assembles against its owning floor's real `GenContext` — character card, persona,
world info — because a plot-progression Agent cannot do its job otherwise. Chat **history** is
included only when the Agent declares a `HistoryPolicy`, so the cost of history is explicit per
Agent rather than the silent default.

The bundle may additionally select **which lorebooks and which entries** feed assembly: the session's
normal set, or an explicit list, narrowed by entry include/exclude. This lets a world-progression
Agent read a different slice of the world than the narrator does.

### 4. Templating applies to every Agent

All prompt messages evaluate through `templateEngine`, whether or not a preset is bundled. There is
no opt-in flag: an Agent whose prompt contains `<%` today is already broken, so evaluating is the fix,
not a behaviour change to protect against.

### 5. The bundle is inline and lossless

The preset is embedded in the definition as a lossless envelope
([ADR 0018](0018-presets-persist-as-lossless-envelopes-edited-in-place.md)), so a `.rptagent` file or
a card-bundled Agent is self-contained and portable. Definitions get large; that is accepted.

## Consequences

- Definitions grow substantially; the catalog's baseline/customization/effective diff now spans
  preset internals. Whether the envelope should become its own column rather than living inside
  `effective_definition` is deferred until the diff proves unwieldy in practice.
- Agent runs become materially more expensive: full card/persona/worldinfo per invocation.
  `HistoryPolicy` is the only lever that bounds it, so it must be honoured, not advisory.
- A preset Agent's assembly depends on the owning floor's chat state, so identical inputs at
  different floors legitimately produce different prompts. Run Records already store the rendered
  prompt, which is what makes that auditable.
- The `{{...}}` placeholders in the shujuku prompts (`{{WorldDynamic}}`) correspond to that preset's
  `extractInjectTags`: one task's extracted output is injected into another's prompt. In RPT terms
  that is a Result Slot read, expressible as an input binding — the cross-Agent data flow does not
  need a new mechanism.

## Alternatives rejected

- **Assemble inside the Harness.** Simplest wiring, but makes the Harness the owner of prompt policy,
  which the Classic Narrator plan forbids, and would couple the tool loop to preset semantics.
- **Opt-in templating flag.** Preserves byte-identical behaviour for existing definitions, but every
  real definition inspected already needs evaluation, so the flag would be on everywhere and would
  only add contract surface.
- **Reference a preset by name with an inline fallback.** Smaller definitions and one place to retune,
  but reintroduces the user-local reference that design §10 forbids for portable Agents.
