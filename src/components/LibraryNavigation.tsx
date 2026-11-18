import { Disc3, ListMusic, Music2, Plus, Search, X } from 'lucide-react'
import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { PlayList } from '../types'
import { CachedCover } from './CachedCover'

interface LibraryNavigationProps {
  playlists: PlayList[]
  activeId: string
  albumCollectionId: string
  onSelect: (id: string) => void
  onCreate: () => void
  onContextMenu: (playlistId: string, event: MouseEvent<HTMLButtonElement>) => void
}

export function LibraryNavigation({
  playlists,
  activeId,
  albumCollectionId,
  onSelect,
  onCreate,
  onContextMenu,
}: LibraryNavigationProps) {
  const [query, setQuery] = useState('')
  const activeRef = useRef<HTMLButtonElement>(null)
  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase()
    return keyword ? playlists.filter((item) => item.name.toLocaleLowerCase().includes(keyword)) : playlists
  }, [playlists, query])

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeId, query])

  return (
    <aside className="library-navigation" aria-label="音乐收藏导航">
      <button
        className={`library-album-entry ${activeId === albumCollectionId ? 'active' : ''}`}
        onClick={() => onSelect(albumCollectionId)}
        aria-current={activeId === albumCollectionId ? 'page' : undefined}
      >
        <Disc3 size={18} />
        <span>专辑收藏</span>
      </button>
      <div className="library-navigation-heading">
        <span>歌单</span>
        <button className="icon-button" onClick={onCreate} aria-label="新建歌单" title="新建歌单">
          <Plus size={16} />
        </button>
      </div>
      <label className="library-playlist-search">
        <Search size={14} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="查找歌单"
          aria-label="查找歌单"
        />
        {query && (
          <button onClick={() => setQuery('')} aria-label="清除歌单搜索">
            <X size={13} />
          </button>
        )}
      </label>
      <div className="library-playlist-list" aria-label="歌单列表">
        {filtered.map((playlist) => {
          const active = playlist.id === activeId
          const cover = playlist.coverUrl ?? playlist.tracks.find((track) => track.img)?.img
          return (
            <button
              key={playlist.id}
              ref={active ? activeRef : undefined}
              className={`library-playlist-entry ${active ? 'active' : ''}`}
              onClick={() => onSelect(playlist.id)}
              onContextMenu={(event) => onContextMenu(playlist.id, event)}
              aria-haspopup="menu"
              aria-current={active ? 'page' : undefined}
              title={playlist.name}
            >
              <span className="library-playlist-cover">
                <CachedCover url={cover} fallback={<ListMusic size={17} />} />
              </span>
              <span>{playlist.name}</span>
              {active && <Music2 className="library-active-mark" size={13} />}
            </button>
          )
        })}
        {!filtered.length && <p className="library-navigation-empty">没有找到歌单</p>}
      </div>
    </aside>
  )
}
