# Editable Variables View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Variables view's `stat_data` and session-KV sections editable via a collapsible JSON tree (insert / modify / delete), persisting each edit immediately.

**Architecture:** A pure `applyEdit` helper turns a tree edit into `{ next, op }` (immutably-updated value + an RFC-6902 op). A recursive `JsonTreeEditor` component renders collapsible nodes with edit affordances and calls `applyEdit`. `VariablesView` wires two editors: `stat_data` persists via `chatStore.applyVariableOps` (which sends the op through `applyVariableOps` → `applyJsonPatch` on the latest floor); session KV persists the whole updated object via `chatCardVarsSet`. Renderer-only.

**Tech Stack:** React 19, Zustand, TypeScript, Vitest.

## Global Constraints

- Verification gate (run before declaring a task done): `npm run typecheck && npm run check:deps && npm run test`. Tasks 2 and 3 also run `npm run build` (renderer change).
- **Renderer-only.** No main-process change. Reuse the existing `chatStore.applyVariableOps` action and `window.api.chatCardVarsSet` — do NOT add IPC. `npm run check:deps` must stay green (no renderer→main-internal import).
- **i18n:** every user-facing string via `t('key')`, with the key added to BOTH `src/renderer/src/i18n/locales/en.ts` and `locales/zh.ts`.
- **Editable layers:** `stat_data` + session KV only. The floor-variables blob stays **read-only**. No editing of the derived blob.
- **Persist immediately** per edit. No staged Save/Revert, no undo/history, no schema validation beyond the type selector, no key/item reordering (all non-goals).
- **Op vocabulary:** only `add` (insert key / append array item via the `/-` token), `replace` (modify), `remove` (delete) — matching `applyVariableOps`/`applyJsonPatch`.

**Verified interfaces (already exist):**
- `chatStore.applyVariableOps(profileId: string, ops: VarOp[], floor?: number): Promise<void>` — defaults to the latest floor, calls `window.api.applyVariableOps`, updates `chatStore.floors` on success ([chatStore.ts:178](../../../src/renderer/src/stores/chatStore.ts)). `VarOp = { op: string; path: string; value?: unknown; from?: string }` ([chatStore.ts:35](../../../src/renderer/src/stores/chatStore.ts)).
- `window.api.chatCardVarsSet(profileId, chatId, vars)` + `chatCardVarsGet` ([preload/index.ts:347-350](../../../src/preload/index.ts)).
- The current `VariablesView` renders 3 sections from `useChatStore(s => s.floors)` last-floor variables + a `chatCardVarsGet` fetch ([VariablesView.tsx](../../../src/renderer/src/components/workspace/VariablesView.tsx)).

---

## File Structure

- **Create** `src/renderer/src/components/workspace/jsonTreeEdit.ts` — pure `applyEdit` + `toPointer` + types (`EditOp`, `EditAction`). One responsibility: turn a tree edit into `{ next, op }`.
- **Create** `src/renderer/src/components/workspace/JsonTreeEditor.tsx` — the recursive collapsible tree component.
- **Modify** `src/renderer/src/components/workspace/VariablesView.tsx` — wire two editors + keep the floor blob read-only.
- **Modify** `src/renderer/src/i18n/locales/en.ts` + `locales/zh.ts` — new keys.
- **Test** `test/jsonTreeEdit.test.ts` — `applyEdit`/`toPointer` unit tests.

---

## Task 1: Pure `applyEdit` helper (TDD)

**Files:**
- Create: `src/renderer/src/components/workspace/jsonTreeEdit.ts`
- Test: `test/jsonTreeEdit.test.ts`

**Interfaces:**
- Produces: `type EditOp = { op: 'add' | 'replace' | 'remove'; path: string; value?: unknown }`; `type EditAction = 'replace' | 'insertKey' | 'appendItem' | 'delete'`; `toPointer(segs: Array<string | number>): string`; `applyEdit(root: unknown, segs: Array<string | number>, action: EditAction, payload?: { key?: string; value?: unknown }): { next: unknown; op: EditOp }`.

- [ ] **Step 1: Write the failing test**

Create `test/jsonTreeEdit.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { applyEdit, toPointer } from '../src/renderer/src/components/workspace/jsonTreeEdit'

describe('toPointer', () => {
  it('builds a JSON pointer and escapes ~ and /', () => {
    expect(toPointer(['a', 'b/c', 'd~e'])).toBe('/a/b~1c/d~0e')
    expect(toPointer([])).toBe('')
  })
})

describe('applyEdit', () => {
  it('replace a scalar → replace op + updated value', () => {
    const { next, op } = applyEdit({ 主角: { hp: 100 } }, ['主角', 'hp'], 'replace', { value: 120 })
    expect(next).toEqual({ 主角: { hp: 120 } })
    expect(op).toEqual({ op: 'replace', path: '/主角/hp', value: 120 })
  })
  it('insertKey into an object → add op at /obj/key', () => {
    const { next, op } = applyEdit({ a: {} }, ['a'], 'insertKey', { key: 'k', value: 1 })
    expect(next).toEqual({ a: { k: 1 } })
    expect(op).toEqual({ op: 'add', path: '/a/k', value: 1 })
  })
  it('insertKey at root (empty segs)', () => {
    const { next, op } = applyEdit({}, [], 'insertKey', { key: 'x', value: true })
    expect(next).toEqual({ x: true })
    expect(op).toEqual({ op: 'add', path: '/x', value: true })
  })
  it('appendItem to an array → add op with the /- token', () => {
    const { next, op } = applyEdit({ list: [1] }, ['list'], 'appendItem', { value: 2 })
    expect(next).toEqual({ list: [1, 2] })
    expect(op).toEqual({ op: 'add', path: '/list/-', value: 2 })
  })
  it('delete an object key → remove op', () => {
    const { next, op } = applyEdit({ a: 1, b: 2 }, ['b'], 'delete')
    expect(next).toEqual({ a: 1 })
    expect(op).toEqual({ op: 'remove', path: '/b' })
  })
  it('delete an array index → splice + remove op', () => {
    const { next, op } = applyEdit({ list: [1, 2, 3] }, ['list', 1], 'delete')
    expect(next).toEqual({ list: [1, 3] })
    expect(op).toEqual({ op: 'remove', path: '/list/1' })
  })
  it('does not mutate the input root', () => {
    const root = { a: 1 }
    applyEdit(root, ['a'], 'replace', { value: 2 })
    expect(root).toEqual({ a: 1 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jsonTreeEdit.test.ts`
Expected: FAIL — module `jsonTreeEdit` does not exist.

- [ ] **Step 3: Implement the helper**

Create `src/renderer/src/components/workspace/jsonTreeEdit.ts`:

```ts
// Pure tree-edit helper for the Variables editor: given the root value, the JSON-Pointer segments to
// an edit site, an action, and a payload, return the immutably-updated root AND the RFC-6902 op that
// describes the change. The op feeds applyVariableOps (stat_data); `next` feeds chatCardVarsSet (KV).

export type EditOp = { op: 'add' | 'replace' | 'remove'; path: string; value?: unknown }
export type EditAction = 'replace' | 'insertKey' | 'appendItem' | 'delete'

const esc = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1')

/** JSON Pointer (RFC-6901) from path segments; [] → '' (whole document root). */
export const toPointer = (segs: Array<string | number>): string =>
  segs.map((s) => '/' + esc(String(s))).join('')

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))

const containerAt = (root: any, segs: Array<string | number>): any => {
  let cur = root
  for (const s of segs) cur = cur[s]
  return cur
}

export const applyEdit = (
  root: unknown,
  segs: Array<string | number>,
  action: EditAction,
  payload: { key?: string; value?: unknown } = {}
): { next: unknown; op: EditOp } => {
  const next = clone(root) as any

  if (action === 'insertKey') {
    const key = String(payload.key)
    containerAt(next, segs)[key] = payload.value
    return { next, op: { op: 'add', path: toPointer([...segs, key]), value: payload.value } }
  }
  if (action === 'appendItem') {
    ;(containerAt(next, segs) as unknown[]).push(payload.value)
    return { next, op: { op: 'add', path: toPointer([...segs, '-']), value: payload.value } }
  }

  // replace / delete operate on the node AT segs (parent = segs[0..-1], last = segs[-1]).
  const parent = containerAt(next, segs.slice(0, -1))
  const last = segs[segs.length - 1]
  if (action === 'replace') {
    parent[last] = payload.value
    return { next, op: { op: 'replace', path: toPointer(segs), value: payload.value } }
  }
  // delete
  if (Array.isArray(parent)) parent.splice(Number(last), 1)
  else delete parent[last]
  return { next, op: { op: 'remove', path: toPointer(segs) } }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/jsonTreeEdit.test.ts`
Expected: PASS (8 assertions across 8 tests).

- [ ] **Step 5: Verify the gate**

Run: `npm run typecheck && npm run check:deps && npx vitest run test/jsonTreeEdit.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/workspace/jsonTreeEdit.ts test/jsonTreeEdit.test.ts
git commit -m "feat(vars): pure applyEdit helper (tree edit → {next, JSONPatch op})"
```

---

## Task 2: `JsonTreeEditor` component

**Files:**
- Create: `src/renderer/src/components/workspace/JsonTreeEditor.tsx`

**Interfaces:**
- Consumes: `applyEdit`, `EditOp`, `EditAction` (Task 1).
- Produces: `JsonTreeEditor: React.FC<{ value: unknown; onEdit: (next: unknown, op: EditOp) => void; readOnly?: boolean }>`.

No new unit test (a React component); the pure edit logic is covered by Task 1. Gate is `typecheck + build`.

- [ ] **Step 1: Implement the component**

Create `src/renderer/src/components/workspace/JsonTreeEditor.tsx`:

```tsx
// Recursive, collapsible JSON tree editor. Each container node collapses; scalars edit inline with a
// type selector; objects get "+ key", arrays get "+ item", every non-root node gets a delete (✕).
// Every edit flows through applyEdit(rootValue, …) → onEdit(next, op). Pure display otherwise.
import React, { useState } from 'react'
import { useT } from '../../i18n'
import { applyEdit, type EditOp, type EditAction } from './jsonTreeEdit'

type Emit = (
  segs: Array<string | number>,
  action: EditAction,
  payload?: { key?: string; value?: unknown }
) => void
type JsonType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'

const typeOf = (v: unknown): JsonType =>
  v === null
    ? 'null'
    : Array.isArray(v)
      ? 'array'
      : typeof v === 'object'
        ? 'object'
        : (typeof v as 'string' | 'number' | 'boolean')

const initialFor = (t: JsonType): unknown =>
  t === 'string' ? '' : t === 'number' ? 0 : t === 'boolean' ? false : t === 'null' ? null : t === 'array' ? [] : {}

const coerce = (raw: string, t: JsonType): unknown => {
  if (t === 'number') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : 0
  }
  if (t === 'boolean') return raw === 'true'
  if (t === 'null') return null
  return raw
}

const AddRow: React.FC<{ isArray: boolean; onAdd: (key: string | undefined, t: JsonType) => void }> = ({
  isArray,
  onAdd
}) => {
  const t = useT()
  const [key, setKey] = useState('')
  const [type, setType] = useState<JsonType>('string')
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', margin: '2px 0 2px 20px' }}>
      {!isArray && (
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={t('variables.keyName')}
          style={{ width: 110, fontSize: 12 }}
        />
      )}
      <select value={type} onChange={(e) => setType(e.target.value as JsonType)} style={{ fontSize: 12 }}>
        {(['string', 'number', 'boolean', 'null', 'object', 'array'] as JsonType[]).map((ty) => (
          <option key={ty} value={ty}>
            {ty}
          </option>
        ))}
      </select>
      <button
        className="rpt-duel-secondary"
        style={{ fontSize: 11, padding: '1px 6px' }}
        disabled={!isArray && !key.trim()}
        onClick={() => {
          onAdd(isArray ? undefined : key.trim(), type)
          setKey('')
        }}
      >
        {isArray ? t('variables.addItem') : t('variables.addKey')}
      </button>
    </div>
  )
}

const ScalarEditor: React.FC<{ value: unknown; onCommit: (v: unknown) => void }> = ({ value, onCommit }) => {
  const [type, setType] = useState<JsonType>(typeOf(value))
  const [raw, setRaw] = useState(value === null ? '' : String(value))
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      {type !== 'null' && (
        <input
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onBlur={() => onCommit(coerce(raw, type))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          style={{ fontSize: 12, minWidth: 60 }}
        />
      )}
      <select
        value={type}
        onChange={(e) => {
          const ty = e.target.value as JsonType
          setType(ty)
          onCommit(coerce(raw, ty))
        }}
        style={{ fontSize: 11 }}
      >
        {(['string', 'number', 'boolean', 'null'] as JsonType[]).map((ty) => (
          <option key={ty} value={ty}>
            {ty}
          </option>
        ))}
      </select>
    </span>
  )
}

const Node: React.FC<{
  label: string | number | null
  value: unknown
  segs: Array<string | number>
  emit: Emit
  readOnly: boolean
  isRoot?: boolean
}> = ({ label, value, segs, emit, readOnly, isRoot }) => {
  const t = useT()
  const [collapsed, setCollapsed] = useState(false)
  const kind = typeOf(value)
  const isContainer = kind === 'object' || kind === 'array'
  const entries: Array<[string | number, unknown]> =
    kind === 'array'
      ? (value as unknown[]).map((v, i) => [i, v])
      : kind === 'object'
        ? Object.entries(value as Record<string, unknown>)
        : []

  return (
    <div style={{ marginLeft: isRoot ? 0 : 12 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, lineHeight: 1.8 }}>
        {isContainer ? (
          <button
            onClick={() => setCollapsed((c) => !c)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--rpt-text-secondary)',
              padding: 0,
              width: 14
            }}
          >
            {collapsed ? '▸' : '▾'}
          </button>
        ) : (
          <span style={{ width: 14 }} />
        )}
        {label !== null && <span style={{ color: 'var(--rpt-accent)' }}>{String(label)}:</span>}
        {isContainer ? (
          <span style={{ color: 'var(--rpt-text-secondary)' }}>
            {kind === 'array' ? `[${entries.length}]` : `{${entries.length}}`}
          </span>
        ) : readOnly ? (
          <span>{value === null ? 'null' : String(value)}</span>
        ) : (
          <ScalarEditor value={value} onCommit={(v) => emit(segs, 'replace', { value: v })} />
        )}
        {!readOnly && !isRoot && (
          <button
            className="rpt-duel-secondary"
            title={t('variables.delete')}
            style={{ fontSize: 11, padding: '0 5px' }}
            onClick={() => emit(segs, 'delete')}
          >
            ✕
          </button>
        )}
      </div>
      {isContainer && !collapsed && (
        <div>
          {entries.map(([k, v]) => (
            <Node key={String(k)} label={k} value={v} segs={[...segs, k]} emit={emit} readOnly={readOnly} />
          ))}
          {!readOnly && (
            <AddRow
              isArray={kind === 'array'}
              onAdd={(key, ty) =>
                emit(segs, kind === 'array' ? 'appendItem' : 'insertKey', { key, value: initialFor(ty) })
              }
            />
          )}
        </div>
      )}
    </div>
  )
}

export const JsonTreeEditor: React.FC<{
  value: unknown
  onEdit: (next: unknown, op: EditOp) => void
  readOnly?: boolean
}> = ({ value, onEdit, readOnly }) => {
  const emit: Emit = (segs, action, payload) => {
    const { next, op } = applyEdit(value, segs, action, payload)
    onEdit(next, op)
  }
  return <Node label={null} value={value} segs={[]} emit={emit} readOnly={!!readOnly} isRoot />
}
```

- [ ] **Step 2: Verify the gate + build**

Run: `npm run typecheck && npm run check:deps && npm run build`
Expected: all PASS (the component compiles; no dependency violations).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/workspace/JsonTreeEditor.tsx
git commit -m "feat(vars): collapsible JsonTreeEditor (insert/modify/delete + type selector)"
```

---

## Task 3: Wire editors into `VariablesView` + i18n

**Files:**
- Modify: `src/renderer/src/components/workspace/VariablesView.tsx`
- Modify: `src/renderer/src/i18n/locales/en.ts`, `src/renderer/src/i18n/locales/zh.ts`

**Interfaces:**
- Consumes: `JsonTreeEditor` (Task 2); `EditOp` (Task 1); `chatStore.applyVariableOps`; `window.api.chatCardVarsSet`.

- [ ] **Step 1: Add i18n keys (both locales)**

In `src/renderer/src/i18n/locales/en.ts`, immediately after `'variables.copied': ...`:

```ts
  'variables.keyName': 'key',
  'variables.addKey': '+ key',
  'variables.addItem': '+ item',
  'variables.delete': 'Delete',
  'variables.editFailed': 'Edit failed to save',
  'variables.readOnlyHint': 'No message yet — nothing to edit',
```

In `src/renderer/src/i18n/locales/zh.ts`, immediately after `'variables.copied': ...`:

```ts
  'variables.keyName': '键名',
  'variables.addKey': '+ 键',
  'variables.addItem': '+ 项',
  'variables.delete': '删除',
  'variables.editFailed': '编辑保存失败',
  'variables.readOnlyHint': '尚无消息 —— 暂无可编辑内容',
```

- [ ] **Step 2: Rewrite `VariablesView` to use the editor**

Replace the entire contents of `src/renderer/src/components/workspace/VariablesView.tsx` with:

```tsx
import React from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { useT } from '../../i18n'
import { JsonTreeEditor } from './JsonTreeEditor'
import type { EditOp } from './jsonTreeEdit'

/**
 * Variable inspector + editor for the active chat. Three collapsible sections:
 *  - MVU stat_data (editable → persisted via chatStore.applyVariableOps / applyJsonPatch on the latest floor),
 *  - the full floor variables blob (read-only; derived snapshot),
 *  - the per-chat card KV / "session KV" (editable → persisted whole via chat-card-vars-set).
 * Edits persist immediately. Chat-scoped; refetched when the active chat changes.
 */
const api = (): any => (window as unknown as { api: any }).api

const Section: React.FC<{
  title: string
  value: unknown
  empty: string
  children: React.ReactNode
}> = ({ title, value, empty, children }) => {
  const t = useT()
  const isEmpty =
    value == null || (typeof value === 'object' && Object.keys(value as object).length === 0)
  return (
    <details open style={{ marginBottom: 12 }}>
      <summary
        style={{
          cursor: 'pointer',
          fontWeight: 600,
          fontSize: 13,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8
        }}
      >
        <span>{title}</span>
        {!isEmpty ? (
          <button
            className="rpt-duel-secondary"
            style={{ fontSize: 11, padding: '2px 6px' }}
            onClick={(e) => {
              e.preventDefault()
              void navigator.clipboard?.writeText(JSON.stringify(value, null, 2))
              useToastStore.getState().push(t('variables.copied'))
            }}
          >
            {t('variables.copy')}
          </button>
        ) : null}
      </summary>
      <div style={{ marginTop: 6 }}>
        {isEmpty ? (
          <div style={{ opacity: 0.5, fontSize: 12, padding: '2px' }}>
            <em>{empty}</em>
          </div>
        ) : (
          children
        )}
      </div>
    </details>
  )
}

export const VariablesView: React.FC<{ profileId: string }> = ({ profileId }) => {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const floors = useChatStore((s) => s.floors)
  const t = useT()
  const [cardKv, setCardKv] = React.useState<Record<string, unknown> | null>(null)

  const loadKv = React.useCallback(async () => {
    if (!activeChatId) {
      setCardKv(null)
      return
    }
    try {
      setCardKv((await api().chatCardVarsGet(profileId, activeChatId)) ?? {})
    } catch {
      setCardKv({})
    }
  }, [profileId, activeChatId])

  React.useEffect(() => {
    void loadKv()
  }, [loadKv, floors.length])

  if (!activeChatId) {
    return <div style={{ opacity: 0.5 }}>{t('status.waiting')}</div>
  }

  const latest = floors.length ? floors[floors.length - 1]?.variables : undefined
  const statData = (latest as Record<string, unknown> | undefined)?.stat_data
  const hasFloor = floors.length > 0

  const onStatEdit = async (_next: unknown, op: EditOp): Promise<void> => {
    try {
      await useChatStore.getState().applyVariableOps(profileId, [op])
    } catch {
      useToastStore.getState().push(t('variables.editFailed'))
    }
  }

  const onKvEdit = async (next: unknown): Promise<void> => {
    setCardKv(next as Record<string, unknown>)
    try {
      await api().chatCardVarsSet(profileId, activeChatId, next)
    } catch {
      useToastStore.getState().push(t('variables.editFailed'))
      void loadKv()
    }
  }

  return (
    <div>
      <h3
        style={{
          borderBottom: '1px solid var(--rpt-border)',
          paddingBottom: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8
        }}
      >
        {t('variables.heading')}
        <button
          className="btn-accent"
          style={{ fontSize: '0.62em', padding: '3px 8px', fontWeight: 400 }}
          onClick={() => void loadKv()}
        >
          {t('variables.refresh')}
        </button>
      </h3>
      <div style={{ marginTop: 16 }}>
        <Section title={t('variables.mvuState')} value={statData} empty={t('variables.empty')}>
          <JsonTreeEditor value={statData ?? {}} onEdit={onStatEdit} readOnly={!hasFloor} />
          {!hasFloor ? (
            <div style={{ opacity: 0.5, fontSize: 12 }}>
              <em>{t('variables.readOnlyHint')}</em>
            </div>
          ) : null}
        </Section>
        <Section title={t('variables.floorVars')} value={latest} empty={t('variables.empty')}>
          <JsonTreeEditor value={latest} onEdit={() => {}} readOnly />
        </Section>
        <Section title={t('variables.sessionKv')} value={cardKv} empty={t('variables.empty')}>
          <JsonTreeEditor value={cardKv ?? {}} onEdit={onKvEdit} />
        </Section>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Verify the gate + build**

Run: `npm run typecheck && npm run check:deps && npm run test && npm run build`
Expected: all PASS (854 + 8 new = 862 tests; no dependency violations; renderer builds).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/workspace/VariablesView.tsx src/renderer/src/i18n/locales/en.ts src/renderer/src/i18n/locales/zh.ts
git commit -m "feat(vars): editable stat_data + session KV in the Variables view"
```

---

## Self-Review

**1. Spec coverage:**
- §2 `JsonTreeEditor` (collapsible, scalar+type, +key/+item, delete, emits `{next, op}`) → Task 2. ✓
- §2 pure `applyEdit` helper + tests → Task 1. ✓
- §3 wiring: stat_data → `applyVariableOps`; session KV → `chatCardVarsSet`; floor blob read-only; no-floor hint; toast on failure → Task 3. ✓
- §4 renderer-only / reuse IPCs / check:deps clean → Global Constraints + every task's gate. ✓
- §4 i18n both locales → Task 3 Step 1. ✓
- §4 non-goals (no floor-blob edit, no undo, no validation, no reorder) → not implemented; floor blob is `readOnly`. ✓

**2. Placeholder scan:** No TBD/TODO; complete code in every code step; exact commands + expected output.

**3. Type consistency:** `EditOp`/`EditAction`/`applyEdit`/`toPointer` defined in Task 1, consumed unchanged in Tasks 2–3. `JsonTreeEditor` prop `onEdit: (next: unknown, op: EditOp) => void` is identical in Task 2 (definition) and Task 3 (`onStatEdit`/`onKvEdit` match it — `onStatEdit` ignores `next`, `onKvEdit` ignores `op`, both valid). `EditOp` is structurally assignable to `VarOp[]` element (`op: 'add'|'replace'|'remove'` ⊂ `op: string`; `path: string`; `value?: unknown`) so `applyVariableOps(profileId, [op])` type-checks.
