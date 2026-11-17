import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Music2 } from 'lucide-react'
import { createCoverSession, forgetCover, peekCover } from '../lib/coverCache'

const CoverContext = createContext(createCoverSession())

export function CoverCacheProvider({
  proxy,
  retryKey,
  children,
}: {
  proxy: string
  retryKey: string
  children: ReactNode
}) {
  const session = useMemo(() => createCoverSession(proxy), [proxy, retryKey])
  return <CoverContext.Provider value={session}>{children}</CoverContext.Provider>
}

export function useCoverUrl(url?: string | null, enabled = true) {
  const session = useContext(CoverContext)
  const [result, setResult] = useState({
    url,
    session,
    src: peekCover(url),
    error: '',
  })
  useEffect(() => {
    let cancelled = false
    setResult({ url, session, src: peekCover(url), error: '' })
    if (url && enabled) {
      void session.load(url).then(
        (src) => {
          if (!cancelled) setResult({ url, session, src, error: '' })
        },
        (error) => {
          if (!cancelled) setResult({ url, session, src: null, error: String(error) })
        },
      )
    }
    return () => { cancelled = true }
  }, [url, session, enabled])
  const current = result.url === url && result.session === session
    ? result
    : { src: peekCover(url), error: '' }
  return {
    ...current,
    loading: Boolean(url && enabled && !current.src && !current.error),
    fail() {
      if (url) forgetCover(url)
      setResult({ url, session, src: null, error: '封面图片无法显示' })
    },
  }
}

export function CachedCover({
  url,
  className = '',
  fallbackClassName = '',
  fallback = <Music2 size={20} />,
  alt = '',
  lazy = true,
  onError,
}: {
  url?: string | null
  className?: string
  fallbackClassName?: string
  fallback?: ReactNode
  alt?: string
  lazy?: boolean
  onError?: () => void
}) {
  const target = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(!lazy)
  const { src, error, loading, fail } = useCoverUrl(url, visible || !lazy)
  useEffect(() => {
    if (visible || !lazy || !target.current) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true)
        observer.disconnect()
      }
    }, { rootMargin: '200px' })
    observer.observe(target.current)
    return () => observer.disconnect()
  }, [visible, lazy])
  useEffect(() => {
    if (error) onError?.()
  }, [error, onError])
  return (
    <span
      ref={target}
      className={`cached-cover ${className} ${src ? '' : fallbackClassName}`}
      aria-busy={loading || undefined}
      title={error ? '封面加载失败，重新打开后重试' : undefined}
    >
      {src ? <img src={src} alt={alt} referrerPolicy="no-referrer" onError={fail} /> : fallback}
    </span>
  )
}
