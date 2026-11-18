import { CircleAlert, ListMusic, LoaderCircle, Merge, Pencil, X } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import type { PlayList } from '../types'
import { PlaylistDestinationPicker } from './PlaylistDestinationPicker'

function PlaylistDialog(props: {
  title: string
  icon: ReactNode
  busy: boolean
  onClose: () => void
  onSubmit: () => void
  children: ReactNode
}) {
  const dialogRef = useRef<HTMLFormElement>(null)
  const titleId = useId()
  const close = () => { if (!props.busy) props.onClose() }

  useEffect(() => {
    const previous = document.activeElement
    const input = dialogRef.current?.querySelector<HTMLInputElement>('input')
    if (input) { input.focus(); input.select() }
    else dialogRef.current?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  return (
    <div className="modal-backdrop" onClick={close}>
      <form
        ref={dialogRef}
        className="modal-card playlist-edit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={props.busy}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); props.onSubmit() }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); close() }
          if (event.key !== 'Tab') return
          const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])]
          const first = controls[0]
          const last = controls[controls.length - 1]
          if (!first) { event.preventDefault(); return }
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
            event.preventDefault(); last.focus()
          } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) {
            event.preventDefault(); first.focus()
          }
        }}
      >
        <button type="button" className="modal-close" onClick={close} disabled={props.busy} aria-label={`关闭${props.title}`}>
          <X size={18} />
        </button>
        <div className="modal-icon">{props.icon}</div>
        <h2 id={titleId}>{props.title}</h2>
        {props.children}
      </form>
    </div>
  )
}

export function PlaylistRenameDialog(props: {
  playlist: PlayList
  onRename: (name: string) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(props.playlist.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const busyRef = useRef(false)

  async function submit() {
    if (!name.trim() || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      await props.onRename(name)
      props.onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <PlaylistDialog title="重命名歌单" icon={<Pencil size={22} />} busy={busy} onClose={props.onClose} onSubmit={() => void submit()}>
      <label className="playlist-name-label">
        歌单名称
        <input className="setting-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={30} disabled={busy} />
      </label>
      {error && <div className="playlist-import-error" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={props.onClose} disabled={busy}>取消</button>
        <button type="submit" className="primary-button" disabled={busy || !name.trim()}>
          {busy && <LoaderCircle className="spin" size={15} />}
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </PlaylistDialog>
  )
}

export function PlaylistMergeDialog(props: {
  playlist: PlayList
  playlists: PlayList[]
  onMerge: (targetId: string) => Promise<void>
  onClose: () => void
}) {
  const [targetId, setTargetId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const busyRef = useRef(false)
  const destinations = props.playlists.filter((playlist) => playlist.id !== props.playlist.id)
  const targetExists = destinations.some((playlist) => playlist.id === targetId)

  async function submit() {
    if (!targetExists || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      await props.onMerge(targetId)
      props.onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <PlaylistDialog title="合并歌单" icon={<Merge size={22} />} busy={busy} onClose={props.onClose} onSubmit={() => void submit()}>
      <p className="playlist-merge-description">
        将「{props.playlist.name}」中的 {props.playlist.tracks.length} 首歌曲合并到：
      </p>
      <PlaylistDestinationPicker playlists={destinations} value={targetId} onChange={setTargetId} disabled={busy} />
      <p className="playlist-merge-help"><ListMusic size={14} />重复歌曲自动跳过，原歌单保留。</p>
      {error && <div className="playlist-import-error" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={props.onClose} disabled={busy}>取消</button>
        <button type="submit" className="primary-button" disabled={busy || !targetExists}>
          {busy ? <LoaderCircle className="spin" size={15} /> : <Merge size={15} />}
          {busy ? '合并中…' : '合并'}
        </button>
      </div>
    </PlaylistDialog>
  )
}
