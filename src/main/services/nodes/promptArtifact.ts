import { ChatMessage, BudgetClass } from '../promptBuilder'
import { PresetParameters } from '../../types/preset'
import {
  ExecutionRecord,
  RecordEntry,
  RecordRole,
  RecordSource
} from '../../../shared/executionRecord'

/**
 * The `Prompt` port's value model (issue 18a / PLAN.md Phase 3 / decision 11): the assembly
 * ARTIFACT carried between the built-in prompt-producing and prompt-consuming nodes.
 *
 * ONE artifact type — NOT one port per intermediate phase (a per-phase port would make the prompt
 * module shallow; PLAN.md is explicit). The same shape carries both a bare set of authored
 * CONTRIBUTIONS (a legacy `Messages` producer wrapped with synthetic provenance) and a fully
 * assembled + provider-shaped prompt (`prompt.assemble` / `prompt.preset`). A consumer takes "a
 * prompt", not "a phase".
 *
 * Lives MAIN-SIDE (not in `src/shared`) because it references main types — `ChatMessage`
 * (promptBuilder) and `PresetParameters` (types/preset). The engine only ever sees a port value as
 * `unknown`, so nothing forces this into shared; the `Prompt` port-type STRING (a bare literal) is
 * the only shared piece (`src/shared/workflow/types.ts`). It reuses the execution record's
 * provenance vocabulary (`RecordSource` / `RecordRole`) so a contribution and the record it later
 * appears in speak the same identity language.
 *
 * THE TWO PUBLIC CUSTOMIZATION SEAMS (issue 18e / PLAN.md Phase 3 — "exactly two", no per-phase
 * checkpoint; internal assembly phases stay private, PLAN decision 5):
 *  1. CONTRIBUTION-before-assembly — the existing `prompt-assembly` checkpoint
 *     (`shared/workflow/attachments.ts`): a fragment/pack/agent rejoins authored inputs (the `entries`
 *     and `block` lanes into `prompt.assemble`) BEFORE structural assembly runs. That is the sole
 *     pre-assembly authoring seam; this module does not add a second one.
 *  2. TRANSFORMATION-before-dispatch — `resolveDispatchMessages` below, invoked at `llm.sample`, the
 *     single provider-dispatch boundary. It reads the artifact's `shaped` flag so a Prompt-native
 *     workflow that authored contributions but did NOT provider-shape gets shaped EXACTLY ONCE here,
 *     while an already-shaped artifact (or a legacy `sendMessages` array) passes through untouched. A
 *     capability-gated transform (Tier-4 TavernHelper, issue 19) attaches at this same seam.
 *
 * Realized here across 18c/18d/18e:
 *  · 18c fills `PromptContribution.budgetClass` (from the assembler's explicit budget policy) and lets
 *    `messages.trim` honor it + record budget omissions on the record.
 *  · 18d carries the history span as `budgetClass:'history'` contributions instead of the retired
 *    non-enumerable `HISTORY_TAG` marker.
 *  · 18e reads `shaped` at the dispatch seam to shape exactly once (never double-shape).
 */

/** Discriminator stamped on every artifact so a runtime port value (typed `unknown` by the engine)
 *  can be recognized as a `PromptArtifact` by the final adapters below. */
export const PROMPT_ARTIFACT_KIND = 'prompt-artifact'

/**
 * One authored input to prompt assembly — CONTEXT.md "Prompt Contribution". 18a populates the
 * load-bearing fields (source, role, content, order); the remainder of CONTEXT.md's list (placement
 * intent, activation, budget class, trust) is declared OPTIONAL so 18c/18e extend the type in place
 * without a reshape.
 */
export interface PromptContribution {
  /** Provenance identity (reuses the execution record's source vocabulary). */
  source: RecordSource
  role: RecordRole
  content: string
  /** Position within its artifact's contribution list (ascending). */
  order: number
  /** True when a legacy adapter synthesized this contribution by wrapping a bare `ChatMessage[]`
   *  (a `Messages` producer) rather than authoring it as a first-class contribution. */
  synthetic?: boolean
  /** 18c/18d trim policy: `history` = a chat-history turn (droppable oldest-first under token
   *  pressure — the explicit-data successor to the retired HISTORY_TAG); `pinned` = static content
   *  never dropped. Unset on a synthetic wrapped-`Messages` contribution (no assembly policy) — such
   *  a list trims on `fitToBudget`'s legacy fallback. `messages.trim` honors it (see
   *  `artifactBudgetClasses`). */
  budgetClass?: BudgetClass
}

/**
 * The rich value on a `Prompt` port. `messages` is the resolved wire form the FINAL adapter exposes
 * to legacy `ChatMessage[]` consumers; `record` and `params` are present only for a full assembly
 * (`prompt.assemble` / `prompt.preset`). `contributions` is ALWAYS populated so a Prompt-native
 * consumer (18c/18e) never has to reach through to `messages`.
 */
export interface PromptArtifact {
  kind: typeof PROMPT_ARTIFACT_KIND
  /** Authored inputs to assembly (synthetic provenance for wrapped `Messages` producers). */
  contributions: PromptContribution[]
  /** The resolved wire messages — the final-adapter output. */
  messages: ChatMessage[]
  /** Sampler params — present for a full preset assembly, absent for a bare `Messages` producer. */
  params?: PresetParameters
  /** The forensic execution record — present for a full assembly (`prompt.assemble`/`prompt.preset`). */
  record?: ExecutionRecord
  /** Whether `messages` is already provider-shaped. A full assembly shapes (true); a raw authored
   *  list may or may not be. The model-dispatch seam (18e) reads this to avoid double-shaping. */
  shaped: boolean
}

/** The default source for an ASSEMBLED artifact. Deliberately the generic assembler identity (not
 *  the invoking node type): `prompt.assemble` and `prompt.preset` both run the SAME `assemblePrompt`,
 *  so from the artifact's point of view they produce an equivalently-assembled prompt — the per-
 *  transform provenance lives in the `record` this artifact carries. Keeping it uniform also keeps
 *  the two nodes' outputs equivalent (their characterization pins that). */
const ASSEMBLED_SOURCE: RecordSource = { kind: 'pipeline', id: 'assemble', label: 'Assembled prompt' }

/** Runtime guard: is this port value a `PromptArtifact`? (Engine port values are `unknown`.) */
export const isPromptArtifact = (v: unknown): v is PromptArtifact =>
  typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === PROMPT_ARTIFACT_KIND

/**
 * Producer adapter — a FULLY ASSEMBLED prompt (`prompt.assemble` / `prompt.preset`) → `PromptArtifact`.
 * The messages are already provider-shaped, so `shaped: true` and the forensic record + sampler params
 * ride along. `record` is omitted when absent (the unit-test path that mocks `assemblePrompt` without
 * one) so two assembled artifacts with the same inputs stay deeply equal.
 *
 * `authored` (issue 18c) carries the PRE-shape, post-trim message list + its explicit budget policy —
 * the assembler's authored inputs. When present, the contributions are built from THAT (each tagged
 * with its `budgetClass`, so `history`/`pinned` provenance survives onto the artifact); when absent
 * (the mocked-assemble test path), contributions fall back to a 1:1 map of the wire messages, exactly
 * as before. Either way `messages` stays the provider-shaped wire — the behavior-neutral output.
 */
export const assembledArtifact = (
  messages: ChatMessage[],
  params: PresetParameters,
  record?: ExecutionRecord,
  authored?: { messages: ChatMessage[]; budgetClasses?: BudgetClass[] }
): PromptArtifact => ({
  kind: PROMPT_ARTIFACT_KIND,
  contributions: (authored?.messages ?? messages).map((m, i) => {
    const budgetClass = authored?.budgetClasses?.[i]
    return {
      source: ASSEMBLED_SOURCE,
      role: m.role,
      content: m.content,
      order: i,
      ...(budgetClass ? { budgetClass } : {})
    }
  }),
  messages,
  params,
  ...(record ? { record } : {}),
  shaped: true
})

/**
 * Producer adapter — a bare authored `ChatMessage[]` (a legacy `Messages` producer: `prompt.messages`,
 * and any future one) → `PromptArtifact`. Each message becomes a SYNTHETIC contribution so the list
 * carries provenance even though the node authored it flat. No record/params — this is not a full
 * assembly. `shaped` reflects whether the producer already provider-shaped the list.
 */
export const wrapMessages = (
  messages: ChatMessage[],
  source: RecordSource,
  shaped: boolean
): PromptArtifact => ({
  kind: PROMPT_ARTIFACT_KIND,
  contributions: messages.map((m, i) => ({
    source,
    role: m.role,
    content: m.content,
    order: i,
    synthetic: true
  })),
  messages,
  shaped
})

/**
 * Final adapter — the `ChatMessage[]` a legacy consumer (`llm.sample` / `parse.response` /
 * `output.writeFloor`) requires, from a `Prompt` port value. Returns undefined for a non-artifact
 * value so a consumer can fall back to its legacy `sendMessages` port.
 */
export const artifactMessages = (v: unknown): ChatMessage[] | undefined =>
  isPromptArtifact(v) ? v.messages : undefined

/** Final adapter — the sampler params from a `Prompt` port value (undefined when absent / non-artifact). */
export const artifactParams = (v: unknown): PresetParameters | undefined =>
  isPromptArtifact(v) ? v.params : undefined

/**
 * Resolve the `ChatMessage[]` a consumer node should send: the legacy `sendMessages` port wins when
 * wired (so seeded/existing docs stay byte-for-byte identical — the behavior-neutrality contract),
 * else the `Prompt` artifact's messages. Undefined when neither is wired (preserving the exact
 * pre-migration value — an unwired `sendMessages` was already `undefined`).
 */
export const resolveSendMessages = (legacy: unknown, prompt: unknown): ChatMessage[] | undefined =>
  (legacy as ChatMessage[] | undefined) ?? artifactMessages(prompt)

/** Resolve the sampler params a consumer node should use: the legacy `params` port wins when wired,
 *  else the `Prompt` artifact's params. Undefined when neither is wired (pre-migration value). */
export const resolveParams = (legacy: unknown, prompt: unknown): PresetParameters | undefined =>
  (legacy as PresetParameters | undefined) ?? artifactParams(prompt)

/**
 * 18c — the explicit per-message budget policy an artifact carries for `messages.trim`, but ONLY when
 * its contributions align 1:1 with `messages` AND every one declares a `budgetClass`. That holds for a
 * Prompt-native artifact whose authored contributions ARE the message list; it does NOT hold for a
 * fully-assembled artifact (its contributions are the PRE-shape authored inputs, so they differ in
 * length/order from the post-shape wire) nor for a synthetic wrapped-`Messages` artifact (no
 * `budgetClass`). In those cases → `undefined`, and the caller falls back to `fitToBudget`'s legacy
 * position-based trim on the wire — the pre-18c behavior. */
export const artifactBudgetClasses = (a: PromptArtifact): BudgetClass[] | undefined => {
  if (a.contributions.length !== a.messages.length) return undefined
  const classes = a.contributions.map((c) => c.budgetClass)
  return classes.every((c): c is BudgetClass => c != null) ? (classes as BudgetClass[]) : undefined
}

/**
 * 18c — apply a trim to a Prompt artifact: swap in the trimmed `messages` and, reusing the record's
 * budget-omission concept (issue 07/08 — a `trim` stage entry the preview reader surfaces as
 * omitted-by-budget), append one `trim` entry to the execution record. PURE: returns a NEW artifact
 * (fresh record with the entry appended), never mutating the input. No record present → just the
 * message swap. `note` is the human summary (e.g. "budget 8000 tok — dropped 3 message(s)").
 */
export const withTrimmedMessages = (
  a: PromptArtifact,
  messages: ChatMessage[],
  note: string
): PromptArtifact => {
  if (!a.record) return { ...a, messages }
  const entry: RecordEntry = {
    seq: a.record.entries.length,
    stage: 'trim',
    source: { kind: 'pipeline', id: 'trim' },
    note
  }
  return { ...a, messages, record: { ...a.record, entries: [...a.record.entries, entry] } }
}

/**
 * 18e SEAM 2 — the pre-dispatch transformation seam. Resolve the messages `llm.sample` sends AND
 * provider-shape them EXACTLY ONCE, at the single dispatch boundary:
 *  · a legacy `sendMessages` array wins when wired (already shaped by its producer) — passed through
 *    verbatim, so every seeded/existing doc is byte-for-byte unaffected;
 *  · an already-`shaped` Prompt artifact passes its wire through untouched (no double-shape);
 *  · an UNSHAPED Prompt artifact — a Prompt-native workflow that authored contributions but did not
 *    provider-shape — is shaped here, once, via `shape`.
 * `shape` (providerShape bound to the turn's settings) is invoked ONLY for the unshaped-artifact case,
 * so a legacy caller never triggers it. Returns undefined when neither input is wired (the pre-
 * migration value of an unwired `sendMessages`). This is also where a capability-gated pre-dispatch
 * transform (Tier-4, issue 19) would compose in.
 */
export const resolveDispatchMessages = (
  legacy: unknown,
  prompt: unknown,
  shape: (messages: ChatMessage[]) => ChatMessage[]
): ChatMessage[] | undefined => {
  if (legacy != null) return legacy as ChatMessage[]
  if (isPromptArtifact(prompt)) return prompt.shaped ? prompt.messages : shape(prompt.messages)
  return undefined
}
