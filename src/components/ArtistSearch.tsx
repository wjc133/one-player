import { ChevronLeft, CircleAlert, LoaderCircle, UserRound } from 'lucide-react'
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { createArtistAlbumLoader, getArtistProfile, providerNames } from '../lib/providers'
import type { AlbumSummary, AppSettings, ArtistSummary } from '../types'
import { AlbumGrid } from './AlbumGrid'
import { CachedCover } from './CachedCover'

type AlbumLoadState = {
  page: number
  list: AlbumSummary[]
} & (
  | { status: 'loading' }
  | { status: 'ready'; hasMore: boolean }
  | { status: 'error'; message: string }
)

function artistMetadata(artist: ArtistSummary) {
  return [
    artist.alias,
    artist.region,
    artist.albumCount != null && `${artist.albumCount} 张专辑`,
  ].filter(Boolean).join(' · ')
}

export function ArtistResults({ artists, onOpen }: {
  artists: ArtistSummary[]
  onOpen: (artist: ArtistSummary) => void
}) {
  if (!artists.length) {
    return <p className="artist-message" role="status">没有找到匹配的歌手</p>
  }

  return (
    <div className="album-grid">
      {artists.map((artist) => {
        const metadata = artistMetadata(artist)
        return (
          <button
            className="album-card artist-card"
            key={`${artist.source}_${artist.id}`}
            onClick={() => onOpen(artist)}
          >
            <div className="artist-avatar">
              <CachedCover url={artist.img} fallback={<UserRound size={22} />} />
            </div>
            <div className="artist-card-info">
              <strong>{artist.name}</strong>
              {metadata && <span>{metadata}</span>}
            </div>
          </button>
        )
      })}
    </div>
  )
}

export function ArtistPage({ artist, settings, scrollRootRef, hidden, onBack, onOpenAlbum }: {
  artist: ArtistSummary
  settings: AppSettings
  scrollRootRef: RefObject<HTMLDivElement | null>
  hidden: boolean
  onBack: () => void
  onOpenAlbum: (album: AlbumSummary) => void
}) {
  const [profile, setProfile] = useState<ArtistSummary | null>(null)
  const [profileError, setProfileError] = useState(false)
  const [bioExpanded, setBioExpanded] = useState(false)
  const [albumLoad, setAlbumLoad] = useState<AlbumLoadState>({ status: 'loading', page: 1, list: [] })
  const { page, status, list } = albumLoad
  const canLoadMore = status === 'ready' && albumLoad.hasMore
  const albumFooter = useRef<HTMLDivElement>(null)
  const loadAlbums = useMemo(() => createArtistAlbumLoader(artist, settings), [artist, settings])

  useEffect(() => {
    let active = true
    void getArtistProfile(artist, settings).then(
      (result) => {
        if (!active) return
        setProfile(result)
        setProfileError(false)
      },
      () => {
        if (active) setProfileError(true)
      },
    )
    return () => { active = false }
  }, [artist, settings])

  useEffect(() => {
    if (status !== 'loading') return
    let active = true
    void loadAlbums(page).then(
      (data) => {
        if (!active) return
        setAlbumLoad((current) => {
          const albums = new Map(current.list.map((album) => [album.id, album]))
          for (const album of data.list) {
            if (!albums.has(album.id)) albums.set(album.id, album)
          }
          return { status: 'ready', page, list: [...albums.values()], hasMore: data.hasMore }
        })
      },
      (reason: unknown) => {
        if (!active) return
        const message = reason instanceof Error ? reason.message : String(reason)
        setAlbumLoad((current) => ({ status: 'error', page, list: current.list, message }))
      },
    )
    return () => { active = false }
  }, [loadAlbums, page, status])

  useEffect(() => {
    const root = scrollRootRef.current
    const footer = albumFooter.current
    if (hidden || !canLoadMore || !root || !footer) return

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      setAlbumLoad((current) => current.status === 'ready' && current.page === page
        ? { status: 'loading', page: current.page + 1, list: current.list }
        : current)
    }, { root, rootMargin: '0px 0px 160px' })
    observer.observe(footer)
    return () => observer.disconnect()
  }, [canLoadMore, hidden, page, scrollRootRef])

  const summary = profile ?? artist
  const metadata = artistMetadata(summary)
  const bio = summary.bio ?? ''
  const canExpandBio = bio.length > 220
  return (
    <section className="results-section" hidden={hidden} aria-labelledby="artist-name">
      <div className="results-heading artist-page-heading">
        <button className="album-back-button" onClick={onBack}>
          <ChevronLeft size={16} />
          返回歌手结果
        </button>
      </div>
      <div className="artist-profile" data-bio-expanded={canExpandBio && bioExpanded}>
        <div className="artist-profile-header">
          <div className="artist-avatar">
            <CachedCover url={summary.img} fallback={<UserRound size={32} />} />
          </div>
          <div>
            <p>{providerNames[summary.source]}</p>
            <h2 id="artist-name">{summary.name}</h2>
            {metadata && <p>{metadata}</p>}
          </div>
        </div>
        <div className="artist-bio">
          <h3>简介</h3>
          <p id="artist-bio">
            {bio
              ? canExpandBio && !bioExpanded ? `${bio.slice(0, 220).trimEnd()}…` : bio
              : profileError ? '简介加载失败' : profile ? '暂无歌手简介' : '正在加载简介…'}
          </p>
          {canExpandBio && (
            <button
              className="artist-bio-toggle"
              aria-expanded={bioExpanded}
              aria-controls="artist-bio"
              onClick={() => setBioExpanded((current) => !current)}
            >
              {bioExpanded ? '收起简介' : '展开简介'}
            </button>
          )}
        </div>
      </div>
      <div className="results-heading artist-album-heading">
        <h3>专辑</h3>
      </div>
      <AlbumGrid albums={list} onOpen={onOpenAlbum} />
      <div className="artist-album-footer" ref={albumFooter}>
        {status === 'loading' ? (
          <div className="loading-state" role="status">
            <LoaderCircle className="spin" size={page === 1 ? 28 : 18} />
            <span>{page === 1 ? '正在加载歌手专辑…' : '正在加载更多专辑…'}</span>
          </div>
        ) : status === 'error' ? (
          <div className="inline-error" role="alert">
            <CircleAlert size={20} />
            <div>
              <strong>{page === 1 ? '专辑列表加载失败' : '更多专辑加载失败'}</strong>
              <span>{albumLoad.message}</span>
            </div>
            <button className="album-back-button" onClick={() => {
              setAlbumLoad({ status: 'loading', page, list })
            }}>
              重试
            </button>
          </div>
        ) : !canLoadMore && (
          <p className="artist-message" role="status">
            {list.length ? '已加载全部专辑' : '暂无专辑'}
          </p>
        )}
      </div>
    </section>
  )
}
