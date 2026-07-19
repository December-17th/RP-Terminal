import type { ProviderErrorDiagnostics, ProviderRetryClass } from './types'

const ordinaryGenerationHttpMessages = new WeakMap<ProviderDispatchError, string>()

export class ProviderDispatchError extends Error {
  readonly retryClass: ProviderRetryClass
  readonly status?: number
  readonly retryAfterMs?: number
  readonly diagnostics?: Readonly<ProviderErrorDiagnostics>

  constructor(
    message: string,
    options: {
      retryClass: ProviderRetryClass
      status?: number
      retryAfterMs?: number
      diagnostics?: ProviderErrorDiagnostics
    }
  ) {
    super(message)
    this.name = 'ProviderDispatchError'
    this.retryClass = options.retryClass
    this.status = options.status
    this.retryAfterMs = options.retryAfterMs
    this.diagnostics = options.diagnostics
  }
}

export const parseRetryAfterMs = (value: string | null, now = Date.now()): number | undefined => {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(value)
  if (!Number.isFinite(date)) return undefined
  return Math.max(0, date - now)
}

export const retryClassForStatus = (status: number): ProviderRetryClass => {
  if (status === 429) return 'rate-limit'
  if (status === 408 || status === 409 || status === 425 || status >= 500) return 'transient'
  return 'non-retryable'
}

export const providerHttpError = async (
  label: string,
  response: Response
): Promise<ProviderDispatchError> => {
  const responseText = (await response.text()).slice(0, 800)
  const error = new ProviderDispatchError(`${label} Error: ${response.status}`, {
    retryClass: retryClassForStatus(response.status),
    status: response.status,
    retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
    diagnostics: { category: 'http' }
  })
  ordinaryGenerationHttpMessages.set(
    error,
    `${label} Error: ${response.status} ${response.statusText} - ${responseText}`
  )
  return error
}

export const ordinaryGenerationHttpErrorMessage = (
  error: ProviderDispatchError
): string | undefined => ordinaryGenerationHttpMessages.get(error)

export const providerFailureMessage = (error: ProviderDispatchError): string => {
  const diagnostics = error.diagnostics
  const status = error.status === undefined ? '' : `; status=${error.status}`
  if (!diagnostics) return `Provider request failed${status}`
  const frames = diagnostics.frameCount === undefined ? '' : `; frames=${diagnostics.frameCount}`
  const parsed =
    diagnostics.parsedFrameCount === undefined ? '' : `; parsed=${diagnostics.parsedFrameCount}`
  const categories = diagnostics.frameCategories?.length
    ? `; categories=${diagnostics.frameCategories.join(',')}`
    : ''
  return `Provider request failed (${diagnostics.category}${status}${frames}${parsed}${categories})`
}
