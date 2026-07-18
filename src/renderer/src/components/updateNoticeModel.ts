export interface UpdateNoticeInfo {
  currentVersion: string
  latestVersion: string
}

export const UPDATE_DISMISSAL_KEY = 'rpt.updateNotice.dismissedVersion'

export function visibleUpdate(
  update: UpdateNoticeInfo | null,
  dismissedVersion: string | null
): UpdateNoticeInfo | null {
  return update && update.latestVersion !== dismissedVersion ? update : null
}

export function dismissUpdate(update: UpdateNoticeInfo | null): string | null {
  return update?.latestVersion ?? null
}
