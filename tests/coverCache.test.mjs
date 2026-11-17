import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'

let server
let cache
let requests = []
let response

before(async () => {
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke(command, args) {
        assert.equal(command, 'get_cached_cover')
        requests.push(args)
        return response(args)
      },
    },
  }
  server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, watch: null },
  })
  cache = await server.ssrLoadModule('/src/lib/coverCache.ts')
})

after(async () => {
  await server?.close()
  delete globalThis.window
})

test('coalesces simultaneous display requests and reuses successful local URLs', async () => {
  requests = []
  response = async () => 'asset://localhost/cover-1.img'
  const url = 'https://covers.test/shared.png'
  const first = cache.createCoverSession('http://127.0.0.1:7890')
  const second = cache.createCoverSession('http://127.0.0.1:7890')
  assert.deepEqual(await Promise.all([first.load(url), second.load(url), first.load(url)]), [
    'asset://localhost/cover-1.img', 'asset://localhost/cover-1.img', 'asset://localhost/cover-1.img',
  ])
  assert.deepEqual(requests, [{ url, proxy: 'http://127.0.0.1:7890' }])
  assert.equal(await cache.createCoverSession().load(url), 'asset://localhost/cover-1.img')
  assert.equal(requests.length, 1)
})

test('keeps failures within one opening and retries on the next opening', async () => {
  requests = []
  response = async () => { throw new Error('three attempts failed') }
  const url = 'https://covers.test/failing.png'
  const opening = cache.createCoverSession()
  await assert.rejects(opening.load(url), /three attempts/)
  await assert.rejects(opening.load(url), /three attempts/)
  assert.equal(requests.length, 1)
  assert.equal(cache.peekCover(url), null)
  response = async () => 'asset://localhost/recovered.img'
  assert.equal(await cache.createCoverSession().load(url), 'asset://localhost/recovered.img')
  assert.equal(requests.length, 2)
})

test('local embedded covers bypass HTTP and preserve original remote metadata', async () => {
  requests = []
  const url = 'data:image/png;base64,cG5n'
  assert.equal(await cache.createCoverSession().load(url), url)
  const track = { img: 'https://covers.test/original.png' }
  response = async () => 'asset://localhost/original.img'
  assert.equal(await cache.resolveCoverUrl(track.img), 'asset://localhost/original.img')
  assert.equal(track.img, 'https://covers.test/original.png')
  assert.equal(requests.length, 1)
})
