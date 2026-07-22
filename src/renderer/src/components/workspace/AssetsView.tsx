import React from 'react'
import { useCharacterStore } from '../../stores/characterStore'
import { useChatStore } from '../../stores/chatStore'
import { useLorebookStore } from '../../stores/lorebookStore'
import {
  useAssetStore,
  lorebookIdsForWorld,
  baseName,
  extOf,
  classifyDropped,
  filenamePreview,
  validateWizardRow,
  type WizardRow,
  type RemoteAssetEntry
} from '../../stores/assetStore'
import { rosterFromStatData, nameRows } from '../../../../shared/worldAssets/coverage'
import {
  TYPES_BY_CATEGORY,
  DEFAULT_CHARACTER_ASSET_TYPE,
  categoryForType,
  type AssetCategory,
  type AssetType
} from '../../../../shared/worldAssets/types'
import { useT } from '../../i18n'
import { useToastStore } from '../../stores/toastStore'
import { mediaKindForUrl, resolveCharacterPreview } from './assetMedia'

type AssetViewCategory = AssetCategory | 'remote'

const CATS: AssetViewCategory[] = ['character', 'location', 'cg', 'remote']
const LOCAL_CATS: AssetCategory[] = ['character', 'location', 'cg']
const CAT_LABEL: Record<AssetViewCategory, string> = {
  character: 'assets.catCharacter',
  location: 'assets.catLocation',
  cg: 'assets.catCg',
  remote: 'assets.catRemote'
}

type Api = {
  assetUrl: (
    p: string,
    ids: string[],
    cat: string,
    name: string,
    type: string,
    variant?: string
  ) => Promise<string | null>
  assetPickImages: (multi: boolean) => Promise<string[]>
  assetOpenFolder: (p: string, lb: string, cat: string) => Promise<void>
}
const api = (): Api => (window as unknown as { api: Api }).api

function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  )
  React.useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!query) return
    const update = (): void => setReduced(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return reduced
}

const MediaThumb: React.FC<{
  url: string | null
  mediaKind?: 'image' | 'video'
  name: string
  className?: string
}> = ({ url, mediaKind, name, className }) => {
  const reducedMotion = useReducedMotion()
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null)
  const failed = failedUrl === url

  if (!url || failed) {
    return (
      <div className={`${className ?? ''} rpt-assets-thumb-fallback`} aria-hidden>
        {name.slice(0, 1) || '?'}
      </div>
    )
  }
  if ((mediaKind ?? mediaKindForUrl(url)) === 'video') {
    return (
      <video
        className={className}
        src={url}
        aria-label={name}
        autoPlay={!reducedMotion}
        controls={reducedMotion}
        muted
        loop={!reducedMotion}
        playsInline
        preload="metadata"
        onError={() => setFailedUrl(url)}
      />
    )
  }
  return (
    <img
      className={className}
      src={url}
      alt={name}
      loading="lazy"
      onError={() => setFailedUrl(url)}
    />
  )
}

/** Resolve + render one local asset thumbnail. Character defaults use standee-first resolution. */
const AssetThumb: React.FC<{
  profileId: string
  lorebookIds: string[]
  category: AssetCategory
  name: string
  type: AssetType
  variant?: string
  className?: string
  characterDefault?: boolean
  remote?: RemoteAssetEntry | null
}> = ({ profileId, lorebookIds, category, name, type, variant, className, characterDefault, remote }) => {
  const [media, setMedia] = React.useState<{ url: string; mediaKind: 'image' | 'video' } | null>(null)
  const idsKey = JSON.stringify(lorebookIds)
  const remoteUrl = remote?.url ?? null
  const remoteKind = remote?.mediaKind ?? 'image'
  React.useEffect(() => {
    let live = true
    const ids = JSON.parse(idsKey) as string[]
    const resolveLocal = (assetType: AssetType): Promise<string | null> =>
      api().assetUrl(profileId, ids, category, name, assetType, variant || undefined)
    const pending = characterDefault
      ? resolveCharacterPreview(resolveLocal, remoteUrl ? { url: remoteUrl, mediaKind: remoteKind } : null)
      : resolveLocal(type).then((url) => url ? { url, mediaKind: mediaKindForUrl(url) } : null)
    void pending.then((next) => {
      if (live) setMedia(next)
    })
    return () => {
      live = false
    }
  }, [profileId, idsKey, category, name, type, variant, characterDefault, remoteUrl, remoteKind])
  return <MediaThumb url={media?.url ?? null} mediaKind={media?.mediaKind} name={name} className={className} />
}

let rowSeq = 0
const nextRowId = (): string => `row-${++rowSeq}`

export const AssetsView: React.FC<{ profileId: string }> = ({ profileId }) => {
  const t = useT()
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)
  const sessionIds = useLorebookStore((s) => s.sessionIds)
  const floors = useChatStore((s) => s.floors)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const index = useAssetStore((s) => s.index)
  const coverage = useAssetStore((s) => s.coverage)
  const remoteAssets = useAssetStore((s) => s.remoteAssets)
  const remoteLoading = useAssetStore((s) => s.remoteLoading)
  const remoteError = useAssetStore((s) => s.remoteError)
  const load = useAssetStore((s) => s.load)
  const loadRemote = useAssetStore((s) => s.loadRemote)
  const refresh = useAssetStore((s) => s.refresh)
  const importFiles = useAssetStore((s) => s.importFiles)
  const deleteFile = useAssetStore((s) => s.deleteFile)
  const renameVariant = useAssetStore((s) => s.renameVariant)
  const exportZip = useAssetStore((s) => s.exportZip)

  const lorebookIds = lorebookIdsForWorld(activeCharacter?.id ?? null, sessionIds)
  const primaryId = lorebookIds[0]
  const latestVariables = floors.length ? floors[floors.length - 1]?.variables : undefined
  const statData = latestVariables?.stat_data
  const roster = React.useMemo(() => rosterFromStatData(statData), [statData])

  const [category, setCategory] = React.useState<AssetViewCategory>('character')
  const [search, setSearch] = React.useState('')
  const [selected, setSelected] = React.useState<string | null>(null)
  const [wizard, setWizard] = React.useState<WizardRow[] | null>(null)
  const [dragOver, setDragOver] = React.useState(false)
  const drawerRef = React.useRef<HTMLDivElement>(null)
  const gridRef = React.useRef<HTMLDivElement>(null)

  const idsKey = lorebookIds.join(',')
  React.useEffect(() => {
    void load(profileId, lorebookIds, roster)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, idsKey, roster.join(',')])

  React.useEffect(() => {
    void loadRemote(profileId, activeChatId)
  }, [profileId, activeChatId, latestVariables, loadRemote])

  // Esc closes the drawer first (before any parent handler).
  React.useEffect(() => {
    if (!selected) return
    drawerRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setSelected(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selected])

  const toast = (msg: string): void => useToastStore.getState().push(msg)

  // Existing names across the merged index (all categories) — wizard name autocomplete.
  const existingNames = React.useMemo(() => {
    const s = new Set<string>()
    for (const cat of LOCAL_CATS) for (const n of Object.keys(index[cat] ?? {})) s.add(n)
    return [...s]
  }, [index])
  const nameSuggestions = React.useMemo(
    () => [...new Set([...roster, ...existingNames])].sort((a, b) => a.localeCompare(b)),
    [roster, existingNames]
  )

  const counts: Record<AssetViewCategory, number> = {
    character: coverage.length,
    location: Object.keys(index.location ?? {}).length,
    cg: Object.keys(index.cg ?? {}).length,
    remote: remoteAssets.length
  }
  const remoteNames = React.useMemo(
    () => new Set(remoteAssets.map((asset) => asset.name)),
    [remoteAssets]
  )
  const rosterWithArt = coverage.filter(
    (r) => r.inRoster && (r.hasAvatar || r.hasStandee || r.hasStandeeBg || remoteNames.has(r.name))
  ).length
  const rosterTotal = roster.length

  const doImport = async (
    items: { srcPath: string; name: string; type: AssetType; variant?: string }[]
  ): Promise<void> => {
    if (!primaryId || !items.length) return
    const res = await importFiles(profileId, primaryId, lorebookIds, roster, items)
    if (res) toast(t('assets.importResult', { imported: res.imported, skipped: res.skipped }))
  }

  // Turn dropped/picked source paths into either direct imports or wizard rows.
  const intake = (paths: string[], bind?: { name?: string; type?: AssetType }): void => {
    if (category === 'remote') return
    const direct: { srcPath: string; name: string; type: AssetType; variant?: string }[] = []
    const rows: WizardRow[] = []
    for (const srcPath of paths) {
      const ext = extOf(srcPath)
      const hit = classifyDropped(srcPath)
      const boundType = bind?.type
      if (bind?.name && (boundType || (hit && categoryForType(hit.type) === category))) {
        // Pre-bound (dropped on a card/tile): a single convention-ready file imports directly.
        direct.push({
          srcPath,
          name: bind.name,
          type: boundType ?? (hit as NonNullable<typeof hit>).type,
          variant: hit?.variant || undefined
        })
        continue
      }
      if (hit && categoryForType(hit.type) === category) {
        direct.push({ srcPath, name: hit.name, type: hit.type, variant: hit.variant || undefined })
        continue
      }
      const stem = baseName(srcPath).replace(/\.[^.]+$/, '')
      rows.push({
        id: nextRowId(),
        srcPath,
        name: bind?.name ?? hit?.name ?? stem,
        type:
          boundType ??
          hit?.type ??
          (category === 'character'
            ? DEFAULT_CHARACTER_ASSET_TYPE
            : TYPES_BY_CATEGORY[category][0]),
        variant: hit?.variant ?? '',
        ext
      })
    }
    if (direct.length) void doImport(direct)
    if (rows.length) setWizard((w) => [...(w ?? []), ...rows])
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    if (category === 'remote') return
    setDragOver(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => (window as any).api.pathForFile(f) as string)
      .filter(Boolean)
    if (paths.length) intake(paths)
  }

  const pickImport = async (): Promise<void> => {
    if (category === 'remote') return
    const paths = await api().assetPickImages(true)
    if (paths.length) intake(paths)
  }

  if (!activeCharacter || !primaryId) {
    return <div className="rpt-assets-empty-view">{t('assets.selectWorld')}</div>
  }

  const q = search.trim().toLowerCase()
  const matchName = (name: string): boolean => !q || name.toLowerCase().includes(q)

  return (
    <div
      className={`rpt-assets ${dragOver && category !== 'remote' ? 'is-dragover' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        if (category === 'remote') return
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={onDrop}
    >
      <div className="rpt-assets-head">
        <div className="rpt-assets-title">
          {t('assets.heading')}
          <span className="rpt-assets-world">{activeCharacter.card?.data?.name ?? ''}</span>
        </div>
        <input
          className="rpt-assets-search"
          type="search"
          placeholder={t('assets.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="rpt-assets-actions">
          <button
            className="rpt-assets-btn"
            onClick={() => void (category === 'remote'
              ? loadRemote(profileId, activeChatId)
              : refresh(profileId, lorebookIds, roster))}
          >
            {t('assets.refresh')}
          </button>
          {category !== 'remote' && <>
            <button className="rpt-assets-btn" onClick={() => void pickImport()}>
              {t('assets.import')}
            </button>
            <button
              className="rpt-assets-btn"
              onClick={async () => {
                const res = await exportZip(profileId, primaryId)
                if (res) toast(t('assets.exportResult', { entries: res.entries }))
              }}
            >
              {t('assets.export')}
            </button>
            <button
              className="rpt-assets-btn"
              onClick={() => void api().assetOpenFolder(profileId, primaryId, category)}
            >
              {t('assets.openFolder')}
            </button>
          </>}
        </div>
      </div>

      <div className="rpt-assets-body">
        <div className="rpt-assets-rail" role="tablist" aria-label={t('assets.categories')}>
          {CATS.map((c) => (
            <button
              key={c}
              role="tab"
              aria-selected={category === c}
              className={`rpt-assets-tab ${category === c ? 'active' : ''}`}
              onClick={() => {
                setCategory(c)
                setSelected(null)
                setDragOver(false)
              }}
            >
              <span>{t(CAT_LABEL[c])}</span>
              <span className="rpt-assets-tab-count">{counts[c]}</span>
            </button>
          ))}
          <div className="rpt-assets-coverage">
            <div className="rpt-assets-coverage-label">
              {t('assets.coverage', { n: rosterWithArt, m: rosterTotal })}
            </div>
            <div
              className="rpt-assets-meter"
              role="progressbar"
              aria-valuenow={rosterWithArt}
              aria-valuemin={0}
              aria-valuemax={rosterTotal || 1}
            >
              <span
                style={{
                  width: `${rosterTotal ? Math.round((rosterWithArt / rosterTotal) * 100) : 0}%`
                }}
              />
            </div>
          </div>
        </div>

        <div
          className={`rpt-assets-grid ${category === 'remote' ? 'remote' : ''}`}
          ref={gridRef}
          onKeyDown={(e) => {
            const cards = Array.from(
              gridRef.current?.querySelectorAll<HTMLElement>('[data-card]') ?? []
            )
            const i = cards.indexOf(document.activeElement as HTMLElement)
            if (i < 0) return
            const delta =
              e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? 3 : e.key === 'ArrowUp' ? -3 : 0
            if (delta) {
              e.preventDefault()
              const next = cards[Math.max(0, Math.min(cards.length - 1, i + delta))]
              next?.focus()
            }
          }}
        >
          {category === 'remote' ? (
            <RemoteAssetGrid
              assets={remoteAssets}
              loading={remoteLoading}
              error={remoteError}
              t={t}
              matchName={matchName}
            />
          ) : (
            <CategoryGrid
              category={category}
              coverage={coverage}
              index={index}
              profileId={profileId}
              lorebookIds={lorebookIds}
              remoteAssets={remoteAssets}
              t={t}
              matchName={matchName}
              selected={selected}
              onSelect={setSelected}
              onAdd={() => void pickAddNew()}
            />
          )}
        </div>

        {selected && category !== 'remote' && (
          <DetailDrawer
            ref={drawerRef}
            category={category}
            name={selected}
            index={index}
            profileId={profileId}
            lorebookIds={lorebookIds}
            t={t}
            onClose={() => setSelected(null)}
            onReplace={(type, variant) => void pickReplace(selected, type, variant)}
            onAdd={(type) => void pickAddTile(selected, type)}
            onDelete={async (cat, file) => {
              if (!window.confirm(t('assets.confirmDelete', { file }))) return
              const ok = await deleteFile(profileId, primaryId, lorebookIds, roster, cat, file)
              if (!ok) toast(t('assets.deleteFailed'))
            }}
            onRename={async (cat, file, newVariant) => {
              const res = await renameVariant(
                profileId,
                primaryId,
                lorebookIds,
                roster,
                cat,
                file,
                newVariant
              )
              if (!res.ok) toast(t(`assets.rename.${res.error}` as const))
            }}
            onCopyRef={(name, type, variant) => {
              const snippet = variant
                ? `assetUrl('${name}','${type}','${variant}')`
                : `assetUrl('${name}','${type}')`
              void navigator.clipboard?.writeText(snippet)
              toast(t('assets.copied'))
            }}
          />
        )}
      </div>

      {wizard && category !== 'remote' && (
        <ImportWizard
          rows={wizard}
          category={category}
          nameSuggestions={nameSuggestions}
          t={t}
          onChange={setWizard}
          onCancel={() => setWizard(null)}
          onConfirm={async (rows) => {
            const items = rows
              .filter((r) => validateWizardRow(r).valid)
              .map((r) => ({
                srcPath: r.srcPath,
                name: r.name.trim(),
                type: r.type,
                variant: r.variant.trim() || undefined
              }))
            setWizard(null)
            await doImport(items)
          }}
        />
      )}
    </div>
  )

  // ── pick flows (need component-scope closures) ────────────────────────────────────────────────
  function pickAddNew(): void {
    void api()
      .assetPickImages(true)
      .then((paths) => {
        if (paths.length) intake(paths)
      })
  }
  function pickReplace(name: string, type: AssetType, variant: string): void {
    void api()
      .assetPickImages(false)
      .then((paths) => {
        if (paths[0]) void doImport([{ srcPath: paths[0], name, type, variant: variant || undefined }])
      })
  }
  function pickAddTile(name: string, type: AssetType): void {
    void api()
      .assetPickImages(true)
      .then((paths) => {
        if (paths.length) intake(paths, { name, type })
      })
  }
}

// ── Grid ───────────────────────────────────────────────────────────────────────────────────────

const CategoryGrid: React.FC<{
  category: AssetCategory
  coverage: ReturnType<typeof useAssetStore.getState>['coverage']
  index: ReturnType<typeof useAssetStore.getState>['index']
  profileId: string
  lorebookIds: string[]
  remoteAssets: RemoteAssetEntry[]
  t: ReturnType<typeof useT>
  matchName: (n: string) => boolean
  selected: string | null
  onSelect: (n: string) => void
  onAdd: () => void
}> = ({ category, coverage, index, profileId, lorebookIds, remoteAssets, t, matchName, selected, onSelect, onAdd }) => {
  const primaryType: AssetType = category === 'character' ? '头像' : category === 'location' ? '全景' : 'CG'

  const cards: React.ReactNode[] =
    category === 'character'
      ? coverage
          .filter((r) => matchName(r.name))
          .map((r) => {
            const remote = remoteAssets.find((asset) => asset.name === r.name) ?? null
            const hasStandeeBg = r.hasStandeeBg || Boolean(remote)
            return (
            <button
              key={r.name}
              data-card
              className={`rpt-assets-card ${selected === r.name ? 'active' : ''}`}
              onClick={() => onSelect(r.name)}
            >
              <AssetThumb
                profileId={profileId}
                lorebookIds={lorebookIds}
                category="character"
                name={r.name}
                type="立绘"
                characterDefault
                remote={remote}
                className="rpt-assets-card-thumb portrait"
              />
              <div className="rpt-assets-card-name">{r.name}</div>
              <div className="rpt-assets-chips">
                <span className={`rpt-assets-chip ${r.hasAvatar ? 'on' : ''}`}>
                  {t('assets.avatar')}
                  {r.hasAvatar ? ' ✓' : ''}
                </span>
                <span className={`rpt-assets-chip ${r.hasStandee ? 'on' : ''}`}>
                  {t('assets.standee')}
                  {r.hasStandee ? ' ✓' : ''}
                </span>
                <span className={`rpt-assets-chip ${hasStandeeBg ? 'on' : ''}`}>
                  {t('assets.standeeBg')}
                  {hasStandeeBg ? ' ✓' : ''}
                </span>
                {r.galleryCount > 0 && (
                  <span className="rpt-assets-chip on">
                    {t('assets.gallery')} {r.galleryCount}
                  </span>
                )}
              </div>
              {r.inRoster && !r.hasAvatar && !r.hasStandee && !hasStandeeBg && (
                <span className="rpt-assets-badge-missing">{t('assets.missing')}</span>
              )}
              {!r.inRoster && <span className="rpt-assets-badge-extra">{t('assets.notInWorld')}</span>}
            </button>
            )
          })
      : nameRows(index[category])
          .filter((r) => matchName(r.name))
          .map((r) => {
            const types = Object.keys(r.types) as AssetType[]
            const variantCount = types.reduce((n, ty) => n + (r.types[ty]?.variants ?? 0), 0)
            return (
              <button
                key={r.name}
                data-card
                className={`rpt-assets-card wide ${selected === r.name ? 'active' : ''}`}
                onClick={() => onSelect(r.name)}
              >
                <AssetThumb
                  profileId={profileId}
                  lorebookIds={lorebookIds}
                  category={category}
                  name={r.name}
                  type={types.includes(primaryType) ? primaryType : types[0]}
                  className="rpt-assets-card-thumb scene"
                />
                <div className="rpt-assets-card-name">{r.name}</div>
                <div className="rpt-assets-chips">
                  {types.map((ty) => (
                    <span key={ty} className="rpt-assets-chip on">
                      {ty}
                    </span>
                  ))}
                  {variantCount > 0 && <span className="rpt-assets-chip">+{variantCount}</span>}
                </div>
              </button>
            )
          })

  return (
    <>
      {cards.length === 0 && (
        <div className="rpt-assets-empty" data-card={false}>
          {t(`assets.empty.${category}` as const)}
        </div>
      )}
      {cards}
      <button
        data-card
        className="rpt-assets-card rpt-assets-add"
        onClick={onAdd}
        title={t('assets.addNew')}
      >
        <span className="rpt-assets-add-glyph" aria-hidden>
          ＋
        </span>
        <div className="rpt-assets-card-name">{t('assets.addNew')}</div>
      </button>
    </>
  )
}

const RemoteAssetGrid: React.FC<{
  assets: RemoteAssetEntry[]
  loading: boolean
  error: boolean
  t: ReturnType<typeof useT>
  matchName: (n: string) => boolean
}> = ({ assets, loading, error, t, matchName }) => {
  const visible = assets.filter((asset) => matchName(asset.name))
  if (loading && assets.length === 0) {
    return <div className="rpt-assets-empty">{t('assets.remoteLoading')}</div>
  }
  if (error) {
    return <div className="rpt-assets-empty">{t('assets.remoteError')}</div>
  }
  if (visible.length === 0) {
    return <div className="rpt-assets-empty">{t('assets.empty.remote')}</div>
  }
  return (
    <>
      {visible.map((asset) => (
        <article key={asset.name} className="rpt-assets-remote-row">
          <MediaThumb
            url={asset.url}
            mediaKind={asset.mediaKind}
            name={asset.name}
            className="rpt-assets-remote-thumb"
          />
          <div className="rpt-assets-remote-body">
            <div className="rpt-assets-card-name">{asset.name}</div>
            <div className="rpt-assets-remote-host" title={asset.sourceUrl}>
              {asset.hostname}
            </div>
            <div className="rpt-assets-chips">
              <span className="rpt-assets-chip on">{t('assets.standeeBg')}</span>
              <span className="rpt-assets-chip">{t('assets.remote')}</span>
            </div>
          </div>
        </article>
      ))}
    </>
  )
}

// ── Detail drawer ─────────────────────────────────────────────────────────────────────────────

interface DrawerProps {
  category: AssetCategory
  name: string
  index: ReturnType<typeof useAssetStore.getState>['index']
  profileId: string
  lorebookIds: string[]
  t: ReturnType<typeof useT>
  onClose: () => void
  onReplace: (type: AssetType, variant: string) => void
  onAdd: (type: AssetType) => void
  onDelete: (category: AssetCategory, file: string) => void | Promise<void>
  onRename: (category: AssetCategory, file: string, newVariant: string) => void | Promise<void>
  onCopyRef: (name: string, type: AssetType, variant: string) => void
}

const DetailDrawer = React.forwardRef<HTMLDivElement, DrawerProps>(function DetailDrawer(
  { category, name, index, profileId, lorebookIds, t, onClose, onReplace, onAdd, onDelete, onRename, onCopyRef },
  ref
) {
  const entry = index[category]?.[name] ?? {}
  const types = TYPES_BY_CATEGORY[category]
  return (
    <div className="rpt-assets-drawer" ref={ref} tabIndex={-1} role="dialog" aria-label={name}>
      <div className="rpt-assets-drawer-head">
        <div className="rpt-assets-drawer-title">{name}</div>
        <button className="rpt-assets-btn" onClick={onClose} aria-label={t('common.close')}>
          ✕
        </button>
      </div>
      <div className="rpt-assets-drawer-hint">{t('assets.resolutionHint')}</div>
      <div className="rpt-assets-drawer-body">
        {types.map((type) => {
          const te = entry[type]
          const tiles: { file: string; variant: string }[] = []
          if (te?.base) tiles.push({ file: te.base, variant: '' })
          for (const [variant, file] of Object.entries(te?.moods ?? {})) tiles.push({ file, variant })
          return (
            <div key={type} className="rpt-assets-section">
              <div className="rpt-assets-section-title">{type}</div>
              <div className="rpt-assets-tiles">
                {tiles.map((tile) => (
                  <Tile
                    key={tile.file}
                    profileId={profileId}
                    lorebookIds={lorebookIds}
                    category={category}
                    name={name}
                    type={type}
                    tile={tile}
                    t={t}
                    onReplace={() => onReplace(type, tile.variant)}
                    onDelete={() => void onDelete(category, tile.file)}
                    onRename={(v) => void onRename(category, tile.file, v)}
                    onCopyRef={() => onCopyRef(name, type, tile.variant)}
                  />
                ))}
                <button
                  className="rpt-assets-tile rpt-assets-tile-add"
                  onClick={() => onAdd(type)}
                  title={t('assets.addVariant')}
                >
                  <span aria-hidden>＋</span>
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
})

const Tile: React.FC<{
  profileId: string
  lorebookIds: string[]
  category: AssetCategory
  name: string
  type: AssetType
  tile: { file: string; variant: string }
  t: ReturnType<typeof useT>
  onReplace: () => void
  onDelete: () => void
  onRename: (v: string) => void
  onCopyRef: () => void
}> = ({ profileId, lorebookIds, category, name, type, tile, t, onReplace, onDelete, onRename, onCopyRef }) => {
  const [renaming, setRenaming] = React.useState(false)
  const [draft, setDraft] = React.useState(tile.variant)
  return (
    <div
      className="rpt-assets-tile"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Delete') {
          e.preventDefault()
          onDelete()
        }
      }}
    >
      <AssetThumb
        profileId={profileId}
        lorebookIds={lorebookIds}
        category={category}
        name={name}
        type={type}
        variant={tile.variant}
        className="rpt-assets-tile-thumb"
      />
      {renaming ? (
        <input
          className="rpt-assets-tile-rename"
          autoFocus
          defaultValue={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setRenaming(false)
            if (draft !== tile.variant) onRename(draft)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              setDraft(tile.variant)
              setRenaming(false)
            }
          }}
        />
      ) : (
        <div className="rpt-assets-tile-label">{tile.variant || t('assets.base')}</div>
      )}
      <div className="rpt-assets-tile-actions">
        <button title={t('assets.replace')} onClick={onReplace}>
          ⤒
        </button>
        <button title={t('assets.renameVariant')} onClick={() => setRenaming(true)}>
          ✎
        </button>
        <button title={t('assets.delete')} onClick={onDelete}>
          🗑
        </button>
        <button title={t('assets.copyRef')} onClick={onCopyRef}>
          ⧉
        </button>
      </div>
    </div>
  )
}

// ── Import wizard ─────────────────────────────────────────────────────────────────────────────

const ImportWizard: React.FC<{
  rows: WizardRow[]
  category: AssetCategory
  nameSuggestions: string[]
  t: ReturnType<typeof useT>
  onChange: (rows: WizardRow[]) => void
  onCancel: () => void
  onConfirm: (rows: WizardRow[]) => void | Promise<void>
}> = ({ rows, category, nameSuggestions, t, onChange, onCancel, onConfirm }) => {
  const types = TYPES_BY_CATEGORY[category]
  const listId = 'rpt-assets-names'
  const patch = (id: string, p: Partial<WizardRow>): void =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...p } : r)))
  const anyValid = rows.some((r) => validateWizardRow(r).valid)
  return (
    <div className="rpt-assets-modal-scrim" onClick={onCancel}>
      <div
        className="rpt-assets-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('assets.wizardTitle')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rpt-assets-modal-head">{t('assets.wizardTitle')}</div>
        <datalist id={listId}>
          {nameSuggestions.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <div className="rpt-assets-wizard-rows">
          {rows.map((r) => {
            const preview = filenamePreview(r)
            const invalid = !validateWizardRow(r).valid
            return (
              <div key={r.id} className="rpt-assets-wizard-row">
                <div className="rpt-assets-wizard-file" title={r.srcPath}>
                  {baseName(r.srcPath)}
                </div>
                <input
                  className="rpt-assets-wizard-name"
                  list={listId}
                  placeholder={t('assets.wizardName')}
                  value={r.name}
                  onChange={(e) => patch(r.id, { name: e.target.value })}
                />
                <select
                  className="rpt-assets-wizard-type"
                  value={r.type}
                  onChange={(e) => patch(r.id, { type: e.target.value as AssetType })}
                >
                  {types.map((ty) => (
                    <option key={ty} value={ty}>
                      {ty}
                    </option>
                  ))}
                </select>
                <input
                  className="rpt-assets-wizard-variant"
                  placeholder={t('assets.wizardVariant')}
                  value={r.variant}
                  onChange={(e) => patch(r.id, { variant: e.target.value })}
                />
                <div className={`rpt-assets-wizard-preview ${invalid ? 'bad' : ''}`}>
                  {preview || t('assets.wizardInvalid')}
                </div>
                <button
                  className="rpt-assets-wizard-remove"
                  title={t('assets.wizardRemove')}
                  onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
                >
                  ✕
                </button>
              </div>
            )
          })}
        </div>
        <div className="rpt-assets-modal-foot">
          <button className="rpt-assets-btn" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button
            className="rpt-assets-btn primary"
            disabled={!anyValid}
            onClick={() => void onConfirm(rows)}
          >
            {t('assets.wizardConfirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
