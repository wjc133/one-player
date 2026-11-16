import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/collect-release-assets.mjs', import.meta.url))

function withInstaller(name, bundles, callback) {
  const directory = mkdtempSync(join(tmpdir(), 'one-player-release-test-'))
  try {
    const path = join(directory, name)
    const bytes = Buffer.from('installer fixture\0with binary bytes\xff', 'latin1')
    writeFileSync(path, bytes)
    const result = spawnSync(process.execPath, [script], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        TAURI_ARTIFACT_PATHS: JSON.stringify([path]),
        RELEASE_BUNDLES: bundles,
      },
    })
    callback(directory, bytes, result)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('release filenames match GitHub downloads and preserve installer checksums', () => {
  withInstaller('One Player_0.1.0_aarch64.dmg', 'dmg', (directory, original, result) => {
    assert.equal(result.status, 0, result.stderr)
    const bundles = join(directory, 'release-bundles')
    const name = 'One.Player_0.1.0_aarch64.dmg'
    assert.deepEqual(readdirSync(bundles), [name])
    const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
    assert.equal(sha256(readFileSync(join(bundles, name))), sha256(original))
  })
})

test('an incomplete Windows installer set fails before publishing', () => {
  withInstaller('One Player_0.1.0_x64-setup.exe', 'nsis,msi', (_directory, _bytes, result) => {
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Missing installer: \.msi/)
  })
})
