import { Merge, Pencil, Trash2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PlayList } from '../types'

interface PlaylistActionMenuProps {
  playlist: PlayList
  x: number
  y: number
  onRename: () => void
  onMerge: () => void
  onDelete: () => void
  onClose: () => void
}

export function PlaylistActionMenu({
  playlist,
  x,
  y,
  onRename,
  onMerge,
  onDelete,
  onClose,
}: PlaylistActionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef(document.activeElement)
  const [position, setPosition] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const bounds = menuRef.current?.getBoundingClientRect()
    if (!bounds) return
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)),
    })
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [x, y])

  useEffect(() => {
    const previous = previousFocusRef.current
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  return createPortal(
    <div
      className="playlist-menu-backdrop"
      onClick={onClose}
      onContextMenu={(event) => { event.preventDefault(); onClose() }}
    >
      <div
        ref={menuRef}
        className="playlist-action-menu"
        role="menu"
        aria-label={`${playlist.name}的歌单操作`}
        style={position}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape' || event.key === 'Tab') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
          }
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
          const index = buttons.findIndex((button) => button === document.activeElement)
          const next = event.key === 'Home' ? 0
            : event.key === 'End' ? buttons.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
          buttons[next]?.focus()
        }}
      >
        <strong>{playlist.name}</strong>
        <button role="menuitem" onClick={onRename}><Pencil size={15} /><span>重命名</span></button>
        <button role="menuitem" onClick={onMerge}><Merge size={15} /><span>合并到…</span></button>
        <button role="menuitem" className="danger" onClick={onDelete}><Trash2 size={15} /><span>删除歌单…</span></button>
      </div>
    </div>,
    document.body,
  )
}
