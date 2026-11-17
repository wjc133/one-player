import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { releaseTargets } from './release-platforms.mjs'

const paths = JSON.parse(process.env.TAURI_ARTIFACT_PATHS || '[]')
const installers = paths.filter((path) => /\.(dmg|msi|exe|deb|AppImage)$/.test(path))
const target = process.env.RELEASE_TARGET
const definition = releaseTargets[target]
assert(definition, `Unsupported release target: ${target}`)
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
for (const extension of definition.installers) {
  assert(installers.some((path) => path.endsWith(extension)), `Missing installer: ${extension}`)
}

mkdirSync('release-bundles', { recursive: true })
const collected = new Map()
function collect(path) {
  assert(statSync(path).isFile() && statSync(path).size > 0, `Invalid installer: ${path}`)
  let name = basename(path).replaceAll(' ', '.')
  if (/\.app\.tar\.gz(\.sig)?$/.test(name)) {
    const arch = target.startsWith('aarch64-') ? 'aarch64' : 'x64'
    name = name.replace('.app.tar.gz', `_${version}_${arch}.app.tar.gz`)
  }
  assert(!collected.has(name) || collected.get(name) === path, `Duplicate release asset: ${name}`)
  if (collected.has(name)) return name
  copyFileSync(path, join('release-bundles', name))
  collected.set(name, path)
  console.log(`Collected ${name}`)
  return name
}

for (const path of installers) collect(path)
const platforms = {}
for (const { bundle, extension } of definition.updates) {
  const candidates = paths.filter((path) => path.endsWith(extension))
  assert.equal(candidates.length, 1, `Expected one updater package for ${bundle}`)
  const path = candidates[0]
  const signaturePath = `${path}.sig`
  assert(existsSync(signaturePath), `Missing updater signature: ${basename(signaturePath)}`)
  const signature = readFileSync(signaturePath, 'utf8').trim()
  assert(signature, `Empty updater signature: ${basename(signaturePath)}`)
  const asset = { file: collect(path), signature }
  collect(signaturePath)
  platforms[`${definition.platform}-${bundle}`] = asset
  platforms[definition.platform] ??= asset
}
writeFileSync(
  join('release-bundles', `updater-${target}.json`),
  JSON.stringify({ version, target, platforms }, null, 2) + '\n',
)
