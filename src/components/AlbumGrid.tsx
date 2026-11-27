import { Music2 } from 'lucide-react'
import { providerNames } from '../lib/providers'
import type { AlbumSummary } from '../types'
import { CachedCover } from './CachedCover'

export function AlbumGrid({ albums, onOpen }: {
  albums: AlbumSummary[]
  onOpen: (album: AlbumSummary) => void
}) {
  if (!albums.length) return null

  return (
    <div className="album-grid">
      {albums.map((album) => (
        <button
          className="album-card"
          key={`${album.source}_${album.id}`}
          onClick={() => onOpen(album)}
        >
          <div className="album-card-cover">
            <CachedCover url={album.img} fallback={<Music2 size={25} />} />
          </div>
          <div className="album-card-info">
            <strong>{album.name}</strong>
            <span>{album.singer || '未知歌手'}</span>
            <small>
              {[album.publishTime, album.songCount && `${album.songCount} 首`]
                .filter(Boolean)
                .join(' · ') || providerNames[album.source]}
            </small>
          </div>
        </button>
      ))}
    </div>
  )
}
