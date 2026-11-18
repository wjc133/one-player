import { ListMusic, Search } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import type { PlayList } from '../types'
import { CachedCover } from './CachedCover'

interface PlaylistDestinationPickerProps {
  playlists: PlayList[]
  value: string
  onChange: (id: string) => void
  disabled?: boolean
}

export function PlaylistDestinationPicker({
  playlists,
  value,
  onChange,
  disabled = false,
}: PlaylistDestinationPickerProps) {
  const [query, setQuery] = useState('')
  const groupName = useId()
  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase()
    return playlists.filter((playlist) => playlist.name.toLocaleLowerCase().includes(keyword))
  }, [playlists, query])

  return (
    <div className="playlist-destination-picker">
      <label className="library-playlist-search">
        <Search size={14} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索目标歌单"
          aria-label="搜索目标歌单"
          disabled={disabled}
        />
      </label>
      <div className="playlist-destination-list" role="radiogroup" aria-label="目标歌单">
        {filtered.map((playlist) => (
          <label key={playlist.id} className={`playlist-destination-row ${value === playlist.id ? 'selected' : ''}`}>
            <input
              type="radio"
              name={groupName}
              value={playlist.id}
              checked={value === playlist.id}
              onChange={() => onChange(playlist.id)}
              aria-label={playlist.name}
              disabled={disabled}
            />
            <span className="library-playlist-cover">
              <CachedCover
                url={playlist.coverUrl ?? playlist.tracks.find((track) => track.img)?.img}
                fallback={<ListMusic size={16} />}
              />
            </span>
            <span className="playlist-destination-name">{playlist.name}</span>
            <small>{playlist.tracks.length} 首</small>
          </label>
        ))}
        {!filtered.length && (
          <p className="playlist-destination-empty">
            {playlists.length ? '没有匹配的歌单' : '没有其他歌单可选，请先新建一个歌单'}
          </p>
        )}
      </div>
    </div>
  )
}
