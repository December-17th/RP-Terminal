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
