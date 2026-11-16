import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tagSearchQuery, walkmanTagStatus } from '../src/lib/walkman.ts'

test('tag search uses existing metadata when it is available', () => {
  assert.equal(tagSearchQuery({ title: '风花雪', artist: '陈慧琳', relativePath: 'Kelly Chen Collection/05 - track.dsf', missingFields: [] }), '陈慧琳 风花雪')
})

test('tag search normalizes legacy filenames and nested Windows paths', () => {
  assert.equal(tagSearchQuery({ title: '', artist: '', relativePath: '未归类\\02 - 周笔畅+-+笔记.wav', missingFields: ['歌曲名', '歌手'] }), '周笔畅 - 笔记')
})

test('tag search avoids repeating the artist inferred from a filename', () => {
  assert.equal(tagSearchQuery({ title: '咏爱', artist: '詹雯婷', relativePath: 'Faye 飞/詹雯婷 - 咏爱.flac', missingFields: ['歌曲名', '歌手', '专辑'] }), '詹雯婷 咏爱')
})

test('status distinguishes inferred names from unknown information and missing cover', () => {
  assert.deepEqual(walkmanTagStatus({ inferredFields: ['歌曲名', '歌手'], missingFields: ['歌曲名', '歌手', '专辑', '封面'] }), ['文件名已识别，待写入歌曲名、歌手', '待补全专辑、封面'])
  assert.deepEqual(walkmanTagStatus({ inferredFields: [], missingFields: ['封面'] }), ['待补全封面'])
  assert.deepEqual(walkmanTagStatus({ inferredFields: [], missingFields: [] }), [])
})
