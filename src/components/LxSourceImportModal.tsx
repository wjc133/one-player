import { CircleAlert, LoaderCircle, Upload, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { LxMusicImportResult, LxMusicSourceSummary } from '../types'
import { AppIcon } from './AppIcon'

interface LxSourceImportModalProps {
  sources: LxMusicSourceSummary[]
  busy: boolean
  onImport: (ids: string[]) => Promise<LxMusicImportResult>
  onClose: () => void
}

export function LxSourceImportModal({ sources, busy, onImport, onClose }: LxSourceImportModalProps) {
  const available = sources.filter((source) => !source.error)
  const [selected, setSelected] = useState(() => new Set(available.map((source) => source.id)))
  const [error, setError] = useState('')
  const [failures, setFailures] = useState<LxMusicImportResult['failures']>([])
  const dialogRef = useRef<HTMLDivElement>(null)
  const importingRef = useRef(false)
  const allRef = useRef<HTMLInputElement>(null)
  const allSelected = available.length > 0 && available.every((source) => selected.has(source.id))

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => previous?.focus()
  }, [])

  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = selected.size > 0 && !allSelected
  }, [selected, allSelected])

  const close = () => { if (!busy && !importingRef.current) onClose() }

  async function confirm() {
    if (busy || importingRef.current || !selected.size) return
    importingRef.current = true
    setError('')
    setFailures([])
    try {
      const result = await onImport([...selected])
      setFailures(result.failures)
      setSelected(new Set(result.failures.map((failure) => failure.id)))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      importingRef.current = false
    }
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        ref={dialogRef}
        className="modal-card playlist-import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lx-source-import-title"
        aria-busy={busy}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); close() }
          if (event.key !== 'Tab') return
          const elements = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])]
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
        <button className="modal-close" onClick={close} disabled={busy} aria-label="关闭 LX 音源导入">
          <X size={18} />
        </button>
        <div className="playlist-import-heading">
          <span className="modal-icon"><AppIcon /></span>
          <div><span className="eyebrow">LX MUSIC</span><h2 id="lx-source-import-title">选择要导入的音源</h2></div>
        </div>
        <p className="playlist-import-description">已检测到 {sources.length} 个音源，选择后添加到 One Player。</p>
        <label className="playlist-import-select-all">
          <input ref={allRef} type="checkbox" checked={allSelected} disabled={busy || !available.length} onChange={() => {
            setSelected(allSelected ? new Set() : new Set(available.map((source) => source.id)))
          }} />
          全选可用音源
          <small>已选 {selected.size} 个</small>
        </label>
        <div className="playlist-import-list">
          {sources.map((source) => (
            <label key={source.id} className={`playlist-import-row ${selected.has(source.id) ? 'selected' : ''}`}>
              <input type="checkbox" checked={selected.has(source.id)} disabled={busy || Boolean(source.error)} onChange={() => {
                setSelected((current) => {
                  const next = new Set(current)
                  if (next.has(source.id)) next.delete(source.id)
                  else next.add(source.id)
                  return next
                })
              }} />
              <span className="playlist-import-row-info">
                <strong>{source.name || source.id}{source.version ? ` · v${source.version}` : ''}</strong>
                <small>{source.error || [source.author, source.description].filter(Boolean).join(' · ') || 'LX 自定义音源'}</small>
              </span>
            </label>
          ))}
        </div>
        {error && <div className="playlist-import-error" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}
        {failures.length > 0 && (
          <div className="playlist-import-report" role="alert">
            <strong>{failures.length} 个音源未能导入，可重试</strong>
            <ul>{failures.map((failure) => <li key={failure.id}><b>{failure.name}</b><span>{failure.message}</span></li>)}</ul>
          </div>
        )}
        <div className="playlist-import-footer">
          <span>已有相同脚本会自动跳过重复添加</span>
          <button className="secondary-button" onClick={close} disabled={busy}>取消</button>
          <button className="primary-button" onClick={() => void confirm()} disabled={busy || !selected.size}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}
            {busy ? '导入中…' : `添加所选音源（${selected.size}）`}
          </button>
        </div>
      </div>
    </div>
  )
}
