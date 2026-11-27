import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let providers
let requests
let responses
const settings = { proxy: '' }

before(async () => {
  globalThis.DOMParser = class {
    parseFromString(text) {
      return { body: { textContent: text } }
    }
  }
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command, { payload }) => {
        assert.equal(command, 'proxy_http_request')
        requests.push(new URL(payload.url))
        assert(responses.length, 'unexpected network request')
        const response = responses.shift()
        return { statusCode: 200, bodyText: typeof response === 'string' ? response : JSON.stringify(response) }
      },
    },
  }
  server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, ws: false, watch: null },
  })
  providers = await server.ssrLoadModule('/src/lib/providers.ts')
})

after(async () => {
  await server?.close()
  delete globalThis.window
  delete globalThis.DOMParser
})

test('Kuwo uses the selected artist ID and the catalog total for pagination', async () => {
  requests = []
  responses = [
    "{'TOTAL':'2','BASEPICPATH':'http://img1.kuwo.cn/star/starheads/','abslist':[{'ARTISTID':'336','ARTIST':'周杰伦','hts_PICPATH':'//img4.kuwo.cn/star/starheads/240/avatar.jpg','desc':'歌手简介'},{'ARTISTID':'999','ARTIST':'周杰伦','PICPATH':'120/another.jpg'}]}",
    { total: '21', albumlist: [
      { albumid: '123', name: '较早发行', pub: '2001-01-01', musiccnt: '12' },
      { albumid: '124', name: '最近发行', pub: '2026-03-25' },
    ] },
  ]
  const { list } = await providers.searchArtists('kw', '周杰伦', 1, settings)
  assert.deepEqual(list.map((artist) => artist.id), ['336', '999'])
  assert.deepEqual(list.map((artist) => artist.img), [
    'https://img4.kuwo.cn/star/starheads/240/avatar.jpg',
    'https://img1.kuwo.cn/star/starheads/120/another.jpg',
  ])
  assert.equal(requests[0].searchParams.get('ft'), 'artist')
  assert.equal(requests[0].searchParams.get('all'), '周杰伦')
  assert.equal((await providers.getArtistProfile(list[0], settings)).bio, '歌手简介')

  const albums = await providers.createArtistAlbumLoader(list[1], settings)(1)
  assert.equal(requests[1].searchParams.get('stype'), 'albumlist')
  assert.equal(requests[1].searchParams.get('artistid'), '999')
  assert.equal(requests[1].searchParams.get('pn'), '0')
  assert.deepEqual(albums.list.map(({ id, name, songCount }) => [id, name, songCount]), [
    ['124', '最近发行', undefined],
    ['123', '较早发行', 12],
  ])
  assert.equal(albums.hasMore, true)
})

test('Kugou artist search returns avatars and preserves pagination', async () => {
  requests = []
  responses = [{
    status: 1,
    data: {
      total: 25,
      lists: [{ AuthorId: 3520, AuthorName: '周杰伦', Avatar: 'http://singerimg.kugou.com/{size}/avatar.jpg', AlbumCount: 49 }],
    },
  }]
  const result = await providers.searchArtists('kg', '周杰伦', 2, settings)
  assert.equal(requests[0].pathname, '/author_search')
  assert.equal(requests[0].searchParams.get('page'), '2')
  assert.equal(result.allPage, 2)
  assert.deepEqual(result.list, [{
    id: '3520', name: '周杰伦', source: 'kg', img: 'https://singerimg.kugou.com/400/avatar.jpg', albumCount: 49,
  }])
})

test('QQ album pagination handles responses that include more than the requested page', async () => {
  requests = []
  const artist = { id: 'singer-mid', name: '歌手', source: 'tx', img: null }
  const albums = Array.from({ length: 22 }, (_, index) => ({
    albumMid: `album-mid-${index}`,
    albumName: `专辑 ${index}`,
  }))
  responses = [
    { code: 0, albums: { code: 0, data: { total: 22, albumList: albums } } },
    { code: 0, albums: { code: 0, data: { total: 22, albumList: albums.slice(20) } } },
  ]
  const loadAlbums = providers.createArtistAlbumLoader(artist, settings)
  const firstPage = await loadAlbums(1)
  const secondPage = await loadAlbums(2)
  assert.equal(firstPage.list.length, 20)
  assert.equal(firstPage.hasMore, true)
  assert.deepEqual(secondPage.list.map((album) => album.albumMid), ['album-mid-20', 'album-mid-21'])
  assert.equal(secondPage.hasMore, false)
  const { albums: { param } } = JSON.parse(requests[1].searchParams.get('data'))
  assert.deepEqual(param, { singerMid: artist.id, order: 0, number: 20, begin: 20 })
})

test('Migu sorts releases across provider pages and reuses the catalog for navigation', async () => {
  requests = []
  const olderAlbums = Array.from({ length: 9 }, (_, index) => ({
    resId: `older-${index}`,
    txt: `较早发行 ${index}`,
    txt3: `200${index}-01-01`,
  }))
  responses = [
    { code: '000000', data: {
      header: { nextPageUrl: '/pc/bmw/singer/album/v1.0?singerId=100&pageNo=2' },
      contents: [...olderAlbums, { resId: 'unknown', txt: '暂无日期' }],
    } },
    { code: '000000', data: {
      contents: [{ resId: 'newest', txt: '最近发行', txt3: '2026-03-25' }],
    } },
  ]
  const artist = { id: '100', name: '歌手', source: 'mg', img: null }
  const loadAlbums = providers.createArtistAlbumLoader(artist, settings)
  const firstPage = await loadAlbums(1)
  const secondPage = await loadAlbums(2)
  assert.deepEqual(firstPage.list.map((album) => album.id), [
    'newest', ...olderAlbums.toReversed().map(({ resId }) => resId),
  ])
  assert.equal(firstPage.hasMore, true)
  assert.deepEqual(secondPage.list.map((album) => album.id), ['unknown'])
  assert.equal(secondPage.hasMore, false)
  assert.deepEqual(await loadAlbums(1), firstPage)
  assert.deepEqual(requests.map((url) => url.pathname), ['/pc/bmw/singer/album/v1.0', '/pc/bmw/singer/album/v1.0'])
  assert.deepEqual(requests.map((url) => url.searchParams.get('pageNo')), ['1', '2'])
})

test('Migu resolves digital albums to the song catalog while retaining the displayed album identity', async () => {
  requests = []
  responses = [
    { code: '000000', data: {} },
    { code: '000000', data: { materialId: '1142521343' } },
    { code: '000000', data: { songList: [{ songId: '101', copyrightId: '102', songName: '曲目', albumId: '1142521343' }] } },
  ]
  const album = { id: '600927015009001083', name: '专辑', singer: '歌手', source: 'mg', img: null }
  const detail = await providers.getAlbumDetail(album, settings)
  assert.equal(requests[0].searchParams.get('albumId'), album.id)
  assert.equal(requests[1].searchParams.get('dAlbumId'), album.id)
  assert.equal(requests[2].searchParams.get('albumId'), '1142521343')
  assert.equal(detail.album.id, album.id)
  assert.equal(detail.list[0].albumId, album.id)
  assert.equal(detail.list[0].copyrightId, '102')
})
