import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface ContextActionMenuProps {
  title: string
  label: string
  x: number
  y: number
  onClose: () => void
  children: ReactNode
}

export function ContextActionMenu({
  title,
  label,
  x,
  y,
  onClose,
  children,
}: ContextActionMenuProps) {
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
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [x, y])

  useEffect(() => {
    const previous = previousFocusRef.current
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  return createPortal(
    <div
      className="context-menu-backdrop"
      onClick={onClose}
      onContextMenu={(event) => { event.preventDefault(); onClose() }}
    >
      <div
        ref={menuRef}
        className="context-action-menu"
        role="menu"
        aria-label={label}
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
          const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
          const index = buttons.findIndex((button) => button === document.activeElement)
          const next = event.key === 'Home' ? 0
            : event.key === 'End' ? buttons.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
          buttons[next]?.focus()
        }}
      >
        <strong>{title}</strong>
        {children}
      </div>
    </div>,
    document.body,
  )
}
