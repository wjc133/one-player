import { useEffect, useRef, useState } from 'react'
import { Music2, X } from 'lucide-react'
import type { CloseBehavior } from '../types'

export function CloseChoiceDialog(props: {
  busy: boolean
  onCancel: () => void
  onConfirm: (behavior: Exclude<CloseBehavior, 'ask'>, remember: boolean) => void
}) {
  const [remember, setRemember] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previousFocus = document.activeElement
    dialogRef.current?.focus()
    return () => {
      if (previousFocus instanceof HTMLElement) previousFocus.focus()
    }
  }, [])

  return (
    <div className="modal-backdrop close-choice-backdrop" onClick={props.onCancel}>
      <div
        ref={dialogRef}
        className="modal-card close-choice-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-choice-title"
        aria-describedby="close-choice-description"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') props.onCancel()
          if (event.key !== 'Tab') return
          const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled)',
          )
          if (!controls?.length) return
          const first = controls[0]
          const last = controls[controls.length - 1]
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <button
          className="modal-close"
          onClick={props.onCancel}
          disabled={props.busy}
          aria-label="取消关闭"
        >
          <X size={18} />
        </button>
        <div className="modal-icon"><Music2 size={23} /></div>
        <h2 id="close-choice-title">关闭 One Player？</h2>
        <p id="close-choice-description">
          隐藏到菜单栏后，音乐会继续播放。点击顶部音乐图标即可找回窗口。
          退出应用会停止播放。
        </p>
        <label className="close-choice-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            disabled={props.busy}
          />
          <span>记住我的选择<small>之后可在设置中修改</small></span>
        </label>
        <div className="modal-actions">
          <button className="secondary-button" disabled={props.busy} onClick={props.onCancel}>
            取消
          </button>
          <button className="secondary-button" disabled={props.busy} onClick={() => props.onConfirm('quit', remember)}>
            退出应用
          </button>
          <button className="primary-button" disabled={props.busy} onClick={() => props.onConfirm('tray', remember)}>
            隐藏到菜单栏
          </button>
        </div>
      </div>
    </div>
  )
}
