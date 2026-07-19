import { useEffect, useMemo, useState } from 'react'
import type { AgentDefinition, NotificationPolicy } from '../../../../shared/agentRuntime'
import { useT } from '../../i18n'

type Draft = AgentDefinition
type Translate = (key: string, vars?: Record<string, string | number>) => string

interface FieldError {
  field: string
  message: string
}

/**
 * Field-level validation, so a failure lands on the responsible input rather than as one opaque
 * banner (Session 10: "Validate in the responsible field and prevent activation"). This is a
 * pre-flight check for the UI only — the authoritative parse still happens main-side in
 * `parseAgentDefinition`, and its errors are surfaced too.
 */
export const validateDraft = (draft: Draft): FieldError[] => {
  const errors: FieldError[] = []
  if (!draft.name?.trim()) errors.push({ field: 'name', message: 'required' })
  if (!draft.prompt.length) errors.push({ field: 'prompt', message: 'atLeastOneMessage' })
  draft.prompt.forEach((message, index) => {
    const text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
    if (!text.trim()) errors.push({ field: `prompt.${index}`, message: 'emptyMessage' })
  })
  if (draft.result.mode === 'json' && !draft.result.schema) {
    errors.push({ field: 'result.schema', message: 'schemaRequired' })
  }
  if (draft.result.mode !== 'tools-only' && draft.result.saveAs) {
    if (!draft.result.saveAs.startsWith('variables.__rpt.agent_results.')) {
      errors.push({ field: 'result.saveAs', message: 'slotPath' })
    }
  }
  const d = draft.defaults
  if (d.maxSteps < 1) errors.push({ field: 'defaults.maxSteps', message: 'atLeastOne' })
  if (d.maxRetryAttempts < 0) errors.push({ field: 'defaults.maxRetryAttempts', message: 'nonNegative' })
  if (d.retryDelayMs < 0) errors.push({ field: 'defaults.retryDelayMs', message: 'nonNegative' })
  if (d.toolResultMaxTokens < 1) {
    errors.push({ field: 'defaults.toolResultMaxTokens', message: 'atLeastOne' })
  }
  return errors
}

const JsonField = ({
  label,
  value,
  onChange,
  onError,
  rows = 8,
  t
}: {
  label: string
  value: unknown
  onChange: (parsed: unknown) => void
  onError: (message: string | null) => void
  rows?: number
  t: Translate
}): React.ReactElement => {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2))
  const [invalid, setInvalid] = useState(false)

  return (
    <label className="agent-field">
      <span>{label}</span>
      <textarea
        className={invalid ? 'agent-input--invalid' : ''}
        rows={rows}
        spellCheck={false}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          try {
            onChange(JSON.parse(event.target.value))
            setInvalid(false)
            onError(null)
          } catch {
            setInvalid(true)
            onError(`${label}: ${t('agents.editor.invalidJson')}`)
          }
        }}
      />
      {invalid ? <em className="agent-field__error">{t('agents.editor.invalidJson')}</em> : null}
    </label>
  )
}

/**
 * The full definition form: identity, prompt, result contract, tools, model, and execution defaults.
 * Prompt messages get a real repeating editor (add / remove / reorder / role); `tools` and
 * `inputSchema` are JSON fields because both are open-ended JSON Schema shapes with no fixed form.
 */
export function AgentEditor({
  definition,
  readOnly,
  onSave,
  onCancel,
  saving,
  serverError
}: {
  definition: AgentDefinition
  readOnly: boolean
  onSave: (next: AgentDefinition) => void
  onCancel: () => void
  saving: boolean
  serverError: string | null
}): React.ReactElement {
  const t = useT()
  const [draft, setDraft] = useState<Draft>(() => structuredClone(definition))
  const [jsonError, setJsonError] = useState<string | null>(null)

  useEffect(() => setDraft(structuredClone(definition)), [definition])

  const errors = useMemo(() => validateDraft(draft), [draft])
  const errorFor = (field: string): string | undefined =>
    errors.find((error) => error.field === field)?.message

  const patch = (next: Partial<Draft>): void => setDraft({ ...draft, ...next })
  const patchDefaults = (next: Partial<Draft['defaults']>): void =>
    setDraft({ ...draft, defaults: { ...draft.defaults, ...next } })

  const messageText = (index: number): string =>
    draft.prompt[index]!.content.map((part) => (part.type === 'text' ? part.text : '')).join('')

  const setMessageText = (index: number, text: string): void => {
    const prompt = draft.prompt.map((message, i) =>
      i === index ? { ...message, content: [{ type: 'text' as const, text }] } : message
    )
    patch({ prompt })
  }

  const moveMessage = (index: number, delta: number): void => {
    const target = index + delta
    if (target < 0 || target >= draft.prompt.length) return
    const prompt = [...draft.prompt]
    const [moved] = prompt.splice(index, 1)
    prompt.splice(target, 0, moved!)
    patch({ prompt })
  }

  const num = (field: string, label: string, value: number, apply: (n: number) => void): React.ReactElement => (
    <label className="agent-field agent-field--inline">
      <span>{label}</span>
      <input
        type="number"
        disabled={readOnly}
        className={errorFor(field) ? 'agent-input--invalid' : ''}
        value={value}
        onChange={(event) => apply(Number(event.target.value))}
      />
      {errorFor(field) ? (
        <em className="agent-field__error">{t(`agents.editor.err.${errorFor(field)}`)}</em>
      ) : null}
    </label>
  )

  const blocked = errors.length > 0 || jsonError !== null

  return (
    <div className="agent-editor">
      <section className="agent-editor__section">
        <h4>{t('agents.editor.identity')}</h4>
        <label className="agent-field">
          <span>{t('agents.editor.name')}</span>
          <input
            disabled={readOnly}
            className={errorFor('name') ? 'agent-input--invalid' : ''}
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
          />
          {errorFor('name') ? (
            <em className="agent-field__error">{t('agents.editor.err.required')}</em>
          ) : null}
        </label>
        <label className="agent-field">
          <span>{t('agents.editor.description')}</span>
          <textarea
            disabled={readOnly}
            rows={2}
            value={draft.description ?? ''}
            onChange={(event) => patch({ description: event.target.value })}
          />
        </label>
        <label className="agent-field">
          <span>{t('agents.editor.modelHint')}</span>
          <input
            disabled={readOnly}
            value={draft.modelHint ?? ''}
            placeholder={t('agents.editor.modelHintPlaceholder')}
            onChange={(event) => patch({ modelHint: event.target.value || undefined })}
          />
        </label>
      </section>

      <section className="agent-editor__section">
        <h4>
          {t('agents.editor.prompt')} <span className="agent-count">{draft.prompt.length}</span>
        </h4>
        {errorFor('prompt') ? (
          <em className="agent-field__error">{t('agents.editor.err.atLeastOneMessage')}</em>
        ) : null}
        {draft.prompt.map((message, index) => (
          <div className="agent-message" key={index}>
            <div className="agent-message__bar">
              <select
                disabled={readOnly}
                value={message.role}
                onChange={(event) =>
                  patch({
                    prompt: draft.prompt.map((m, i) =>
                      i === index ? { ...m, role: event.target.value as typeof m.role } : m
                    )
                  })
                }
              >
                <option value="system">{t('agents.editor.role.system')}</option>
                <option value="user">{t('agents.editor.role.user')}</option>
                <option value="assistant">{t('agents.editor.role.assistant')}</option>
              </select>
              <span className="agent-message__size">
                {t('agents.editor.chars', { count: messageText(index).length })}
              </span>
              <button type="button" disabled={readOnly || index === 0} onClick={() => moveMessage(index, -1)}>
                ↑
              </button>
              <button
                type="button"
                disabled={readOnly || index === draft.prompt.length - 1}
                onClick={() => moveMessage(index, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                disabled={readOnly}
                onClick={() => patch({ prompt: draft.prompt.filter((_, i) => i !== index) })}
              >
                {t('agents.editor.removeMessage')}
              </button>
            </div>
            <textarea
              disabled={readOnly}
              rows={6}
              spellCheck={false}
              className={errorFor(`prompt.${index}`) ? 'agent-input--invalid' : ''}
              value={messageText(index)}
              onChange={(event) => setMessageText(index, event.target.value)}
            />
            {errorFor(`prompt.${index}`) ? (
              <em className="agent-field__error">{t('agents.editor.err.emptyMessage')}</em>
            ) : null}
          </div>
        ))}
        <button
          type="button"
          disabled={readOnly}
          onClick={() =>
            patch({
              prompt: [...draft.prompt, { role: 'user', content: [{ type: 'text', text: '' }] }]
            })
          }
        >
          {t('agents.editor.addMessage')}
        </button>
      </section>

      <section className="agent-editor__section">
        <h4>{t('agents.editor.result')}</h4>
        <label className="agent-field agent-field--inline">
          <span>{t('agents.editor.resultMode')}</span>
          <select
            disabled={readOnly}
            value={draft.result.mode}
            onChange={(event) => {
              const mode = event.target.value as AgentDefinition['result']['mode']
              patch({
                result:
                  mode === 'json'
                    ? { mode, schema: { type: 'object' } }
                    : mode === 'text'
                      ? { mode }
                      : { mode }
              })
            }}
          >
            <option value="text">text</option>
            <option value="json">json</option>
            <option value="tools-only">tools-only</option>
          </select>
        </label>

        {draft.result.mode !== 'tools-only' ? (
          <label className="agent-field">
            <span>{t('agents.editor.saveAs')}</span>
            <input
              disabled={readOnly}
              className={errorFor('result.saveAs') ? 'agent-input--invalid' : ''}
              placeholder="variables.__rpt.agent_results.my_slot"
              value={draft.result.saveAs ?? ''}
              onChange={(event) =>
                patch({
                  result: {
                    ...draft.result,
                    saveAs: (event.target.value || undefined) as never
                  } as AgentDefinition['result']
                })
              }
            />
            {errorFor('result.saveAs') ? (
              <em className="agent-field__error">{t('agents.editor.err.slotPath')}</em>
            ) : null}
          </label>
        ) : null}

        {draft.result.mode === 'text' ? (
          <label className="agent-field agent-field--inline">
            <span>{t('agents.editor.validator')}</span>
            <select
              disabled={readOnly}
              value={draft.result.validator ?? ''}
              onChange={(event) =>
                patch({
                  result: {
                    mode: 'text',
                    ...(draft.result.mode === 'text' && draft.result.saveAs
                      ? { saveAs: draft.result.saveAs }
                      : {}),
                    ...(event.target.value ? { validator: 'yss' as const } : {})
                  }
                })
              }
            >
              <option value="">{t('agents.editor.validatorNone')}</option>
              <option value="yss">yss</option>
            </select>
          </label>
        ) : null}

        {draft.result.mode === 'json' ? (
          <JsonField
            t={t}
            label={t('agents.editor.resultSchema')}
            value={draft.result.schema}
            onError={setJsonError}
            onChange={(schema) =>
              patch({
                result: { ...draft.result, schema: schema as never } as AgentDefinition['result']
              })
            }
          />
        ) : null}
      </section>

      <section className="agent-editor__section">
        <h4>{t('agents.editor.contracts')}</h4>
        <JsonField
          t={t}
          label={t('agents.editor.inputSchema')}
          value={draft.inputSchema}
          onError={setJsonError}
          onChange={(inputSchema) => patch({ inputSchema: inputSchema as never })}
        />
        <JsonField
          t={t}
          label={t('agents.editor.tools', { count: draft.tools.length })}
          value={draft.tools}
          rows={6}
          onError={setJsonError}
          onChange={(tools) => patch({ tools: (Array.isArray(tools) ? tools : []) as never })}
        />
      </section>

      <section className="agent-editor__section">
        <h4>{t('agents.editor.defaults')}</h4>
        <div className="agent-field-grid">
          {num('defaults.maxSteps', t('agents.editor.maxSteps'), draft.defaults.maxSteps, (n) =>
            patchDefaults({ maxSteps: n })
          )}
          {num(
            'defaults.maxRetryAttempts',
            t('agents.editor.maxRetryAttempts'),
            draft.defaults.maxRetryAttempts,
            (n) => patchDefaults({ maxRetryAttempts: n })
          )}
          {num(
            'defaults.retryDelayMs',
            t('agents.editor.retryDelayMs'),
            draft.defaults.retryDelayMs,
            (n) => patchDefaults({ retryDelayMs: n })
          )}
          {num(
            'defaults.toolResultMaxTokens',
            t('agents.editor.toolResultMaxTokens'),
            draft.defaults.toolResultMaxTokens,
            (n) => patchDefaults({ toolResultMaxTokens: n })
          )}
        </div>
        <label className="agent-field agent-field--check">
          <input
            type="checkbox"
            disabled={readOnly}
            checked={draft.defaults.required}
            onChange={(event) => patchDefaults({ required: event.target.checked })}
          />
          <span>{t('agents.editor.required')}</span>
        </label>
        <label className="agent-field agent-field--check">
          <input
            type="checkbox"
            disabled={readOnly}
            checked={draft.defaults.blocksNextTurn}
            onChange={(event) => patchDefaults({ blocksNextTurn: event.target.checked })}
          />
          <span>{t('agents.editor.blocksNextTurn')}</span>
        </label>
        {draft.defaults.blocksNextTurn ? (
          <p className="agent-editor__note">{t('agents.editor.blocksNextTurnInert')}</p>
        ) : null}
        <label className="agent-field agent-field--inline">
          <span>{t('agents.editor.notification')}</span>
          <select
            disabled={readOnly}
            value={draft.defaults.notification}
            onChange={(event) =>
              patchDefaults({ notification: event.target.value as NotificationPolicy })
            }
          >
            <option value="none">none</option>
            <option value="failure">failure</option>
            <option value="completion">completion</option>
          </select>
        </label>
      </section>

      {serverError ? (
        <p className="agents-panel__error" role="alert">
          {serverError}
        </p>
      ) : null}
      {jsonError ? (
        <p className="agents-panel__error" role="alert">
          {jsonError}
        </p>
      ) : null}

      <div className="agent-editor__actions">
        <button type="button" onClick={onCancel} disabled={saving}>
          {t('agents.editor.cancel')}
        </button>
        <button
          type="button"
          className="agent-editor__save"
          disabled={readOnly || saving || blocked}
          title={blocked ? t('agents.editor.fixErrors') : undefined}
          onClick={() => onSave(draft)}
        >
          {saving ? t('agents.editor.saving') : t('agents.editor.save')}
        </button>
      </div>
    </div>
  )
}
