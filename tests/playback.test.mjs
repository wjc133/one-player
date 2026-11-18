import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getActiveLyricIndex,
  getNextTrackAfterFailure,
  playbackTrackKey,
  seekAudio,
} from '../src/lib/playback.ts'

test('failed tracks advance in queue order and consecutive failures are skipped', () => {
  const queue = ['first', 'second', 'third'].map(id => ({ source: 'wy', id }))
  const failed = new Set([playbackTrackKey(queue[0])])
  assert.equal(getNextTrackAfterFailure(queue, queue[0], failed, false), queue[1])
  failed.add(playbackTrackKey(queue[1]))
  assert.equal(getNextTrackAfterFailure(queue, queue[0], failed, false), queue[2])
  assert.equal(getNextTrackAfterFailure(queue, queue[1], failed, false), queue[2])
})

test('sequential failure recovery stops at the end without wrapping', () => {
  const queue = ['first', 'last'].map(id => ({ source: 'wy', id }))
  const failed = new Set([playbackTrackKey(queue[1])])
  assert.equal(getNextTrackAfterFailure(queue, queue[1], failed, false), null)
})

test('looping and repeat-one failure recovery can wrap to a different track', () => {
  const queue = ['first', 'last'].map(id => ({ source: 'wy', id }))
  const failed = new Set([playbackTrackKey(queue[1])])
  assert.equal(getNextTrackAfterFailure(queue, queue[1], failed, true), queue[0])
})

test('an entirely failed queue stops even with wrapping and duplicate tracks', () => {
  const queue = ['first', 'first', 'second'].map(id => ({ source: 'wy', id }))
  const failed = new Set(queue.map(playbackTrackKey))
  assert.equal(getNextTrackAfterFailure(queue, queue[0], failed, true), null)
  assert.equal(getNextTrackAfterFailure([queue[0]], queue[0], failed, true), null)
  assert.equal(getNextTrackAfterFailure([], queue[0], failed, true), null)
})

test('tracks with the same ID on different platforms fail independently', () => {
  const queue = [{ source: 'wy', id: 'same' }, { source: 'tx', id: 'same' }]
  const failed = new Set([playbackTrackKey(queue[0])])
  assert.equal(getNextTrackAfterFailure(queue, queue[0], failed, true), queue[1])
})

test('lyrics follow the actual timestamp without skipping closely spaced lines after seeking', () => {
  const lines = [{ time: 0 }, { time: 4 }, { time: 4.08 }, { time: 8 }]
  assert.equal(getActiveLyricIndex(lines, 3.999), 0)
  assert.equal(getActiveLyricIndex(lines, 4), 1)
  assert.equal(getActiveLyricIndex(lines, 4.079), 1)
  assert.equal(getActiveLyricIndex(lines, 4.08), 2)
  assert.equal(getActiveLyricIndex(lines, 8), 3)
  assert.equal(getActiveLyricIndex(lines, 2), 0)
  assert.equal(getActiveLyricIndex(lines, -1), -1)
  assert.equal(getActiveLyricIndex([], 10), -1)
})

test('seeking clamps to the media duration and ignores invalid timestamps', () => {
  const audio = { readyState: 4, duration: 20, currentTime: 6 }
  seekAudio(audio, -4)
  assert.equal(audio.currentTime, 0)
  seekAudio(audio, 40)
  assert.equal(audio.currentTime, 20)
  seekAudio(audio, 4.08)
  assert.equal(audio.currentTime, 4.08)
  seekAudio(audio, NaN)
  seekAudio(audio, Infinity)
  assert.equal(audio.currentTime, 4.08)
})

test('seeking before metadata is available leaves the current position intact', () => {
  const audio = { readyState: 0, duration: NaN, currentTime: 0 }
  assert.throws(() => seekAudio(audio, 4), /尚未加载/)
  assert.equal(audio.currentTime, 0)
})

test('seeking preserves the player pause state and lets the media choose the accepted position', () => {
  let position = 2
  const audio = {
    readyState: 4,
    duration: 20,
    paused: true,
    get currentTime() { return position },
    set currentTime(value) { position = Math.floor(value) },
  }
  seekAudio(audio, 6.7)
  assert.equal(audio.currentTime, 6)
  assert.equal(audio.paused, true)
})
