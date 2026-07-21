import type { z } from 'zod'

export type ContractPath = Array<string | number>

export type ContractErrorLocation =
  | { kind: 'agent'; agent?: string }
  | { kind: 'field'; agent?: string; field: string }
  | { kind: 'binding'; agent?: string; binding: string; field?: string }
  | { kind: 'tool'; agent?: string; tool: string | number; field?: string }
  | { kind: 'plan'; step?: number; parallel?: number; field?: string }

export interface AgentContractError {
  code: string
  message: string
  path: ContractPath
  location: ContractErrorLocation
}

export type AgentContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: AgentContractError[] }

type ErrorContext =
  | { kind: 'agent'; agent?: string }
  | { kind: 'bindings'; agent?: string }
  | { kind: 'plan' }
  | { kind: 'field'; agent?: string }

const pathTail = (path: ContractPath, from: number): string | undefined => {
  const tail = path.slice(from)
  return tail.length ? tail.join('.') : undefined
}

export function locateContractPath(
  path: ContractPath,
  context: ErrorContext
): ContractErrorLocation {
  if (context.kind === 'plan') {
    const step = path[0] === 'steps' && typeof path[1] === 'number' ? path[1] : undefined
    const parallel =
      step !== undefined && path[2] === 'parallel' && typeof path[3] === 'number'
        ? path[3]
        : undefined
    const field = pathTail(path, parallel === undefined ? (step === undefined ? 0 : 2) : 4)
    return { kind: 'plan', step, parallel, ...(field ? { field } : {}) }
  }

  if (path[0] === 'tools' && typeof path[1] === 'number') {
    return {
      kind: 'tool',
      ...(context.agent ? { agent: context.agent } : {}),
      tool: path[1],
      ...(pathTail(path, 2) ? { field: pathTail(path, 2) } : {})
    }
  }

  if (context.kind === 'bindings') {
    const binding = typeof path[0] === 'string' ? path[0] : ''
    return {
      kind: 'binding',
      ...(context.agent ? { agent: context.agent } : {}),
      binding,
      ...(pathTail(path, 1) ? { field: pathTail(path, 1) } : {})
    }
  }

  if (path.length) {
    return {
      kind: 'field',
      ...(context.agent ? { agent: context.agent } : {}),
      field: path.join('.')
    }
  }
  return { kind: 'agent', ...(context.agent ? { agent: context.agent } : {}) }
}

const issueCode = (issue: z.core.$ZodIssue): string => {
  if (issue.code === 'unrecognized_keys') return 'UNKNOWN_FIELD'
  if (issue.message === 'path must be a full dot path rooted at variables')
    return 'FULL_PATH_REQUIRED'
  if (issue.message === 'path must be beneath variables.__rpt.agent_results')
    return 'RESULT_SLOT_PATH_REQUIRED'
  if (issue.message === 'Result Slot reads must use a result source')
    return 'RESULT_SOURCE_REQUIRED'
  if (issue.message === 'default is only valid for a variables or result source')
    return 'INVALID_DEFAULT'
  if (issue.code === 'invalid_union' || issue.code === 'invalid_type') return 'INVALID_TYPE'
  if (issue.code === 'too_small') return 'VALUE_TOO_SMALL'
  return 'INVALID_FIELD'
}

export function contractErrorsFromZod(
  issues: z.core.$ZodIssue[],
  context: ErrorContext
): AgentContractError[] {
  return issues.flatMap((issue) => {
    const issuePath: ContractPath = issue.path.map((segment) =>
      typeof segment === 'symbol' ? String(segment) : segment
    )
    const paths =
      issue.code === 'unrecognized_keys'
        ? issue.keys.map((key) => [...issuePath, key])
        : [issuePath]
    return paths.map((path) => ({
      code: issueCode(issue),
      message: issue.message,
      path,
      location: locateContractPath(path, context)
    }))
  })
}

export function contractError(
  code: string,
  message: string,
  path: ContractPath,
  context: ErrorContext
): AgentContractError {
  return {
    code,
    message,
    path,
    location: locateContractPath(path, context)
  }
}
