import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const pkg = JSON.parse(read('package.json'))
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'))
const cargoPackage = read('src-tauri/Cargo.toml').match(/\[package\]([\s\S]*?)(?=\n\[|$)/)?.[1]
const cargoVersion = cargoPackage?.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
const lockPackage = read('src-tauri/Cargo.lock')
  .split('[[package]]')
  .find((section) => /^name = "one-player"$/m.test(section))
const lockVersion = lockPackage?.match(/^version = "([^"]+)"/m)?.[1]

assert.equal(tauri.version, pkg.version, 'tauri.conf.json 与 package.json 版本不一致')
assert.equal(cargoVersion, pkg.version, 'Cargo.toml 与 package.json 版本不一致')
assert.equal(lockVersion, pkg.version, 'Cargo.lock 与 package.json 版本不一致')

const tag = process.env.RELEASE_TAG || `v${pkg.version}`
// SemVer, excluding build metadata because Tauri bundle filenames do not preserve it.
const number = '(0|[1-9]\\d*)'
const identifier = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)'
const semverTag = new RegExp(`^v${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?$`)
assert.match(tag, semverTag, 'tag 必须为 vMAJOR.MINOR.PATCH，可带 -beta.1 等预发布后缀')
assert.equal(tag, `v${pkg.version}`, `tag ${tag} 必须与应用版本 v${pkg.version} 一致`)
console.log(`Release version verified: ${tag}`)
