import { Check, ChevronDown } from 'lucide-react'
import { type CSSProperties, type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface SelectProps<Value extends string> {
  label: string
  value: Value
  options: readonly { value: Value; label: string }[]
  onChange: (value: Value) => void
  disabled?: boolean
  variant?: 'player'
}

export function Select<Value extends string>({ label, value, options, onChange, disabled, variant }: SelectProps<Value>) {
  const id = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef({ text: '', time: 0 })
  const [position, setPosition] = useState<CSSProperties | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const selectedIndex = options.findIndex((option) => option.value === value)
  const unavailable = disabled || options.length === 0
  const open = position !== null && !unavailable
  const listId = `${id}-options`
  const optionId = (index: number) => `${id}-option-${index}`

  function show(index: number) {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const below = window.innerHeight - rect.bottom - 12
    const above = rect.top - 12
    const opensUp = below < Math.min(240, options.length * 34 + 10) && above > below
    const width = Math.min(Math.max(rect.width, 124), window.innerWidth - 16)
    setActiveIndex(Math.max(0, index))
    setPosition({
      top: opensUp ? undefined : rect.bottom + 4,
      bottom: opensUp ? window.innerHeight - rect.top + 4 : undefined,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      width,
      maxHeight: Math.min(240, opensUp ? above : below),
    })
  }

  function dismiss() {
    searchRef.current.text = ''
    setPosition(null)
  }

  function choose(index: number) {
    const option = options[index]
    dismiss()
    if (option && option.value !== value) onChange(option.value)
  }

  useLayoutEffect(() => {
    if (!open) return
    listRef.current?.children[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: Event) => {
      if (!(event.target instanceof Node)) return
      if (triggerRef.current?.contains(event.target) || listRef.current?.contains(event.target)) return
      dismiss()
    }
    document.addEventListener('pointerdown', closeOutside, true)
    document.addEventListener('scroll', closeOutside, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true)
      document.removeEventListener('scroll', closeOutside, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [open])

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Tab') {
      dismiss()
      return
    }
    if (open && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      dismiss()
      return
    }

    let nextIndex: number
    switch (event.key) {
      case 'Enter':
      case ' ':
        if (open) {
          event.preventDefault()
          choose(activeIndex)
        }
        return
      case 'ArrowDown':
        nextIndex = open ? Math.min(activeIndex + 1, options.length - 1) : selectedIndex
        break
      case 'ArrowUp':
        nextIndex = open ? Math.max(activeIndex - 1, 0) : selectedIndex === -1 ? options.length - 1 : selectedIndex
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = options.length - 1
        break
      default: {
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return
        const previous = searchRef.current
        const time = Date.now()
        const key = event.key.toLocaleLowerCase()
        const text = time - previous.time < 650 && previous.text !== key ? previous.text + key : key
        searchRef.current = { text, time }
        const start = open ? activeIndex : selectedIndex
        nextIndex = -1
        for (let offset = 1; offset <= options.length; offset += 1) {
          const index = (start + offset) % options.length
          if (options[index].label.toLocaleLowerCase().startsWith(text)) {
            nextIndex = index
            break
          }
        }
        if (nextIndex < 0) return
      }
    }
    event.preventDefault()
    if (open) setActiveIndex(nextIndex)
    else show(nextIndex)
  }

  const variantClass = variant ? ` select-${variant}` : ''
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`select-trigger${variantClass}`}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && options[activeIndex] ? optionId(activeIndex) : undefined}
        disabled={unavailable}
        onClick={(event) => {
          if (open) dismiss()
          else {
            event.currentTarget.focus({ preventScroll: true })
            show(selectedIndex)
          }
        }}
        onKeyDown={onKeyDown}
        onBlur={(event) => { if (event.relatedTarget) dismiss() }}
      >
        <span>{options[selectedIndex]?.label ?? options[0]?.label}</span>
        <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          id={listId}
          ref={listRef}
          role="listbox"
          aria-label={label}
          className={`select-options${variantClass}`}
          style={position}
        >
          {options.map((option, index) => (
            <div
              key={option.value}
              id={optionId(index)}
              role="option"
              aria-selected={option.value === value}
              className={index === activeIndex ? 'active' : undefined}
              onMouseMove={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={14} aria-hidden="true" />}
            </div>
          ))}
        </div>,
        triggerRef.current?.closest('[role="dialog"]') ?? document.body,
      )}
    </>
  )
}
