import type { WalkmanTrack } from '../types'

export const tagMetadataKeys = ['title', 'artist', 'album'] as const

export type TagMetadataKey = (typeof tagMetadataKeys)[number]

export interface TagMetadataValues {
  title: string
  artist: string
  album: string
}

export const formatStorage = (bytes: number) => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export const selectOnlineTagMetadata = ({
  existing,
  online,
  missingFields,
  overwriteExisting,
}: {
  existing: TagMetadataValues
  online: TagMetadataValues
  missingFields: string[]
  overwriteExisting: boolean
}): TagMetadataValues => ({
  title:
    overwriteExisting || missingFields.includes('歌曲名')
      ? online.title
      : existing.title,
  artist:
    overwriteExisting || missingFields.includes('歌手')
      ? online.artist
      : existing.artist,
  album:
    overwriteExisting || missingFields.includes('专辑')
      ? online.album
      : existing.album,
})

export const tagSearchQuery = (track: WalkmanTrack) => {
  const filename =
    track.relativePath
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]+$/, '') ?? ''
  const title = track.title.trim() || filename
  return [...new Set([track.artist, title].filter(Boolean))]
    .join(' ')
    .replace(/\+/g, ' ')
    .replace(/^\s*\d{1,3}[.\s_-]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export const walkmanTagStatus = (track: WalkmanTrack) => {
  if (track.tagError) return ['标签读取异常']
  const inferred = track.inferredFields ?? []
  const missing = track.missingFields.filter(
    (field) => !inferred.includes(field),
  )
  return [
    inferred.length ? `文件名已识别，待写入${inferred.join('、')}` : '',
    missing.length ? `待补全${missing.join('、')}` : '',
  ].filter(Boolean)
}
