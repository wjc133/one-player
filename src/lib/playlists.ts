import type { MusicTrack, PlayList } from '../types'

export const playlistTrackKey = (track: MusicTrack): string => {
  if (track.source === 'local' && track.filePath) return `local:${track.filePath}`
  return `${track.source}:${track.songmid ?? track.id}`
}

export function mergeTracksIntoPlaylist(
  playlists: PlayList[],
  targetId: string,
  incoming: readonly MusicTrack[],
): PlayList[] {
  const target = playlists.find((playlist) => playlist.id === targetId)
  if (!target) throw new Error('目标歌单不存在，请重新选择')
  const seen = new Set(target.tracks.map(playlistTrackKey))
  const additions = incoming.filter((track) => {
    const key = playlistTrackKey(track)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return playlists.map((playlist) => playlist.id === targetId
    ? { ...playlist, tracks: [...playlist.tracks, ...additions] }
    : playlist)
}

export function mergePlaylists(
  playlists: PlayList[],
  sourceId: string,
  targetId: string,
  deleteSource = false,
): PlayList[] {
  if (sourceId === targetId) throw new Error('请选择其他歌单作为合并目标')
  const source = playlists.find((playlist) => playlist.id === sourceId)
  if (!source) throw new Error('原歌单不存在，请重新选择')
  const merged = mergeTracksIntoPlaylist(playlists, targetId, source.tracks)
  return deleteSource ? merged.filter((playlist) => playlist.id !== sourceId) : merged
}

export function renamePlaylist(
  playlists: PlayList[],
  playlistId: string,
  rawName: string,
): PlayList[] {
  const name = rawName.trim()
  if (!name) throw new Error('请输入歌单名称')
  if (!playlists.some((playlist) => playlist.id === playlistId)) {
    throw new Error('歌单不存在，请重新选择')
  }
  if (playlists.some((playlist) => playlist.id !== playlistId && playlist.name === name)) {
    throw new Error('已存在同名歌单')
  }
  return playlists.map((playlist) => playlist.id === playlistId ? { ...playlist, name } : playlist)
}
