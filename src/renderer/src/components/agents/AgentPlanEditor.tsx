import { useMemo, useState } from 'react'
import type { AgentCatalogSummary, InvocationPlan } from '../../../../shared/agentRuntime'
import { parseInvocationPlan } from '../../../../shared/agentRuntime'
import { useT } from '../../i18n'

/**
 * Restrictive Invocation Plan authoring (design §1, Session 10).
 *
 * A plan is an ORDERED SEQUENCE of steps, where a step is either one call or one FLAT parallel
 * group. There is no nesting, no conditional, no loop, and no plan-to-plan call — a parallel group
 * cannot contain another group, and the editor offers no control that could build one.
 *
 * Plans are NOT persisted as runtime objects: this surface authors JSON that a card passes to
 * `rpt.agents.runPlan`. Import/export is therefore the only lifecycle.
 */
type Step = InvocationPlan['steps'][number]

const isGroup = (step: Step): step is { parallel: Array<{ agent: string }> } =>
  typeof step === 'object' && step !== null && 'parallel' in step

export function AgentPlanEditor({
  agents
}: {
  agents: AgentCatalogSummary[]
}): React.ReactElement {
  const t = useT()
  const [plan, setPlan] = useState<InvocationPlan>({ steps: [] })
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState<string | null>(null)

  const names = useMemo(() => agents.map((agent) => agent.name), [agents])
  const first = names[0] ?? ''

  // Duplicate-agent check: the same Agent may run at most once per floor, so a plan naming one
  // twice is invalid (design §12). Surfaced here rather than only at runtime.
  const duplicates = useMemo(() => {
    const seen = new Set<string>()
    const dupes = new Set<string>()
    for (const step of plan.steps) {
      const calls = isGroup(step) ? step.parallel : [step as { agent: string }]
      for (const call of calls) {
        if (seen.has(call.agent)) dupes.add(call.agent)
        seen.add(call.agent)
      }
    }
    return [...dupes]
  }, [plan])

  const setSteps = (steps: Step[]): void => setPlan({ ...plan, steps })

  const move = (index: number, delta: number): void => {
    const target = index + delta
    if (target < 0 || target >= plan.steps.length) return
    const steps = [...plan.steps]
    const [moved] = steps.splice(index, 1)
    steps.splice(target, 0, moved!)
    setSteps(steps)
  }

  const exported = JSON.stringify(plan, null, 2)

  return (
    <div className="agent-plan">
      <p className="agents-panel__hint">{t('agents.plan.hint')}</p>

      {plan.steps.length === 0 ? (
        <p className="agents-panel__empty">{t('agents.plan.empty')}</p>
      ) : (
        <ol className="agent-plan__steps">
          {plan.steps.map((step, index) => (
            <li key={index} className="agent-plan__step">
              <div className="agent-plan__step-bar">
                <span className="agent-plan__badge">
                  {isGroup(step) ? t('agents.plan.parallelGroup') : t('agents.plan.call')}
                </span>
                <button type="button" disabled={index === 0} onClick={() => move(index, -1)}>
                  ↑
                </button>
                <button
                  type="button"
                  disabled={index === plan.steps.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => setSteps(plan.steps.filter((_, i) => i !== index))}
                >
                  {t('agents.plan.removeStep')}
                </button>
              </div>

              {isGroup(step) ? (
                <div className="agent-plan__group">
                  {step.parallel.map((call, callIndex) => (
                    <div className="agent-plan__call" key={callIndex}>
                      <select
                        value={call.agent}
                        onChange={(event) =>
                          setSteps(
                            plan.steps.map((s, i) =>
                              i === index && isGroup(s)
                                ? {
                                    parallel: s.parallel.map((c, ci) =>
                                      ci === callIndex ? { ...c, agent: event.target.value } : c
                                    )
                                  }
                                : s
                            )
                          )
                        }
                      >
                        {names.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() =>
                          setSteps(
                            plan.steps.map((s, i) =>
                              i === index && isGroup(s)
                                ? { parallel: s.parallel.filter((_, ci) => ci !== callIndex) }
                                : s
                            )
                          )
                        }
                      >
                        {t('agents.plan.removeCall')}
                      </button>
                    </div>
                  ))}
                  {/* A group holds CALLS only — there is deliberately no "add group" control here. */}
                  <button
                    type="button"
                    disabled={!first}
                    onClick={() =>
                      setSteps(
                        plan.steps.map((s, i) =>
                          i === index && isGroup(s)
                            ? { parallel: [...s.parallel, { agent: first }] }
                            : s
                        )
                      )
                    }
                  >
                    {t('agents.plan.addToGroup')}
                  </button>
                </div>
              ) : (
                <select
                  value={(step as { agent: string }).agent}
                  onChange={(event) =>
                    setSteps(
                      plan.steps.map((s, i) =>
                        i === index ? { ...(s as object), agent: event.target.value } : s
                      ) as Step[]
                    )
                  }
                >
                  {names.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
            </li>
          ))}
        </ol>
      )}

      <div className="agent-plan__add">
        <button
          type="button"
          disabled={!first}
          onClick={() => setSteps([...plan.steps, { agent: first }])}
        >
          {t('agents.plan.addCall')}
        </button>
        <button
          type="button"
          disabled={!first}
          onClick={() => setSteps([...plan.steps, { parallel: [{ agent: first }] }])}
        >
          {t('agents.plan.addParallel')}
        </button>
      </div>

      {duplicates.length ? (
        <p className="agents-panel__error" role="alert">
          {t('agents.plan.duplicate', { agents: duplicates.join(', ') })}
        </p>
      ) : null}

      <div className="agent-plan__io">
        <label className="agent-field">
          <span>{t('agents.plan.export')}</span>
          <textarea readOnly rows={6} spellCheck={false} value={exported} />
        </label>
        <label className="agent-field">
          <span>{t('agents.plan.import')}</span>
          <textarea
            rows={6}
            spellCheck={false}
            value={importText}
            placeholder='{"steps":[{"agent":"World Progression"}]}'
            onChange={(event) => setImportText(event.target.value)}
          />
        </label>
        <button
          type="button"
          onClick={() => {
            setImportError(null)
            let raw: unknown
            try {
              raw = JSON.parse(importText)
            } catch {
              setImportError(t('agents.editor.invalidJson'))
              return
            }
            // The authoritative contract parser — it is what rejects nested groups, so the editor
            // and a hand-written plan are held to exactly the same rule.
            const parsed = parseInvocationPlan(raw)
            if (!parsed.ok) {
              setImportError(
                parsed.errors.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
              )
              return
            }
            setPlan(parsed.value)
            setImportText('')
          }}
        >
          {t('agents.plan.importButton')}
        </button>
        {importError ? (
          <p className="agents-panel__error" role="alert">
            {importError}
          </p>
        ) : null}
      </div>
    </div>
  )
}
