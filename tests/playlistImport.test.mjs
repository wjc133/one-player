import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeImportedPlaylists } from '../src/lib/playlistImport.ts'

const track = (id, extra = {}) => ({ id: `wy_${id}`, source: 'wy', songmid: String(id), name: `歌曲 ${id}`, ...extra })
const playlist = (id, tracks) => ({ externalId: id, name: `歌单 ${id}`, coverUrl: null, tracks })

test('imports preserve playlist order and deduplicate song IDs', () => {
  const original = [{ id: 'default', name: '我的收藏', tracks: [], createdAt: 1 }]
  const result = mergeImportedPlaylists(original, 'wy', [
    playlist('20', [track(3), track(1), track(3), track(2)]),
    playlist('10', []),
  ], 100)
  assert.equal(original.length, 1)
  assert.deepEqual(result.map((item) => item.id), ['default', 'imported:wy:20', 'imported:wy:10'])
  assert.deepEqual(result[1].tracks.map((item) => item.songmid), ['3', '1', '2'])
  assert.deepEqual(result[1].importSource, { platform: 'wy', playlistId: '20', importedAt: 100 })
})

test('reimporting merges in place and preserves local additions, names and file paths', () => {
  const first = mergeImportedPlaylists([], 'wy', [playlist('20', [track(3, { filePath: '/music/3.flac' }), track(1)])], 100)
  first[0].name = '自己改的名称'
  first[0].tracks.push(track(9))
  const second = mergeImportedPlaylists(first, 'wy', [playlist('20', [track(1, { name: '刷新后的歌名' }), track(2), track(3)])], 200)
  assert.equal(second.length, 1)
  assert.equal(second[0].name, '自己改的名称')
  assert.equal(second[0].createdAt, 100)
  assert.equal(second[0].importSource.importedAt, 200)
  assert.deepEqual(second[0].tracks.map((item) => item.songmid), ['3', '1', '9', '2'])
  assert.equal(second[0].tracks[0].filePath, '/music/3.flac')
  assert.equal(second[0].tracks[1].name, '刷新后的歌名')
})

test('same names and remote IDs from different platforms remain distinct', () => {
  const existing = [{ id: 'mine', name: '歌单 20', tracks: [], createdAt: 1 }]
  const first = mergeImportedPlaylists(existing, 'wy', [playlist('20', [])])
  const second = mergeImportedPlaylists(first, 'tx', [playlist('20', [])])
  assert.equal(second.length, 3)
  assert.equal(second[0], existing[0])
})
