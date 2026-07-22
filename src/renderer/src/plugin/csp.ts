/**
 * Content-Security-Policy for the card-script iframe document.
 *  • Locked (default): `connect-src 'none'` + no `allow-same-origin` = "no network".
 *  • Remote-enabled (per-card `remoteScripts` grant): adds `https:` to script/connect/etc.
 *  • `rptasset:` is always allowed under img-src so local per-world portraits load (World Assets).
 */
export const buildCsp = (allowRemote: boolean): string => {
  const s = allowRemote ? ' https:' : ''
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' data: blob:${s}`,
    `style-src 'unsafe-inline'${s}`,
    `img-src data: blob: rptasset: rptremoteasset:${s}`,
    `media-src data: blob: rptasset: rptremoteasset:${s}`,
    `font-src data:${s}`,
    `connect-src ${allowRemote ? 'https:' : "'none'"}`,
    "form-action 'none'"
  ].join('; ')
}
