/**
 * Map a freshly-folded floor's MVU `delta_data` into the `mag_*` event sequence that
 * MagVarUpdate front-end UI scripts subscribe to (Track R / R5). Emitted into card
 * iframes after each turn so reactive panels refresh. Pure + unit-tested; the
 * dispatch lives in CardScriptHost. Event names mirror MVU's
 * (`mag_variable_update_started` / `mag_variable_updated` / `_ended`).
 */

export interface MvuEvent {
  name: string
  payload: unknown
}

interface Delta {
  path: string
  old: unknown
  new: unknown
  reason?: string
}

export const buildMvuEvents = (variables: Record<string, unknown> | undefined): MvuEvent[] => {
  if (!variables) return []
  const deltas = (Array.isArray(variables.delta_data) ? variables.delta_data : []) as Delta[]
  if (deltas.length === 0) return []

  const statData = (variables.stat_data ?? {}) as unknown
  const events: MvuEvent[] = [{ name: 'mag_variable_update_started', payload: { stat_data: statData } }]
  for (const d of deltas) {
    events.push({
      name: 'mag_variable_updated',
      payload: { stat_data: statData, path: d.path, oldValue: d.old, newValue: d.new, reason: d.reason }
    })
  }
  events.push({
    name: 'mag_variable_update_ended',
    payload: { stat_data: statData, delta_data: deltas }
  })
  return events
}
