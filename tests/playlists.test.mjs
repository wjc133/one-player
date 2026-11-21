import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergePlaylists, mergeTracksIntoPlaylist, renamePlaylist } from '../src/lib/playlists.ts'

const track = (id, extra = {}) => ({ id: `wy_${id}`, source: 'wy', songmid: String(id), name: `歌曲 ${id}`, ...extra })
const playlist = (id, tracks = [], extra = {}) => ({ id, name: `歌单 ${id}`, tracks, createdAt: 10, ...extra })

test('merging preserves both playlists and appends unique source songs in order', () => {
  const source = playlist('source', [track(2), track(3), track(3), track(4)])
  const target = playlist('target', [track(1), track(2, { filePath: '/music/2.flac' })], {
    coverUrl: 'https://fixture.test/target.jpg',
    importSource: { platform: 'wy', playlistId: 'remote-target', importedAt: 100 },
  })
  const existing = [source, target, playlist('other')]
  const result = mergePlaylists(existing, 'source', 'target')
  assert.equal(result.length, 3)
  assert.equal(result[0], source)
  assert.equal(result[2], existing[2])
  assert.deepEqual(result[1].tracks.map((item) => item.songmid), ['1', '2', '3', '4'])
  assert.equal(result[1].tracks[1].filePath, '/music/2.flac')
  assert.equal(result[1].coverUrl, target.coverUrl)
  assert.equal(result[1].createdAt, target.createdAt)
  assert.equal(result[1].importSource, target.importSource)
  assert.equal(target.tracks.length, 2)
})

test('multiple imported playlists merge into one existing target without creating playlists', () => {
  const existing = [playlist('target', [track(1)]), playlist('untouched')]
  const incoming = [
    { tracks: [track(2), track(1)] },
    { tracks: [track(3), track(2), track(4)] },
  ]
  const result = mergeTracksIntoPlaylist(existing, 'target', incoming.flatMap((item) => item.tracks))
  assert.deepEqual(result.map((item) => item.id), ['target', 'untouched'])
  assert.deepEqual(result[0].tracks.map((item) => item.songmid), ['1', '2', '3', '4'])
  assert.equal(result[1], existing[1])
  assert.equal(result[0].importSource, undefined)
})

test('merged track identities distinguish platforms and local file paths', () => {
  const local = (path) => track('local', { source: 'local', filePath: path, isLocalLibrary: true })
  const existing = [playlist('target', [track(1), local('/music/a.flac')])]
  const result = mergeTracksIntoPlaylist(existing, 'target', [
    track(1),
    track(1, { source: 'tx', id: 'tx_1' }),
    local('/music/a.flac'),
    local('/music/b.flac'),
  ])
  assert.equal(result[0].tracks.length, 4)
  assert.equal(result[0].tracks[2].source, 'tx')
  assert.equal(result[0].tracks[3].filePath, '/music/b.flac')
})

test('empty merges and repeated merges do not remove or duplicate songs', () => {
  const existing = [playlist('source', [track(1)]), playlist('target', [track(2)])]
  const first = mergePlaylists(existing, 'source', 'target')
  const second = mergePlaylists(first, 'source', 'target')
  assert.deepEqual(second[1].tracks.map((item) => item.songmid), ['2', '1'])
  assert.deepEqual(mergeTracksIntoPlaylist(second, 'target', [])[1].tracks, second[1].tracks)
})

test('merging rejects self merges and missing playlists without changing the source', () => {
  const existing = [playlist('source', [track(1)])]
  assert.throws(() => mergePlaylists(existing, 'source', 'source'), /其他歌单/)
  assert.throws(() => mergePlaylists(existing, 'missing', 'source'), /原歌单不存在/)
  assert.throws(() => mergePlaylists(existing, 'source', 'missing'), /目标歌单不存在/)
  assert.equal(existing[0].tracks.length, 1)
})

test('merging can delete the source playlist after adding unique songs', () => {
  const existing = [playlist('source', [track(1), track(2)]), playlist('target', [track(2), track(3)])]
  const result = mergePlaylists(existing, 'source', 'target', true)
  assert.deepEqual(result.map((item) => item.id), ['target'])
  assert.deepEqual(result[0].tracks.map((item) => item.songmid), ['2', '3', '1'])
  assert.equal(existing.length, 2)
})

test('renaming trims the name and preserves IDs, tracks and import metadata', () => {
  const original = playlist('source', [track(1)], {
    importSource: { platform: 'lx', playlistId: 'one', importedAt: 100 },
  })
  const result = renamePlaylist([original, playlist('other')], 'source', '  新名称  ')
  assert.equal(result[0].name, '新名称')
  assert.equal(result[0].id, original.id)
  assert.equal(result[0].tracks, original.tracks)
  assert.equal(result[0].importSource, original.importSource)
  assert.equal(original.name, '歌单 source')
  assert.equal(renamePlaylist(result, 'source', '新名称')[0].name, '新名称')
})

test('renaming rejects blank names, duplicates and missing playlists', () => {
  const existing = [playlist('source'), playlist('other')]
  assert.throws(() => renamePlaylist(existing, 'source', '  '), /请输入/)
  assert.throws(() => renamePlaylist(existing, 'source', '歌单 other'), /同名/)
  assert.throws(() => renamePlaylist(existing, 'missing', 'new'), /不存在/)
})
