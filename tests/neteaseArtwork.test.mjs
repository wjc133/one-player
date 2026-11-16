import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let providers
let requests
let responses
const settings = { proxy: '' }
const cover = 'https://p1.music.126.net/cover/109951165566379710.jpg'
const track = {
  id: 'wy_186016', source: 'wy', songmid: '186016', name: '晴天',
  singer: '周杰伦', albumName: '叶惠美', img: null,
  types: [], _types: {}, typeUrl: {}, interval: '04:29',
}

before(async () => {
  globalThis.DOMParser = class {
    parseFromString(text) { return { body: { textContent: text } } }
  }
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command, { payload }) => {
        assert.equal(command, 'proxy_http_request')
        requests.push(payload)
        assert(responses.length, 'unexpected network request')
        return { statusCode: 200, bodyText: JSON.stringify(responses.shift()) }
      },
    },
  }
  server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, watch: null },
  })
  providers = await server.ssrLoadModule('/src/lib/providers.ts')
})

after(async () => {
  await server?.close()
  delete globalThis.window
  delete globalThis.DOMParser
})

test('song search returns HTTPS album covers and preserves pagination and identifiers', async () => {
  requests = []
  responses = [{ code: 200, result: { songCount: 91, songs: [{
    id: 186016, name: '晴天', ar: [{ name: '周杰伦' }], dt: 269000,
    al: { id: 18905, name: '叶惠美', picUrl: cover.replace('https:', 'http:') },
  }] } }]
  const result = await providers.searchMusic('wy', '晴天', 2, settings)
  const url = new URL(requests[0].url)
  assert.equal(url.pathname, '/api/cloudsearch/pc')
  assert.equal(url.searchParams.get('offset'), '30')
  assert.equal(url.searchParams.get('s'), '晴天')
  assert.equal(result.list[0].img, cover)
  assert.equal(result.list[0].songmid, '186016')
  assert.equal(result.list[0].singer, '周杰伦')
  assert.equal(result.list[0].interval, '04:29')
  assert.equal(result.allPage, 4)
})

test('existing saved songs without artwork resolve their original album cover', async () => {
  requests = []
  responses = [{ code: 200, songs: [{ id: 186016, album: { picUrl: cover } }] }]
  assert.equal(await providers.getBuiltinArtwork(track, settings), cover)
  const url = new URL(requests[0].url)
  assert.equal(url.pathname, '/api/song/detail/')
  assert.deepEqual(JSON.parse(url.searchParams.get('ids')), ['186016'])
})

test('existing artwork avoids a request and absent artwork remains empty', async () => {
  requests = []
  responses = []
  assert.equal(await providers.getBuiltinArtwork({ ...track, img: cover }, settings), cover)
  assert.equal(requests.length, 0)
  responses = [{ code: 200, songs: [] }]
  assert.equal(await providers.getBuiltinArtwork(track, settings), null)
})
