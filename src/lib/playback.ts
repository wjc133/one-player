interface PlaybackTrack {
  source: string
  id: string
}

export const playbackTrackKey = (track: PlaybackTrack): string =>
  `${track.source}:${track.id}`

export function getNextTrackAfterFailure<Track extends PlaybackTrack>(
  queue: readonly Track[],
  currentTrack: Track,
  failedTrackKeys: ReadonlySet<string>,
  wrap: boolean,
): Track | null {
  const currentKey = playbackTrackKey(currentTrack)
  const currentIndex = queue.findIndex(
    (track) => playbackTrackKey(track) === currentKey,
  )
  for (let offset = 1; offset <= queue.length; offset += 1) {
    const nextIndex = currentIndex + offset
    if (!wrap && nextIndex >= queue.length) break
    const track = queue[nextIndex % queue.length]
    if (!failedTrackKeys.has(playbackTrackKey(track))) return track
  }
  return null
}

export function getActiveLyricIndex(
  lines: ReadonlyArray<{ time: number }>,
  currentTime: number,
): number {
  let active = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].time > currentTime) break
    active = index
  }
  return active
}

export function seekAudio(audio: HTMLMediaElement, target: number): void {
  if (!Number.isFinite(target)) return
  if (audio.readyState < 1) {
    throw new Error('音频尚未加载完成，请稍后再跳转')
  }
  const end = Number.isFinite(audio.duration) ? audio.duration : Infinity
  audio.currentTime = Math.max(0, Math.min(target, end))
}
