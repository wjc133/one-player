import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const collector = fileURLToPath(new URL('../scripts/collect-release-assets.mjs', import.meta.url))
const generator = fileURLToPath(new URL('../scripts/generate-updater-manifest.mjs', import.meta.url))
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const fixtures = {
  'aarch64-apple-darwin': [`One Player_${version}_aarch64.dmg`, 'One Player.app.tar.gz'],
  'x86_64-apple-darwin': [`One Player_${version}_x64.dmg`, 'One Player.app.tar.gz'],
  'x86_64-pc-windows-msvc': [`One Player_${version}_x64-setup.exe`, `One Player_${version}_x64_en-US.msi`],
  'x86_64-unknown-linux-gnu': [`One Player_${version}_amd64.deb`, `One Player_${version}_amd64.AppImage`],
}

function withDirectory(callback) {
  const directory = mkdtempSync(join(tmpdir(), 'one-player-release-test-'))
  try { callback(directory) }
  finally { rmSync(directory, { recursive: true, force: true }) }
}

function collect(directory, target, options = {}) {
  const inputDirectory = join(directory, target)
  mkdirSync(inputDirectory, { recursive: true })
  const paths = fixtures[target].filter((name) => name !== options.omit).map((name) => {
    const path = join(inputDirectory, name)
    writeFileSync(path, Buffer.from(`${target}:${name}\0binary bytes\xff`, 'latin1'))
    if (!name.endsWith('.dmg') && name !== options.unsigned) {
      writeFileSync(`${path}.sig`, options.emptySignature ? '' : `signature:${target}:${name}`)
    }
    return path
  })
  return spawnSync(process.execPath, [collector], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, RELEASE_TARGET: target, TAURI_ARTIFACT_PATHS: JSON.stringify(paths) },
  })
}

function generate(directory) {
  return spawnSync(process.execPath, [generator], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, RELEASE_TAG: `v${version}`, GITHUB_REPOSITORY: 'wjc133/one-player' },
  })
}

function collectAll(directory) {
  for (const target of Object.keys(fixtures)) {
    const result = collect(directory, target)
    assert.equal(result.status, 0, result.stderr)
  }
}

test('GitHub filenames preserve binary checksums and macOS update architectures remain distinct', () => {
  withDirectory((directory) => {
    collectAll(directory)
    const bundles = join(directory, 'release-bundles')
    const name = `One.Player_${version}_aarch64.dmg`
    const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
    assert.equal(
      sha256(readFileSync(join(bundles, name))),
      sha256(readFileSync(join(directory, 'aarch64-apple-darwin', fixtures['aarch64-apple-darwin'][0]))),
    )
    for (const arch of ['aarch64', 'x64']) {
      const archive = `One.Player_${version}_${arch}.app.tar.gz`
      assert(readdirSync(bundles).includes(archive))
      assert(readdirSync(bundles).includes(`${archive}.sig`))
    }
    assert.notDeepEqual(
      readFileSync(join(bundles, `One.Player_${version}_aarch64.app.tar.gz`)),
      readFileSync(join(bundles, `One.Player_${version}_x64.app.tar.gz`)),
    )
  })
})

test('an incomplete Windows installer set fails before publishing', () => {
  withDirectory((directory) => {
    const result = collect(directory, 'x86_64-pc-windows-msvc', { omit: `One Player_${version}_x64_en-US.msi` })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Missing installer: \.msi/)
  })
})

test('missing or empty updater signatures prevent collection', () => {
  for (const options of [{ unsigned: 'One Player.app.tar.gz' }, { emptySignature: true }]) {
    withDirectory((directory) => {
      const result = collect(directory, 'aarch64-apple-darwin', options)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /(?:Missing|Empty) updater signature/)
    })
  }
})

test('the unified manifest covers every architecture and preserves each installed package type', () => {
  withDirectory((directory) => {
    collectAll(directory)
    mkdirSync(join(directory, '.github/release-notes'), { recursive: true })
    writeFileSync(join(directory, `.github/release-notes/v${version}.md`), '新版本说明\n\n- 自动更新')
    const result = generate(directory)
    assert.equal(result.status, 0, result.stderr)
    const manifest = JSON.parse(readFileSync(join(directory, 'release-bundles/latest.json'), 'utf8'))
    assert.equal(manifest.version, version)
    assert.equal(manifest.notes, '新版本说明\n\n- 自动更新')
    assert(Number.isFinite(Date.parse(manifest.pub_date)))
    assert.deepEqual(Object.keys(manifest.platforms).sort(), [
      'darwin-aarch64', 'darwin-aarch64-app',
      'darwin-x86_64', 'darwin-x86_64-app',
      'linux-x86_64', 'linux-x86_64-appimage', 'linux-x86_64-deb',
      'windows-x86_64', 'windows-x86_64-msi', 'windows-x86_64-nsis',
    ].sort())
    assert.match(manifest.platforms['windows-x86_64-msi'].url, /\.msi$/)
    assert.match(manifest.platforms['windows-x86_64'].url, /-setup\.exe$/)
    assert.match(manifest.platforms['linux-x86_64-deb'].url, /\.deb$/)
    assert.match(manifest.platforms['linux-x86_64'].url, /\.AppImage$/)
    for (const asset of Object.values(manifest.platforms)) {
      assert(asset.url.startsWith(`https://github.com/wjc133/one-player/releases/download/v${version}/`))
      const name = decodeURIComponent(new URL(asset.url).pathname.split('/').at(-1))
      assert(!name.includes(' '))
      assert.equal(asset.signature, readFileSync(join(directory, 'release-bundles', `${name}.sig`), 'utf8'))
    }
  })
})

test('one missing architecture prevents generating latest.json', () => {
  withDirectory((directory) => {
    collectAll(directory)
    rmSync(join(directory, 'release-bundles/updater-x86_64-apple-darwin.json'))
    assert.notEqual(generate(directory).status, 0)
    assert(!existsSync(join(directory, 'release-bundles/latest.json')))
  })
})

test('signature corruption and version mismatches prevent generating latest.json', () => {
  for (const corruption of ['signature', 'version']) {
    withDirectory((directory) => {
      collectAll(directory)
      if (corruption === 'signature') {
        writeFileSync(join(directory, `release-bundles/One.Player_${version}_aarch64.app.tar.gz.sig`), 'corrupt')
      } else {
        const path = join(directory, 'release-bundles/updater-aarch64-apple-darwin.json')
        const fragment = JSON.parse(readFileSync(path, 'utf8'))
        writeFileSync(path, JSON.stringify({ ...fragment, version: '0.0.0' }))
      }
      const result = generate(directory)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /Mismatched updater (signature|version)/)
      assert(!existsSync(join(directory, 'release-bundles/latest.json')))
    })
  }
})
