import { useMemo, useState } from 'react'
import type { JsonObject, JsonSchema, JsonValue } from '../../../../shared/agentRuntime'
import { useT } from '../../i18n'

type SchemaFieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'json'

export interface AgentInputField {
  key: string
  label: string
  description?: string
  kind: SchemaFieldKind
  required: boolean
  choices?: JsonValue[]
  placeholder?: string
}

const objectValue = (value: JsonValue | undefined): JsonObject | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : null

/** The manual-run editor supports the useful top-level JSON Schema subset without pretending that
 * arbitrary schemas are simple forms. Unsupported properties remain editable as JSON values. */
export const agentInputFields = (schema: JsonSchema): AgentInputField[] => {
  const properties = objectValue(schema.properties)
  if (!properties) return []
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === 'string')
      : []
  )

  return Object.entries(properties).flatMap(([key, value]) => {
    const property = objectValue(value)
    if (!property) return []
    const type = property.type
    const kind: SchemaFieldKind =
      type === 'string' || type === 'number' || type === 'integer' || type === 'boolean'
        ? type
        : 'json'
    return [
      {
        key,
        label: typeof property.title === 'string' ? property.title : key,
        ...(typeof property.description === 'string' ? { description: property.description } : {}),
        kind,
        required: required.has(key),
        ...(Array.isArray(property.enum) ? { choices: property.enum } : {}),
        ...(typeof property.default === 'string' || typeof property.default === 'number'
          ? { placeholder: String(property.default) }
          : {})
      }
    ]
  })
}

export const defaultAgentInput = (schema: JsonSchema): JsonObject => {
  const properties = objectValue(schema.properties)
  if (!properties) return {}
  return Object.fromEntries(
    Object.entries(properties).flatMap(([key, value]) => {
      const property = objectValue(value)
      return property && 'default' in property ? [[key, property.default]] : []
    })
  ) as JsonObject
}

const parseObject = (text: string): JsonObject | null => {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null
  } catch {
    return null
  }
}

function JsonValueInput({
  value,
  onChange
}: {
  value: JsonValue | undefined
  onChange: (value: JsonValue | undefined) => void
}): React.ReactElement {
  const [text, setText] = useState(() =>
    value === undefined ? '' : JSON.stringify(value, null, 2)
  )
  return (
    <textarea
      rows={3}
      spellCheck={false}
      value={text}
      onChange={(event) => {
        const next = event.target.value
        setText(next)
        if (!next.trim()) return onChange(undefined)
        try {
          onChange(JSON.parse(next) as JsonValue)
        } catch {
          // Keep partial JSON locally until it becomes valid.
        }
      }}
    />
  )
}

export function AgentManualRunForm({
  inputSchema,
  initialInput,
  disabled,
  previewing = false,
  hasChat,
  onRun,
  onPreview
}: {
  inputSchema: JsonSchema
  initialInput?: JsonObject
  disabled: boolean
  previewing?: boolean
  hasChat: boolean
  onRun: (input: JsonObject) => void
  onPreview?: (input: JsonObject) => void
}): React.ReactElement {
  const t = useT()
  const fields = useMemo(() => agentInputFields(inputSchema), [inputSchema])
  const [input, setInput] = useState<JsonObject>(() =>
    structuredClone(initialInput ?? defaultAgentInput(inputSchema))
  )
  const [raw, setRaw] = useState(() =>
    JSON.stringify(initialInput ?? defaultAgentInput(inputSchema), null, 2)
  )
  const [rawError, setRawError] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const update = (key: string, value: JsonValue | undefined): void => {
    const next = { ...input }
    if (value === undefined) delete next[key]
    else next[key] = value
    setInput(next)
    setRaw(JSON.stringify(next, null, 2))
    setRawError(false)
    setFormError(null)
  }

  const submit = (action: (input: JsonObject) => void): void => {
    const parsed = parseObject(raw)
    if (!parsed) {
      setRawError(true)
      return
    }
    const missing = fields.filter((field) => field.required && parsed[field.key] === undefined)
    if (missing.length) {
      setFormError(
        t('agents.run.missingRequired', { fields: missing.map((field) => field.label).join(', ') })
      )
      return
    }
    setFormError(null)
    action(parsed)
  }

  return (
    <div className="agent-runs__manual">
      <h4>{t('agents.run.manual')}</h4>
      <p className="agents-panel__hint">{t('agents.run.manualHint')}</p>

      {fields.length === 0 ? (
        <p className="agent-runs__no-input">{t('agents.run.noInput')}</p>
      ) : (
        <div className="agent-runs__input-fields">
          {fields.map((field) => {
            const value = input[field.key]
            return (
              <label className="agent-field" key={field.key}>
                <span>
                  {field.label}
                  {field.required ? ` ${t('agents.run.requiredField')}` : ''}
                </span>
                {field.choices ? (
                  <select
                    value={value === undefined ? '' : JSON.stringify(value)}
                    onChange={(event) =>
                      update(
                        field.key,
                        event.target.value
                          ? (JSON.parse(event.target.value) as JsonValue)
                          : undefined
                      )
                    }
                  >
                    <option value="" disabled={field.required}>
                      {field.required ? t('agents.run.selectValue') : t('agents.run.notSet')}
                    </option>
                    {field.choices.map((choice) => (
                      <option key={JSON.stringify(choice)} value={JSON.stringify(choice)}>
                        {String(choice)}
                      </option>
                    ))}
                  </select>
                ) : field.kind === 'boolean' ? (
                  <select
                    value={value === undefined ? '' : String(value)}
                    onChange={(event) =>
                      update(
                        field.key,
                        event.target.value === '' ? undefined : event.target.value === 'true'
                      )
                    }
                  >
                    <option value="" disabled={field.required}>
                      {field.required ? t('agents.run.selectValue') : t('agents.run.notSet')}
                    </option>
                    <option value="true">{t('agents.run.yes')}</option>
                    <option value="false">{t('agents.run.no')}</option>
                  </select>
                ) : field.kind === 'json' ? (
                  <JsonValueInput value={value} onChange={(next) => update(field.key, next)} />
                ) : (
                  <input
                    type={field.kind === 'string' ? 'text' : 'number'}
                    step={field.kind === 'integer' ? 1 : undefined}
                    required={field.required}
                    value={typeof value === 'string' || typeof value === 'number' ? value : ''}
                    placeholder={field.placeholder}
                    onChange={(event) =>
                      update(
                        field.key,
                        event.target.value === ''
                          ? undefined
                          : field.kind === 'string'
                            ? event.target.value
                            : Number(event.target.value)
                      )
                    }
                  />
                )}
                {field.description ? <small>{field.description}</small> : null}
              </label>
            )
          })}
        </div>
      )}

      <details className="agent-runs__advanced">
        <summary>{t('agents.run.advanced')}</summary>
        <label className="agent-field">
          <span>{t('agents.run.rawInput')}</span>
          <textarea
            rows={6}
            spellCheck={false}
            className={rawError ? 'agent-input--invalid' : ''}
            value={raw}
            onChange={(event) => {
              const nextRaw = event.target.value
              setRaw(nextRaw)
              const parsed = parseObject(nextRaw)
              setRawError(parsed === null)
              if (parsed) setInput(parsed)
              if (parsed) setFormError(null)
            }}
          />
          {rawError ? (
            <em className="agent-field__error">{t('agents.run.objectInputRequired')}</em>
          ) : null}
        </label>
      </details>

      {formError ? (
        <p className="agent-field__error" role="alert">
          {formError}
        </p>
      ) : null}

      <div className="agent-runs__manual-actions">
        <button
          type="button"
          disabled={disabled || !hasChat || rawError}
          onClick={() => submit(onRun)}
        >
          {disabled ? t('agents.run.running') : t('agents.run.runNow')}
        </button>
        {onPreview ? (
          <button
            type="button"
            className="btn-ghost"
            disabled={previewing || !hasChat || rawError}
            title={hasChat ? t('agents.run.previewHint') : t('agents.run.needsChat')}
            onClick={() => submit(onPreview)}
          >
            {previewing ? t('agents.run.previewing') : t('agents.run.preview')}
          </button>
        ) : null}
      </div>
      {hasChat ? null : <p className="agents-panel__hint">{t('agents.run.needsChat')}</p>}
    </div>
  )
}
