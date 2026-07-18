import { createHash } from 'node:crypto'
import { ChatMessage, BudgetClass } from '../promptBuilder'
import { PresetParameters } from '../../types/preset'
import {
  ExecutionRecord,
  RecordContent,
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
 * 18c/M5(M3-review) — the explicit per-message budget policy an artifact carries for `messages.trim`:
 * one `BudgetClass` per wire message, or `undefined` when no reliable policy exists.
 *
 * The alignment is by MESSAGE IDENTITY (role + content), NOT by position/length (the pre-M5 rule was
 * `contributions.length === messages.length` + `messages[i] ⇄ contributions[i]`). Positional alignment
 * broke two ways the M3 review flagged:
 *  · Finding 1 — provider shaping REORDERS the wire (e.g. `orderForProvider` moves the trailing user
 *    last, or a merge/prefill reshuffles) WITHOUT changing length. Positionally, `messages[i]` then gets
 *    contribution `i`'s class — a `pinned` system could inherit a `history` class and be evicted. Identity
 *    alignment classifies each message by WHAT it is, so a reorder can't misclass it.
 *  · Finding 3 — a CHAINED second trim: after `withTrimmedMessages` swapped in a shorter `messages`, the
 *    length no longer equals `contributions`, so the positional guard returned `undefined` and the second
 *    trim degraded to `fitToBudget`'s position-based fallback. Identity alignment maps the REMAINING
 *    messages back to their contributions regardless of the length gap, so the policy survives re-trims.
 *
 * A message with NO matching contribution ⇒ `undefined` (no reliable per-message policy → the caller
 * falls back to `fitToBudget`'s legacy position-based trim). This preserves the pre-18c outcome exactly
 * where the pre-M5 code also returned `undefined`:
 *  · a synthetic wrapped-`Messages` artifact declares no `budgetClass` on any contribution (guarded first);
 *  · a fully-assembled artifact whose shaping COALESCED messages (merge-all / ST squash / ChatSquash)
 *    produces wire content that matches no single pre-shape contribution → `undefined`. When shaping did
 *    NOT change the content (native / merge-off / reorder-only), the wire identity-matches its
 *    contributions and the history-aware policy is retained.
 *
 * Duplicate messages (same role+content) are consumed in contribution order via a per-key queue, so two
 * identical turns map to two distinct contributions rather than both grabbing the first.
 */
export const artifactBudgetClasses = (a: PromptArtifact): BudgetClass[] | undefined => {
  // Every contribution must declare a class for a policy to exist at all (synthetic artifacts don't).
  if (!a.contributions.length) return undefined
  if (!a.contributions.every((c) => c.budgetClass != null)) return undefined

  // Queue the declared classes per identity key, in contribution order (handles duplicates).
  const key = (m: { role: string; content: string }): string => `${m.role} ${m.content}`
  const pool = new Map<string, BudgetClass[]>()
  for (const c of a.contributions) {
    const k = key(c)
    const q = pool.get(k)
    if (q) q.push(c.budgetClass as BudgetClass)
    else pool.set(k, [c.budgetClass as BudgetClass])
  }

  // Assign each wire message its contribution's class by identity; any unmatched message ⇒ no policy.
  const out: BudgetClass[] = []
  for (const m of a.messages) {
    const q = pool.get(key(m))
    if (!q || q.length === 0) return undefined
    out.push(q.shift() as BudgetClass)
  }
  return out
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

/**
 * 18e SEAM 2 — the capability-gated PRE-DISPATCH MUTATION seam (Tier-4 TavernHelper, issue 19).
 *
 * A high-trust TavernHelper late hook (the `CHAT_COMPLETION_PROMPT_READY` analogue) gets the FINAL,
 * provider-shaped message array just before dispatch and may rewrite it. This is the ONE place such a
 * hook composes in — and it composes in ATTRIBUTABLY: every hook that actually changes the array is
 * delta-recorded as an `opaque` execution-record entry (`source.id` = the script id, `source.label` =
 * the hook name, before/after as SHA-256 hashes, never the copied text), NEVER a raw untracked array
 * swap. A no-op hook records nothing (behavior-neutral). With zero hooks the messages pass through
 * byte-identical (so the default generation path is unchanged — the parity contract holds).
 *
 * TODO(F2/F3 — tavernhelper-docs-spec §3): the docs are SILENT on the late-hook's exact EVENT NAME
 * (they link an off-limits source `.d.ts`) and on whether the payload is a LIVE MUTABLE object the
 * hook's return replaces. This seam records + applies the hook's RETURNED array (the most faithful
 * mutable-payload model the docs support) and treats `hook` as an opaque label pending the F2 (payload
 * mutability) + F3 (event enumeration/order) black-box fixtures. Populating hooks from a live WCV
 * high-trust script across the realm boundary is the remaining wiring (see `dispatchHooks.ts`).
 */
export interface DispatchTransform {
  /** The attributed identity — the upstream TH script id (or its file id) the mutation belongs to. */
  scriptId: string
  /** The late-hook name (the CHAT_COMPLETION_PROMPT_READY analogue). F2/F3-guarded — treated as a label. */
  hook: string
  /** Rewrite the final message array. MUST return an array; a non-array return is ignored (no-op). */
  apply: (messages: ChatMessage[]) => ChatMessage[]
}

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
const PREVIEW_CHARS = 80
/** Canonical string of a message array, for the before/after opaque hashes. */
const joinForHash = (messages: ChatMessage[]): string =>
  messages.map((m) => `${m.role}\n${m.content}`).join(' ')
/** An opaque `ref` payload (hash + bytes + short preview) — matches the record builder's `ref`. */
const refContent = (s: string): RecordContent => ({
  kind: 'ref',
  hash: sha256Hex(s),
  bytes: Buffer.byteLength(s, 'utf8'),
  preview: s.slice(0, PREVIEW_CHARS)
})

/**
 * Apply the pre-dispatch transforms in order to the final message array, returning the mutated array PLUS
 * one `opaque` RecordEntry per transform that ACTUALLY CHANGED it. PURE: never mutates its inputs, and a
 * transform that returns an equal array (or a non-array) yields no entry and leaves the array as-is. The
 * returned entries carry `seq: 0`; `appendDispatchEntries` re-indexes them onto a record.
 */
export const applyDispatchTransforms = (
  messages: ChatMessage[],
  transforms: DispatchTransform[]
): { messages: ChatMessage[]; entries: RecordEntry[] } => {
  let current = messages
  const entries: RecordEntry[] = []
  for (const t of transforms || []) {
    let next: ChatMessage[]
    try {
      next = t.apply(current)
    } catch {
      continue // a throwing hook is a no-op (its wreckage stays inside the isolated realm)
    }
    if (!Array.isArray(next)) continue
    const before = joinForHash(current)
    const after = joinForHash(next)
    if (before === after) {
      current = next
      continue // no observable change → record nothing (behavior-neutral)
    }
    entries.push({
      seq: 0,
      stage: 'opaque',
      source: { kind: 'pipeline', id: t.scriptId, label: t.hook },
      before: refContent(before),
      after: refContent(after),
      note: `pre-dispatch hook ${t.hook}`
    })
    current = next
  }
  return { messages: current, entries }
}

/**
 * Append pre-dispatch mutation entries to a Prompt artifact's execution record (re-indexing `seq`). PURE —
 * returns a NEW artifact (or the same one when there is no record / no entries). This is how the late-hook
 * deltas land on the forensic record the preview reader surfaces.
 */
export const appendDispatchEntries = (a: PromptArtifact, entries: RecordEntry[]): PromptArtifact => {
  if (!a.record || !entries.length) return a
  const base = a.record.entries.length
  const reindexed = entries.map((e, i) => ({ ...e, seq: base + i }))
  return { ...a, record: { ...a.record, entries: [...a.record.entries, ...reindexed] } }
}
