import assert from 'node:assert/strict'
import { test } from 'node:test'
import { updateSourceFromUrl } from '../src/lib/sourceUpdater.ts'

const script = '/**\n * @name 测试音源\n * @version 2.0.0\n */\nlx.send(lx.EVENT_NAMES.inited, {})'
const source = {
  id: 'existing-source',
  name: '测试音源',
  description: '',
  version: '2.0.0',
  author: '',
  homepage: '',
  allowShowUpdateAlert: false,
}

function fixture(overrides = {}) {
  const calls = []
  const runtime = {
    async initialize(info, content) {
      calls.push(['initialize', info, content])
      return { kw: { type: 'music', actions: ['musicUrl'], qualitys: ['320k'] } }
    },
    dispose() { calls.push(['dispose']) },
    ...overrides.runtime,
  }
  const dependencies = {
    async request(payload) {
      calls.push(['request', payload])
      return { statusCode: 200, bodyText: script, ...overrides.response }
    },
    async inspect(id, content) {
      calls.push(['inspect', id, content])
      if (overrides.inspectError) throw new Error(overrides.inspectError)
      return source
    },
    async save(id, content) {
      calls.push(['save', id, content])
      if (overrides.saveError) throw new Error(overrides.saveError)
      return source
    },
    createRuntime(info) {
      calls.push(['createRuntime', info])
      return runtime
    },
    async openExternalUrl(url) { calls.push(['openExternalUrl', url]) },
    ...overrides.dependencies,
  }
  const update = () => updateSourceFromUrl(
    source.id,
    'https://example.com/source.js',
    '  http://127.0.0.1:7890  ',
    dependencies,
  )
  return { update, calls, runtime, dependencies }
}

test('source updates use the proxy and initialize the replacement before saving it in place', async () => {
  const { update, calls, runtime } = fixture()
  const result = await update()
  assert.deepEqual(calls.map(([name]) => name), ['request', 'inspect', 'createRuntime', 'initialize', 'save'])
  assert.deepEqual(calls[0][1], {
    url: 'https://example.com/source.js',
    proxy: 'http://127.0.0.1:7890',
    timeoutMs: 30_000,
  })
  assert.deepEqual(calls[4], ['save', source.id, script])
  assert.equal(result.source.id, source.id)
  assert.equal(result.source.allowShowUpdateAlert, false)
  assert.equal(result.runtime, runtime)
  assert.deepEqual(result.capabilities.kw.actions, ['musicUrl'])
})

test('HTTP failures never reach source inspection or storage', async () => {
  const { update, calls } = fixture({ response: { statusCode: 503 } })
  await assert.rejects(update(), /HTTP 503/)
  assert.deepEqual(calls.map(([name]) => name), ['request'])
})

test('non-script update links open in the default browser without replacing the source', async () => {
  for (const response of [
    { bodyText: '<html>下载页面</html>' },
    { statusCode: 403, bodyText: '<html>请在浏览器中继续</html>' },
    { bodyText: '' },
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    { bodyText: '{"url":"https://example.com/source.js"}' },
  ]) {
    const { update, calls } = fixture({ response })
    assert.deepEqual(await update(), { kind: 'browser' })
    assert.deepEqual(calls.map(([name]) => name), ['request', 'openExternalUrl'])
    assert.equal(calls[1][1], 'https://example.com/source.js')
  }
})

test('browser launch failures remain visible for retry', async () => {
  const { update } = fixture({
    response: { bodyText: '<html>下载页面</html>' },
    dependencies: { async openExternalUrl() { throw new Error('无法打开默认浏览器') } },
  })
  await assert.rejects(update(), /无法打开默认浏览器/)
})

test('network and metadata errors leave the existing source untouched', async () => {
  for (const overrides of [
    { dependencies: { async request() { throw new Error('offline') } } },
    { inspectError: '无效的自定义源文件' },
  ]) {
    const { update, calls } = fixture(overrides)
    await assert.rejects(update(), /offline|无效的自定义源文件/)
    assert(!calls.some(([name]) => name === 'save' || name === 'createRuntime'))
  }
})

test('initialization failures dispose the candidate without saving it', async () => {
  let disposed = false
  const { update, calls } = fixture({
    runtime: {
      async initialize() { throw new Error('脚本初始化失败') },
      dispose() { disposed = true },
    },
  })
  await assert.rejects(update(), /脚本初始化失败/)
  assert(disposed)
  assert(!calls.some(([name]) => name === 'save'))
})

test('storage failures dispose the candidate so the original runtime can continue', async () => {
  const { update, calls } = fixture({ saveError: '写入失败' })
  await assert.rejects(update(), /写入失败/)
  assert.equal(calls.at(-1)[0], 'dispose')
})

test('downloads tolerate a UTF-8 BOM and empty proxies', async () => {
  const { dependencies, calls } = fixture({ response: { bodyText: `\uFEFF\n${script}` } })
  await updateSourceFromUrl(source.id, 'https://example.com/source.js', '  ', dependencies)
  assert.equal(calls[0][1].proxy, undefined)
  assert.equal(calls[1][2], script)
})

test('non-HTTP update addresses never start a download', async () => {
  const { dependencies, calls } = fixture()
  await assert.rejects(
    updateSourceFromUrl(source.id, 'file:///tmp/source.js', '', dependencies),
    /HTTP 或 HTTPS/,
  )
  assert.equal(calls.length, 0)
})
