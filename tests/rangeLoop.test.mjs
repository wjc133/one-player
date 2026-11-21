import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getLoopSeekTarget, getLyricRanges, markRangeLoopPoint, resolveRangeLoop } from '../src/lib/rangeLoop.ts'

const lyrics = getLyricRanges([10, 17, 21, 26].map((time) => ({ time })), 28)
const points = (start, end) => ({ kind: 'points', start, end })
const lineSelection = (...indices) => ({ kind: 'lyrics', indices: new Set(indices) })

test('the out mark requires a preceding in mark and cannot replace it with an inverted range', () => {
  assert.equal(markRangeLoopPoint(null, null, 'end', 20), null)
  const empty = points(null, null)
  assert.equal(markRangeLoopPoint(empty, null, 'end', 20), empty)
  const pending = { ...points(13, null), unit: 'lyric' }
  assert.equal(markRangeLoopPoint(pending, null, 'end', 12), pending)
  assert.deepEqual(markRangeLoopPoint(pending, null, 'end', 20), { ...pending, end: 20 })
})

test('moving the in mark to or past the out mark clears it without leaving range mode', () => {
  const selection = { ...points(13, 20), unit: 'free' }
  assert.deepEqual(markRangeLoopPoint(selection, null, 'start', 17), { ...selection, start: 17 })
  assert.deepEqual(markRangeLoopPoint(selection, null, 'start', 20), { ...selection, start: 20, end: null })
  assert.deepEqual(markRangeLoopPoint(selection, { start: 10, end: 17 }, 'start', 18), { ...selection, start: 18, end: null })
  assert.deepEqual(markRangeLoopPoint(lineSelection(2), { start: 21, end: 26 }, 'end', 27), {
    ...points(21, 27), unit: undefined,
  })
})

test('lyric units snap both markers to the closest lyric boundaries', () => {
  const selection = points(13, 20)
  const snapped = resolveRangeLoop(selection, 'lyric', lyrics)
  assert.deepEqual(snapped.ranges, [{ start: 10, end: 21 }])
  assert.deepEqual([...snapped.lyricIndices], [0, 1])
  assert.deepEqual(resolveRangeLoop(selection, 'free', lyrics).ranges, [{ start: 13, end: 20 }])
  assert.deepEqual(resolveRangeLoop(selection, 'lyric', []).ranges, [{ start: 13, end: 20 }])
})

test('markers snapping to the same timestamp choose the closer full lyric', () => {
  assert.deepEqual(resolveRangeLoop(points(16.9, 17.1), 'lyric', lyrics).ranges, [{ start: 17, end: 21 }])
  assert.deepEqual(resolveRangeLoop(points(20.9, 21.1), 'lyric', lyrics).ranges, [{ start: 17, end: 21 }])
})

test('empty, incomplete, equal or reversed markers keep the loop inactive', () => {
  for (const selection of [points(null, null), points(null, 17), points(17, null), points(17, 17), points(17, 10)]) {
    assert.deepEqual(resolveRangeLoop(selection, 'lyric', lyrics).ranges, [])
  }
  assert.deepEqual(resolveRangeLoop(lineSelection(), 'free', lyrics).ranges, [])
})

test('adjacent lyric lines play continuously and unselected gaps are skipped', () => {
  const loop = resolveRangeLoop(lineSelection(3, 0, 1), 'free', lyrics)
  assert.deepEqual(loop.ranges, [{ start: 10, end: 21 }, { start: 26, end: 28 }])
  assert.equal(getLoopSeekTarget(loop.ranges, 5), 10)
  assert.equal(getLoopSeekTarget(loop.ranges, 10), null)
  assert.equal(getLoopSeekTarget(loop.ranges, 17), null)
  assert.equal(getLoopSeekTarget(loop.ranges, 21), 26)
  assert.equal(getLoopSeekTarget(loop.ranges, 25.99), 26)
  assert.equal(getLoopSeekTarget(loop.ranges, 27.99), null)
  assert.equal(getLoopSeekTarget(loop.ranges, 28), 10)
})

test('duplicate lyric timestamps share a range and lines at or after the track end have no audio', () => {
  const ranges = getLyricRanges([0, 2, 2, 4, 6, 7].map((time) => ({ time })), 6)
  assert.deepEqual(ranges, [
    { start: 0, end: 2 }, { start: 2, end: 4 }, { start: 2, end: 4 }, { start: 4, end: 6 }, null, null,
  ])
  assert.deepEqual(resolveRangeLoop(lineSelection(2, 4), 'lyric', ranges).ranges, [{ start: 2, end: 4 }])
})
