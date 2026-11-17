import type { ImportedPlaylist, MusicTrack, OnlineSourceKey, PlayList } from '../types'

const trackKey = (track: MusicTrack) => `${track.source}:${track.songmid}`

export function mergeImportedPlaylists(
  existing: PlayList[],
  platform: OnlineSourceKey,
  incoming: ImportedPlaylist[],
  importedAt = Date.now(),
): PlayList[] {
  const result = [...existing]
  for (const playlist of incoming) {
    const id = `imported:${platform}:${playlist.externalId}`
    const index = result.findIndex((item) =>
      item.id === id ||
      (item.importSource?.platform === platform && item.importSource.playlistId === playlist.externalId),
    )
    const previous = index >= 0 ? result[index] : undefined
    const updates = new Map(playlist.tracks.map((track) => [trackKey(track), track]))
    const seen = new Set<string>()
    const tracks: MusicTrack[] = []
    for (const track of [...(previous?.tracks ?? []), ...playlist.tracks]) {
      const key = trackKey(track)
      if (seen.has(key)) continue
      seen.add(key)
      tracks.push({ ...track, ...updates.get(key) })
    }
    const merged: PlayList = {
      id: previous?.id ?? id,
      name: previous?.name ?? playlist.name,
      createdAt: previous?.createdAt ?? importedAt,
      tracks,
      coverUrl: playlist.coverUrl ?? previous?.coverUrl,
      importSource: { platform, playlistId: playlist.externalId, importedAt },
    }
    if (index >= 0) result[index] = merged
    else result.push(merged)
  }
  return result
}
