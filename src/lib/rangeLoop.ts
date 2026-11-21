import type { RangeLoopUnit } from '../types'

export interface PlaybackRange {
  start: number
  end: number
}

interface LoopPoints {
  start: number | null
  end: number | null
}

export type RangeLoopSelection = (
  | ({ kind: 'points' } & LoopPoints)
  | { kind: 'lyrics'; indices: ReadonlySet<number> }
) & { unit?: RangeLoopUnit }

export interface RangeLoop extends LoopPoints {
  ranges: PlaybackRange[]
  lyricIndices: ReadonlySet<number>
}

export function markRangeLoopPoint(
  selection: RangeLoopSelection | null,
  visiblePoints: LoopPoints | null,
  point: keyof LoopPoints,
  time: number,
): RangeLoopSelection | null {
  const { start = null, end = null } = (selection?.kind === 'points' ? selection : visiblePoints) ?? {}
  if (point === 'end') {
    if (start === null || time <= start) return selection
    return { kind: 'points', start, end: time, unit: selection?.unit }
  }
  const limit = Math.min(end ?? Infinity, visiblePoints?.end ?? Infinity)
  return { kind: 'points', start: time, end: time < limit ? end : null, unit: selection?.unit }
}

export function getLyricRanges(
  lines: ReadonlyArray<{ time: number }>,
  duration: number,
): Array<PlaybackRange | null> {
  let nextRange: PlaybackRange | null = null
  const ranges = new Array<PlaybackRange | null>(lines.length)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const start = lines[index].time
    if (start >= duration) {
      ranges[index] = null
      continue
    }
    // LRC gives each line a start time. Lines with the same timestamp share an interval.
    const end: number = nextRange?.start === start ? nextRange.end : nextRange?.start ?? duration
    nextRange = { start, end }
    ranges[index] = nextRange
  }
  return ranges
}

function closestLyricRange(
  ranges: ReadonlyArray<PlaybackRange | null>,
  time: number,
  point: keyof PlaybackRange,
): PlaybackRange | null {
  let closest: PlaybackRange | null = null
  let distance = Infinity
  for (const range of ranges) {
    if (!range) continue
    const nextDistance = Math.abs(range[point] - time)
    if (nextDistance < distance || (point === 'end' && nextDistance === distance)) {
      closest = range
      distance = nextDistance
    }
  }
  return closest
}

export function resolveRangeLoop(
  selection: RangeLoopSelection,
  unit: RangeLoopUnit,
  lyricRanges: ReadonlyArray<PlaybackRange | null>,
): RangeLoop {
  const ranges: PlaybackRange[] = []
  if (selection.kind === 'lyrics') {
    lyricRanges.forEach((range, index) => {
      if (!range || !selection.indices.has(index)) return
      const last = ranges.at(-1)
      if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
      else ranges.push({ ...range })
    })
    return {
      start: ranges[0]?.start ?? null,
      end: ranges.at(-1)?.end ?? null,
      ranges,
      lyricIndices: selection.indices,
    }
  }

  const { start, end } = selection
  const lyricIndices = new Set<number>()
  if (start !== null && end !== null && end <= start) {
    return { start, end, ranges, lyricIndices }
  }
  const first = unit === 'lyric' && start !== null ? closestLyricRange(lyricRanges, start, 'start') : null
  const last = unit === 'lyric' && end !== null ? closestLyricRange(lyricRanges, end, 'end') : null
  let loopStart = first?.start ?? start
  let loopEnd = last?.end ?? end
  if (start !== null && end !== null && loopStart !== null && loopEnd !== null) {
    // If both points snap to the same boundary, use the closer complete lyric line.
    if (first && last && loopEnd <= loopStart) {
      const moveStart = Math.abs(last.start - start) - Math.abs(first.start - start)
      const moveEnd = Math.abs(first.end - end) - Math.abs(last.end - end)
      if (moveStart < moveEnd) loopStart = last.start
      else loopEnd = first.end
    }
    const range = { start: loopStart, end: loopEnd }
    ranges.push(range)
    lyricRanges.forEach((line, index) => {
      if (line && line.start < range.end && line.end > range.start) lyricIndices.add(index)
    })
  }
  return { start: loopStart, end: loopEnd, ranges, lyricIndices }
}

export function getLoopSeekTarget(ranges: readonly PlaybackRange[], position: number): number | null {
  const next = ranges.find((range) => position < range.end)
  if (!next) return ranges[0]?.start ?? null
  return position < next.start ? next.start : null
}
