import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { releaseTargets } from './release-platforms.mjs'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const tag = process.env.RELEASE_TAG
assert.equal(tag, `v${version}`, 'Updater version must match the release tag')
const repository = process.env.GITHUB_REPOSITORY || 'wjc133/one-player'
assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
const directory = process.env.RELEASE_ASSET_DIRECTORY || 'release-bundles'
const platforms = {}

for (const [target, definition] of Object.entries(releaseTargets)) {
  const fragment = JSON.parse(readFileSync(join(directory, `updater-${target}.json`), 'utf8'))
  assert.equal(fragment.version, version, `Mismatched updater version: ${target}`)
  assert.equal(fragment.target, target, `Mismatched updater target: ${target}`)
  const expectedPlatforms = [
    definition.platform,
    ...definition.updates.map(({ bundle }) => `${definition.platform}-${bundle}`),
  ]
  assert.deepEqual(Object.keys(fragment.platforms).sort(), expectedPlatforms.sort(), `Incomplete updater platforms: ${target}`)
  for (const [platform, asset] of Object.entries(fragment.platforms)) {
    assert.equal(asset.file, basename(asset.file), `Invalid updater filename: ${platform}`)
    const path = join(directory, asset.file)
    assert(statSync(path).isFile() && statSync(path).size > 0, `Missing updater package: ${asset.file}`)
    const signature = readFileSync(`${path}.sig`, 'utf8').trim()
    assert(signature && signature === asset.signature, `Mismatched updater signature: ${platform}`)
    platforms[platform] = {
      signature,
      url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset.file)}`,
    }
  }
}

const notesPath = process.env.RELEASE_NOTES_FILE || `.github/release-notes/${tag}.md`
const fallbackNotesPath = '.github/release-notes.md'
const notes = existsSync(notesPath)
  ? readFileSync(notesPath, 'utf8').trim()
  : existsSync(fallbackNotesPath) ? readFileSync(fallbackNotesPath, 'utf8').trim() : ''
const manifest = { version, notes, pub_date: new Date().toISOString(), platforms }
writeFileSync(join(directory, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`Generated latest.json for ${Object.keys(releaseTargets).length} targets`)
