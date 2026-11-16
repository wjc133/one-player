import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

const paths = JSON.parse(process.env.TAURI_ARTIFACT_PATHS || '[]')
const installers = paths.filter((path) => /\.(dmg|msi|exe|deb|AppImage)$/.test(path))
const expected = process.env.RELEASE_BUNDLES.split(',').map((bundle) => ({
  dmg: '.dmg', msi: '.msi', nsis: '.exe', deb: '.deb', appimage: '.AppImage',
})[bundle])
for (const extension of expected) {
  assert(extension && installers.some((path) => path.endsWith(extension)), `Missing installer: ${extension}`)
}

mkdirSync('release-bundles', { recursive: true })
for (const path of installers) {
  assert(statSync(path).isFile() && statSync(path).size > 0, `Invalid installer: ${path}`)
  // GitHub replaces spaces in release asset names with dots. Normalize before checksumming.
  const name = basename(path).replaceAll(' ', '.')
  copyFileSync(path, join('release-bundles', name))
  console.log(`Collected ${name}`)
}
