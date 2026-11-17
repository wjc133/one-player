import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSafeStorage } from '../src/lib/storage.ts'

test('unavailable localStorage does not throw during startup reads, writes or cleanup', () => {
  const failures = []
  const storage = createSafeStorage(() => {
    throw new DOMException('Access denied', 'SecurityError')
  }, (error) => failures.push(error))

  assert.equal(storage.getItem('settings'), null)
  storage.setItem('settings', '{"theme":"light"}')
  assert.equal(storage.getItem('settings'), '{"theme":"light"}')
  storage.removeItem('settings')
  assert.equal(storage.getItem('settings'), null)
  assert.equal(failures.length, 1)
  assert(failures.every((error) => error.name === 'SecurityError'))
})

test('quota failures retain session changes and later successful writes resume persistence', () => {
  const persisted = new Map([['settings', 'original']])
  let full = true
  const failures = []
  const storage = createSafeStorage(() => ({
    getItem: (key) => persisted.get(key) ?? null,
    setItem(key, value) {
      if (full) throw new DOMException('Quota exceeded', 'QuotaExceededError')
      persisted.set(key, value)
    },
    removeItem(key) { persisted.delete(key) },
  }), (error) => failures.push(error))

  assert.equal(storage.getItem('settings'), 'original')
  storage.setItem('settings', 'session change')
  assert.equal(storage.getItem('settings'), 'session change')
  assert.equal(persisted.get('settings'), 'original')
  full = false
  storage.setItem('settings', 'saved change')
  assert.equal(storage.getItem('settings'), 'saved change')
  assert.equal(persisted.get('settings'), 'saved change')
  storage.removeItem('settings')
  assert.equal(storage.getItem('settings'), null)
  assert.equal(persisted.has('settings'), false)
  assert.equal(failures.length, 1)
})

test('failed cleanup hides removed values for this session without deleting persisted data', () => {
  const persisted = new Map([['legacy', 'existing playlist']])
  const storage = createSafeStorage(() => ({
    getItem: (key) => persisted.get(key) ?? null,
    setItem(key, value) { persisted.set(key, value) },
    removeItem() { throw new Error('Storage unavailable') },
  }))

  storage.removeItem('legacy')
  assert.equal(storage.getItem('legacy'), null)
  assert.equal(persisted.get('legacy'), 'existing playlist')
})

test('startup defaults never overwrite settings that could not be read', () => {
  const persisted = new Map([['settings', '{"theme":"light"}']])
  let denyRead = true
  const storage = createSafeStorage(() => ({
    getItem(key) {
      if (denyRead) throw new DOMException('Access denied', 'SecurityError')
      return persisted.get(key) ?? null
    },
    setItem(key, value) { persisted.set(key, value) },
    removeItem(key) { persisted.delete(key) },
  }))

  assert.equal(storage.getItem('settings'), null)
  denyRead = false
  storage.setItem('settings', '{"theme":"dark"}')
  assert.equal(storage.getItem('settings'), '{"theme":"dark"}')
  assert.equal(persisted.get('settings'), '{"theme":"light"}')
})
