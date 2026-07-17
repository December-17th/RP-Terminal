import { ChatMessage } from '../promptBuilder'
import { PresetParameters } from '../../types/preset'
import { ExecutionRecord, RecordRole, RecordSource } from '../../../shared/executionRecord'

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
 * SEAMS for the follow-up (18c/18d/18e), left clean here:
 *  · 18c (trim/budget policy) fills `PromptContribution.budgetClass` and trims against it, recording
 *    omissions on the artifact/record instead of the current `messages.trim` Messages-lane drop.
 *  · 18d (HISTORY_TAG retirement) lets the assembled artifact carry its history span as tagged
 *    contributions rather than the non-enumerable `HISTORY_TAG` marker on the message array.
 *  · 18e (public seams) reads `shaped` at the model-dispatch seam to shape exactly once — new
 *    workflows should NOT provider-shape before dispatch, so a pre-dispatch artifact stays
 *    `shaped: false` and the seam shapes it there.
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
  /** 18c hook (trim/budget policy): whether this contribution may be dropped under token pressure.
   *  Unset today — 18c assigns and honors it. */
  budgetClass?: 'pinned' | 'trimmable'
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
 * The messages are already provider-shaped, so each becomes a (non-synthetic) contribution and the
 * forensic record + sampler params ride along. `record` is omitted when absent (the unit-test path
 * that mocks `assemblePrompt` without one) so two assembled artifacts with the same inputs stay
 * deeply equal.
 */
export const assembledArtifact = (
  messages: ChatMessage[],
  params: PresetParameters,
  record?: ExecutionRecord
): PromptArtifact => ({
  kind: PROMPT_ARTIFACT_KIND,
  contributions: messages.map((m, i) => ({
    source: ASSEMBLED_SOURCE,
    role: m.role,
    content: m.content,
    order: i
  })),
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
