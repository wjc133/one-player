import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAppUpdater } from '../src/lib/appUpdater.ts'

function fixture(overrides = {}) {
  const calls = { checks: [], downloads: 0, installs: 0, restarts: 0, closes: 0 }
  const update = {
    version: '0.2.0',
    body: '更新说明',
    date: '2026-11-17T00:00:00Z',
    async download(onEvent, options) {
      calls.downloads++
      assert.equal(options.timeout, 600_000)
      onEvent({ event: 'Started', data: { contentLength: 100 } })
      onEvent({ event: 'Progress', data: { chunkLength: 45 } })
      onEvent({ event: 'Progress', data: { chunkLength: 55 } })
      onEvent({ event: 'Finished' })
    },
    async install() { calls.installs++ },
    async close() { calls.closes++ },
    ...overrides,
  }
  const updater = createAppUpdater({
    async check(options) { calls.checks.push(options); return update },
    async relaunch() { calls.restarts++ },
  })
  return { updater, update, calls }
}

test('checking uses the selected proxy and never downloads or installs automatically', async () => {
  const { updater, calls } = fixture()
  await updater.check('  http://127.0.0.1:7890  ')
  assert.deepEqual(calls.checks, [{ proxy: 'http://127.0.0.1:7890', timeout: 20_000 }])
  assert.equal(updater.getSnapshot().phase, 'available')
  assert.equal(updater.getSnapshot().release.notes, '更新说明')
  assert.equal(calls.downloads, 0)
  assert.equal(calls.installs, 0)
  assert.equal(calls.restarts, 0)
})

test('a downloaded update requires a separate installation action', async () => {
  const { updater, calls } = fixture()
  await updater.check('')
  await updater.install()
  assert.equal(calls.installs, 0)
  await updater.download()
  assert.equal(updater.getSnapshot().phase, 'ready')
  assert.equal(updater.getSnapshot().receivedBytes, 100)
  assert.equal(updater.getSnapshot().totalBytes, 100)
  assert.equal(calls.installs, 0)
  await updater.check('')
  assert.equal(calls.checks.length, 1)
  await updater.install()
  assert.equal(calls.installs, 1)
  assert.equal(calls.restarts, 1)
  assert.equal(calls.closes, 1)
})

test('concurrent checks are ignored and no-update responses are reported', async () => {
  let resolveCheck
  let checks = 0
  const updater = createAppUpdater({
    check() { checks++; return new Promise((resolve) => { resolveCheck = resolve }) },
    async relaunch() {},
  })
  const first = updater.check('')
  await updater.check('')
  assert.equal(checks, 1)
  resolveCheck(null)
  await first
  assert.equal(updater.getSnapshot().phase, 'current')
  assert.equal(updater.getSnapshot().release, null)
  assert(updater.getSnapshot().checkedAt)
})

test('network failures remain retryable and preserve a previously discovered update', async () => {
  const { update } = fixture()
  let fail = false
  const updater = createAppUpdater({
    async check() { if (fail) throw new Error('offline'); return update },
    async relaunch() {},
  })
  await updater.check('')
  fail = true
  await updater.check('')
  assert.equal(updater.getSnapshot().phase, 'available')
  assert.equal(updater.getSnapshot().release.version, '0.2.0')
  assert.match(updater.getSnapshot().error, /无法获取更新信息/)
  fail = false
  await updater.check('')
  assert.equal(updater.getSnapshot().error, '')
})

test('finished network transfers do not become installable until signature verification succeeds', async () => {
  const { updater, calls } = fixture({
    async download(onEvent) {
      onEvent({ event: 'Started', data: {} })
      onEvent({ event: 'Progress', data: { chunkLength: 100 } })
      onEvent({ event: 'Finished' })
      assert.equal(updater.getSnapshot().phase, 'downloading')
      assert.equal(updater.getSnapshot().totalBytes, null)
      throw new Error('signature mismatch')
    },
  })
  await updater.check('')
  await updater.download()
  assert.equal(updater.getSnapshot().phase, 'available')
  assert.match(updater.getSnapshot().error, /校验失败/)
  await updater.install()
  assert.equal(calls.installs, 0)
})

test('competing downloads and installation cannot run during a download', async () => {
  let resolveDownload
  let downloads = 0
  const { updater } = fixture({
    download() {
      downloads++
      return new Promise((resolve) => { resolveDownload = resolve })
    },
  })
  await updater.check('')
  const first = updater.download()
  await updater.download()
  await updater.install()
  assert.equal(downloads, 1)
  assert.equal(updater.getSnapshot().phase, 'downloading')
  resolveDownload()
  await first
  assert.equal(updater.getSnapshot().phase, 'ready')
})

test('failed installation permits a fresh download before retrying', async () => {
  let fail = true
  const { updater, calls } = fixture({
    async install() { if (fail) throw new Error('permission denied') },
  })
  await updater.check('')
  await updater.download()
  await updater.install()
  assert.equal(updater.getSnapshot().phase, 'available')
  assert.equal(calls.restarts, 0)
  assert.match(updater.getSnapshot().error, /安装更新失败/)
  fail = false
  await updater.download()
  await updater.install()
  assert.equal(calls.restarts, 1)
})

test('restart failures can be retried without installing twice', async () => {
  const { update, calls } = fixture()
  let fail = true
  const updater = createAppUpdater({
    async check() { return update },
    async relaunch() { if (fail) throw new Error('restart failed') },
  })
  await updater.check('')
  await updater.download()
  await updater.install()
  assert.equal(updater.getSnapshot().phase, 'installed')
  assert.match(updater.getSnapshot().error, /更新已安装/)
  await updater.install()
  assert.equal(calls.installs, 1)
  fail = false
  await updater.restart()
  assert.equal(updater.getSnapshot().phase, 'restarting')
})
