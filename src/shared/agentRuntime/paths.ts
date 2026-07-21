import type { AgentContractResult } from './errors'
import { contractError } from './errors'
import type { FullVariablesPath, ResultSlotPath } from './types'

const RESULT_SLOT_ROOT = 'variables.__rpt.agent_results'
const RESERVED_ROOT = 'variables.__rpt'
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

const pathSegments = (path: string): string[] | undefined => {
  const segments = path.split('.')
  if (
    segments.length < 2 ||
    segments[0] !== 'variables' ||
    segments.some((segment) => !segment.length || FORBIDDEN_SEGMENTS.has(segment))
  ) {
    return undefined
  }
  return segments
}

export const isFullVariablesPath = (path: unknown): path is FullVariablesPath =>
  typeof path === 'string' && pathSegments(path) !== undefined

export const isResultSlotPath = (path: unknown): path is ResultSlotPath =>
  isFullVariablesPath(path) && path.startsWith(`${RESULT_SLOT_ROOT}.`)

export const isWritableVariablesPath = (path: unknown): path is FullVariablesPath =>
  isFullVariablesPath(path) && path !== RESERVED_ROOT && !path.startsWith(`${RESERVED_ROOT}.`)

export function parseFullVariablesPath(path: unknown): AgentContractResult<FullVariablesPath> {
  if (isFullVariablesPath(path)) return { ok: true, value: path }
  return {
    ok: false,
    errors: [
      contractError(
        'FULL_PATH_REQUIRED',
        'path must be a full dot path rooted at variables',
        ['path'],
        { kind: 'field' }
      )
    ]
  }
}

export function parseResultSlotPath(path: unknown): AgentContractResult<ResultSlotPath> {
  if (isResultSlotPath(path)) return { ok: true, value: path }
  return {
    ok: false,
    errors: [
      contractError(
        'RESULT_SLOT_PATH_REQUIRED',
        `path must be beneath ${RESULT_SLOT_ROOT}`,
        ['path'],
        { kind: 'field' }
      )
    ]
  }
}

export function parseWritableVariablesPath(path: unknown): AgentContractResult<FullVariablesPath> {
  if (isWritableVariablesPath(path)) return { ok: true, value: path }
  const reserved = isFullVariablesPath(path)
  return {
    ok: false,
    errors: [
      contractError(
        reserved ? 'RESERVED_PATH' : 'FULL_PATH_REQUIRED',
        reserved
          ? `${RESERVED_ROOT} is runtime-owned and cannot be written through Agent contracts`
          : 'path must be a full dot path rooted at variables',
        ['path'],
        { kind: 'field' }
      )
    ]
  }
}
