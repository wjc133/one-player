import { ArrowLeft, Check, ChevronDown, ChevronRight, CircleAlert, Download, ListMusic, LoaderCircle, Merge, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import type {
  ImportPlaylistCatalog,
  ImportedPlaylist,
  PlaylistImportSource,
  PlaylistImportPlatform,
  PlaylistImportResult,
  PlayList,
} from '../types'
import { detectPlaylistImportPlatforms, importPlatformPlaylists, listImportPlaylists } from '../lib/tauri'
import { CachedCover } from './CachedCover'
import { PlaylistDestinationPicker } from './PlaylistDestinationPicker'

interface PlaylistImportModalProps {
  proxy: string
  playlists: PlayList[]
  onImport: (source: PlaylistImportSource, playlists: ImportedPlaylist[], targetId?: string) => Promise<void>
  onClose: () => void
}

const platformMarks: Record<PlaylistImportSource, string> = { wy: '云', tx: 'Q', kg: '酷', kw: '我', mg: '咪', lx: 'LX' }

export function PlaylistImportModal({ proxy, playlists, onImport, onClose }: PlaylistImportModalProps) {
  const [platforms, setPlatforms] = useState<PlaylistImportPlatform[]>([])
  const [platform, setPlatform] = useState<PlaylistImportPlatform | null>(null)
  const [catalog, setCatalog] = useState<ImportPlaylistCatalog | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | 'created' | 'subscribed'>('all')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<PlaylistImportResult | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [progress, setProgress] = useState({ completed: 0, total: 0 })
  const [targetId, setTargetId] = useState('')
  const [targetPickerOpen, setTargetPickerOpen] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const destinationRef = useRef<HTMLDivElement>(null)
  const mergeButtonRef = useRef<HTMLButtonElement>(null)
  const allRef = useRef<HTMLInputElement>(null)
  const busyRef = useRef(false)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => previous?.focus()
  }, [])

  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined
    void listen<{ completed: number; total: number }>('playlist-import-progress', (event) => {
      if (active && busyRef.current) setProgress(event.payload)
    }).then((dispose) => {
      if (active) unlisten = dispose
      else dispose()
    }).catch(() => {})
    return () => { active = false; unlisten?.() }
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    const request = platform ? listImportPlaylists(platform.source) : detectPlaylistImportPlatforms()
    void request.then((data) => {
      if (!active) return
      if (Array.isArray(data)) setPlatforms(data)
      else setCatalog(data)
    }).catch((reason: unknown) => {
      if (active) setError(String(reason))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [platform, refresh])

  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase()
    return (catalog?.playlists ?? []).filter((item) =>
      (kind === 'all' || item.kind === kind) && (!keyword || item.name.toLocaleLowerCase().includes(keyword)),
    )
  }, [catalog, query, kind])
  const selectedVisible = filtered.filter((item) => selected.has(item.id)).length
  const allSelected = filtered.length > 0 && selectedVisible === filtered.length
  const target = playlists.find((playlist) => playlist.id === targetId)

  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = selectedVisible > 0 && !allSelected
  }, [selectedVisible, allSelected])

  useEffect(() => {
    if (!targetPickerOpen) return
    const closePicker = (event: PointerEvent) => {
      if (event.target instanceof Node && !destinationRef.current?.contains(event.target)) {
        setTargetPickerOpen(false)
      }
    }
    document.addEventListener('pointerdown', closePicker)
    return () => document.removeEventListener('pointerdown', closePicker)
  }, [targetPickerOpen])

  const close = () => { if (!busyRef.current) onClose() }

  async function confirmImport() {
    if (!platform || !selected.size || busyRef.current) return
    if (targetId && !target) { setError('目标歌单不存在，请重新选择'); return }
    busyRef.current = true
    setBusy(true)
    setError('')
    setResult(null)
    setProgress({ completed: 0, total: selected.size })
    try {
      const imported = await importPlatformPlaylists(platform.source, [...selected], proxy.trim() || undefined)
      if (imported.playlists.length) await onImport(platform.source, imported.playlists, targetId || undefined)
      if (!imported.failures.length) {
        onClose()
        return
      }
      setResult(imported)
      setSelected(new Set(imported.failures.map((item) => item.id)))
    } catch (reason) {
      setError(String(reason))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        ref={dialogRef}
        className="modal-card playlist-import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="playlist-import-title"
        aria-busy={busy || loading}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && targetPickerOpen) {
            event.preventDefault()
            event.stopPropagation()
            setTargetPickerOpen(false)
            mergeButtonRef.current?.focus()
            return
          }
          if (event.key === 'Escape') { event.stopPropagation(); close() }
          if (event.key !== 'Tab') return
          const elements = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])]
          const first = elements[0]
          const last = elements[elements.length - 1]
          if (!first) { event.preventDefault(); return }
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
            event.preventDefault(); last.focus()
          } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) {
            event.preventDefault(); first.focus()
          }
        }}
      >
        <button className="modal-close" onClick={close} disabled={busy} aria-label="关闭导入歌单">
          <X size={18} />
        </button>
        <div className="playlist-import-heading">
          {platform ? (
            <button className="icon-button" disabled={busy} aria-label="重新选择平台" onClick={() => {
              setPlatform(null); setCatalog(null); setSelected(new Set()); setQuery(''); setKind('all'); setResult(null); setTargetId(''); setTargetPickerOpen(false)
            }}>
              <ArrowLeft size={19} />
            </button>
          ) : <span className="modal-icon"><Download size={22} /></span>}
          <div>
            <span className="eyebrow">{platform ? platform.name : 'BRING YOUR MUSIC'}</span>
            <h2 id="playlist-import-title">{platform ? '选择要导入的歌单' : '导入歌单'}</h2>
          </div>
        </div>
        <p className="playlist-import-description">
          {platform
            ? platform.source === 'lx'
              ? '读取 LX Music 的默认列表、我的收藏和自建歌单，保留歌曲顺序与各平台信息。'
              : `${catalog?.accountName ? `${catalog.accountName} · ` : ''}仅展示个人创建和收藏的歌单，导入后保存在本机。`
            : '选择已安装的音乐平台，把熟悉的歌单带到这里。'}
        </p>

        {loading ? (
          <div className="playlist-import-empty" role="status"><LoaderCircle className="spin" size={25} /><span>{platform ? '正在读取个人歌单…' : '正在检测已安装的平台…'}</span></div>
        ) : !platform ? (
          <div className="playlist-import-platforms">
            {platforms.map((item) => (
              <button key={item.source} disabled={!item.canImport} onClick={() => {
                setCatalog(null); setPlatform(item); setError('')
              }}>
                <span className={`playlist-platform-mark platform-${item.source}`}>{platformMarks[item.source]}</span>
                <span><strong>{item.name}</strong><small>{item.message}</small></span>
                {item.canImport && <ChevronRight size={18} />}
              </button>
            ))}
          </div>
        ) : catalog ? (
          <>
            <div className="playlist-import-tools">
              <label className="library-playlist-search">
                <Search size={15} />
                <input value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} placeholder="搜索歌单名称" aria-label="搜索待导入歌单" />
              </label>
              <div className="playlist-import-filters" aria-label="歌单类型">
                {([['all', '全部'], ['created', '我创建的'], ['subscribed', '我收藏的']] as const).map(([value, label]) => (
                  <button key={value} aria-pressed={kind === value} className={kind === value ? 'active' : ''} disabled={busy} onClick={() => setKind(value)}>{label}</button>
                ))}
              </div>
            </div>
            <label className="playlist-import-select-all">
              <input ref={allRef} type="checkbox" checked={allSelected} disabled={busy || !filtered.length} onChange={() => {
                setSelected((current) => {
                  const next = new Set(current)
                  for (const item of filtered) {
                    if (allSelected) next.delete(item.id)
                    else next.add(item.id)
                  }
                  return next
                })
              }} />
              <span>{query || kind !== 'all' ? '选择当前结果' : '全选歌单'}</span>
              <small>{filtered.length} 个歌单</small>
            </label>
            <div className="playlist-import-list">
              {filtered.map((item) => (
                <label key={item.id} className={`playlist-import-row ${selected.has(item.id) ? 'selected' : ''}`}>
                  <input type="checkbox" checked={selected.has(item.id)} disabled={busy} onChange={() => setSelected((current) => {
                    const next = new Set(current)
                    if (next.has(item.id)) next.delete(item.id)
                    else next.add(item.id)
                    return next
                  })} />
                  <span className="playlist-import-cover">
                    <CachedCover url={item.coverUrl} fallback={<ListMusic size={20} />} />
                  </span>
                  <span className="playlist-import-row-info"><strong>{item.name}</strong><small>{item.trackCount} 首 · {item.kind === 'created' ? '我创建的' : '我收藏的'}</small></span>
                  {selected.has(item.id) && <Check size={15} />}
                </label>
              ))}
              {!filtered.length && <div className="playlist-import-empty"><ListMusic size={26} /><span>{catalog.playlists.length ? '没有匹配的歌单' : '尚未找到个人歌单，请先在此平台打开「我的音乐」后重试。'}</span></div>}
            </div>
            <div ref={destinationRef} className="playlist-import-destination">
              <button
                ref={mergeButtonRef}
                className={`secondary-button playlist-import-merge-button ${target ? 'active' : ''}`}
                disabled={busy || !selected.size}
                aria-expanded={targetPickerOpen}
                onClick={() => setTargetPickerOpen((current) => !current)}
              >
                <Merge size={15} />
                <span>{target ? `合并到：${target.name}` : '合并到…'}</span>
                <ChevronDown size={14} />
              </button>
              {target && (
                <button className="playlist-import-separate" disabled={busy} onClick={() => { setTargetId(''); setTargetPickerOpen(false) }}>
                  分别导入为歌单
                </button>
              )}
              {targetPickerOpen && (
                <div className="playlist-import-destination-panel">
                  <PlaylistDestinationPicker
                    playlists={playlists}
                    value={targetId}
                    onChange={(id) => { setTargetId(id); setTargetPickerOpen(false); mergeButtonRef.current?.focus() }}
                    disabled={busy}
                  />
                </div>
              )}
              <small>{target ? '所选歌单的歌曲将合并到此歌单，重复歌曲自动跳过。' : '默认分别导入，也可将所选歌单合并到已有歌单。'}</small>
            </div>
          </>
        ) : null}

        {error && <div className="playlist-import-error" role="alert"><CircleAlert size={16} /><span>{error}</span><button disabled={busy} onClick={() => setRefresh((value) => value + 1)}>重试</button></div>}
        {result && (
          <div className="playlist-import-report" role="status">
            <strong>{result.playlists.length ? `已导入 ${result.playlists.length} 个歌单，` : ''}{result.failures.length} 个歌单未能导入</strong>
            <ul>{result.failures.map((item) => <li key={item.id}><b>{item.name}</b><span>{item.message}</span></li>)}</ul>
          </div>
        )}
        <div className="playlist-import-footer">
          <span aria-live="polite">{busy ? `正在导入 ${progress.completed} / ${progress.total}…` : platform && catalog ? `已选 ${selected.size} 个歌单` : '未安装的平台暂不可选择'}</span>
          <button className="secondary-button" onClick={close} disabled={busy}>{result ? '完成' : '取消'}</button>
          {platform && <button className="primary-button" disabled={busy || loading || !selected.size} onClick={() => void confirmImport()}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
            {busy ? '导入中…' : result ? '重试所选歌单' : '导入所选歌单'}
          </button>}
        </div>
      </div>
    </div>
  )
}
