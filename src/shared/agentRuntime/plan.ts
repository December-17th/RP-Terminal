import { z } from 'zod'
import {
  contractError,
  contractErrorsFromZod,
  locateContractPath,
  type AgentContractError,
  type AgentContractResult,
  type ContractPath
} from './errors'
import { InvocationPlanCallSchema } from './schema'
import type { InvocationPlan, InvocationPlanCall, InvocationPlanParallelGroup } from './types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const prefixErrors = (errors: AgentContractError[], prefix: ContractPath): AgentContractError[] =>
  errors.map((error) => {
    const path = [...prefix, ...error.path]
    return {
      ...error,
      path,
      location: locateContractPath(path, { kind: 'plan' })
    }
  })

const parsePlanCall = (
  raw: unknown,
  path: ContractPath
): { value?: InvocationPlanCall; errors: AgentContractError[] } => {
  const parsed = InvocationPlanCallSchema.safeParse(raw)
  if (parsed.success) return { value: parsed.data, errors: [] }
  return {
    errors: prefixErrors(contractErrorsFromZod(parsed.error.issues, { kind: 'plan' }), path)
  }
}

export function parseInvocationPlan(raw: unknown): AgentContractResult<InvocationPlan> {
  if (!isRecord(raw)) {
    const parsed = z
      .strictObject({ floor: z.int().positive().optional(), steps: z.array(z.unknown()) })
      .safeParse(raw)
    return {
      ok: false,
      errors: contractErrorsFromZod(parsed.error?.issues ?? [], { kind: 'plan' })
    }
  }

  const errors: AgentContractError[] = []
  for (const key of Object.keys(raw)) {
    if (key === 'floor' || key === 'steps') continue
    errors.push(
      contractError('UNKNOWN_FIELD', `unknown Invocation Plan field "${key}"`, [key], {
        kind: 'plan'
      })
    )
  }

  let floor: number | undefined
  if (raw.floor !== undefined) {
    const parsedFloor = z.int().positive().safeParse(raw.floor)
    if (parsedFloor.success) floor = parsedFloor.data
    else {
      errors.push(
        ...prefixErrors(contractErrorsFromZod(parsedFloor.error.issues, { kind: 'plan' }), [
          'floor'
        ])
      )
    }
  }

  if (!Array.isArray(raw.steps)) {
    const parsedSteps = z.array(z.unknown()).safeParse(raw.steps)
    errors.push(
      ...prefixErrors(contractErrorsFromZod(parsedSteps.error?.issues ?? [], { kind: 'plan' }), [
        'steps'
      ])
    )
    return { ok: false, errors }
  }

  const steps: Array<InvocationPlanCall | InvocationPlanParallelGroup> = []
  const seenAgents = new Map<string, ContractPath>()

  const recordAgent = (call: InvocationPlanCall, path: ContractPath): void => {
    const prior = seenAgents.get(call.agent)
    if (prior) {
      errors.push(
        contractError(
          'DUPLICATE_AGENT',
          `Agent "${call.agent}" already appears at ${prior.join('.')}`,
          [...path, 'agent'],
          { kind: 'plan' }
        )
      )
    } else {
      seenAgents.set(call.agent, [...path, 'agent'])
    }
  }

  raw.steps.forEach((rawStep, stepIndex) => {
    const stepPath: ContractPath = ['steps', stepIndex]
    if (isRecord(rawStep) && Object.hasOwn(rawStep, 'parallel')) {
      for (const key of Object.keys(rawStep)) {
        if (key === 'parallel') continue
        errors.push(
          contractError(
            'UNKNOWN_FIELD',
            `unknown parallel group field "${key}"`,
            [...stepPath, key],
            { kind: 'plan' }
          )
        )
      }

      if (!Array.isArray(rawStep.parallel) || rawStep.parallel.length === 0) {
        errors.push(
          contractError(
            'EMPTY_PARALLEL',
            'a parallel group must contain at least one Agent call',
            [...stepPath, 'parallel'],
            { kind: 'plan' }
          )
        )
        return
      }

      const parallel: InvocationPlanCall[] = []
      rawStep.parallel.forEach((rawCall, parallelIndex) => {
        const callPath: ContractPath = [...stepPath, 'parallel', parallelIndex]
        if (isRecord(rawCall) && Object.hasOwn(rawCall, 'parallel')) {
          errors.push(
            contractError(
              'NESTED_PARALLEL',
              'parallel groups cannot be nested',
              [...callPath, 'parallel'],
              { kind: 'plan' }
            )
          )
          return
        }
        const parsed = parsePlanCall(rawCall, callPath)
        errors.push(...parsed.errors)
        if (parsed.value) {
          parallel.push(parsed.value)
          recordAgent(parsed.value, callPath)
        }
      })
      if (parallel.length) steps.push({ parallel })
      return
    }

    const parsed = parsePlanCall(rawStep, stepPath)
    errors.push(...parsed.errors)
    if (parsed.value) {
      steps.push(parsed.value)
      recordAgent(parsed.value, stepPath)
    }
  })

  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    value: {
      ...(floor === undefined ? {} : { floor }),
      steps
    }
  }
}
