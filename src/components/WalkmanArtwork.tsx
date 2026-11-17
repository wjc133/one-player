import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Music2 } from 'lucide-react'
import type { WalkmanTrack } from '../types'
import { getWalkmanArtwork } from '../lib/tauri'
import { CachedCover } from './CachedCover'

const covers = new Map<string, Promise<string | null>>()

export function invalidateWalkmanArtwork(deviceId: string, path?: string) {
  const prefix = `${deviceId}:${path ? `${path}:` : ''}`
  for (const key of covers.keys())
    if (key.startsWith(prefix)) covers.delete(key)
}

export function loadWalkmanArtwork(deviceId: string, file: WalkmanTrack) {
  const key = `${deviceId}:${file.path}:${file.modifiedAt}`
  let promise = covers.get(key)
  if (!promise) {
    promise = getWalkmanArtwork(deviceId, file.path).catch((error) => {
      covers.delete(key)
      throw error
    })
    covers.set(key, promise)
    if (covers.size > 100) covers.delete(covers.keys().next().value!)
  }
  return promise
}

export function WalkmanArtwork({
  deviceId,
  file,
  url,
  revision = 0,
}: {
  deviceId: string
  file?: WalkmanTrack
  url?: string | null
  revision?: number
}) {
  const target = useRef<HTMLSpanElement>(null)
  const [cover, setCover] = useState(url ?? null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setCover(url ?? null)
    setFailed(false)
    setLoading(false)
    if (url || !file?.hasCover || !deviceId || !target.current) return
    let cancelled = false
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        setLoading(true)
        void loadWalkmanArtwork(deviceId, file)
          .then((cover) => {
            if (!cancelled) setCover(cover)
          })
          .catch(() => {
            if (!cancelled) setFailed(true)
          })
          .finally(() => {
            if (!cancelled) setLoading(false)
          })
      },
      { rootMargin: '200px' },
    )
    observer.observe(target.current)
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [deviceId, file?.path, file?.modifiedAt, file?.hasCover, url, revision])
  return (
    <span
      className="walkman-artwork"
      ref={target}
      title={
        failed
          ? '封面读取失败'
          : cover
            ? '文件内封面'
            : file?.hasCover
              ? '正在读取封面'
              : '尚未写入封面'
      }
    >
      {cover && !failed ? (
        <CachedCover
          url={cover}
          alt="歌曲封面"
          fallback={<Music2 size={21} />}
          onError={() => setFailed(true)}
        />
      ) : loading ? (
        <LoaderCircle className="spin" size={18} />
      ) : (
        <Music2 size={21} />
      )}
    </span>
  )
}
