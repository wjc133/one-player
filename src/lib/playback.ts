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
