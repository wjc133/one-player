import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const toolchainConfig = readFileSync(
  join(root, 'src-tauri/rust-toolchain.toml'),
  'utf8',
)
const channel = toolchainConfig.match(/^channel\s*=\s*['"]([^'"]+)['"]/m)?.[1]

if (!channel) {
  throw new Error('无法读取 src-tauri/rust-toolchain.toml 中的 Rust 工具链')
}

const cargo = spawnSync(
  'rustup',
  ['which', '--toolchain', channel, 'cargo'],
  { encoding: 'utf8' },
)

if (cargo.status !== 0 || !cargo.stdout.trim()) {
  console.error(`请先安装 Rust ${channel}：rustup toolchain install ${channel}`)
  process.exitCode = 1
} else {
  const tauri = spawn(
    join(root, 'node_modules/.bin/tauri'),
    process.argv.slice(2),
    {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        PATH: `${dirname(cargo.stdout.trim())}${process.env.PATH ? `${delimiter}${process.env.PATH}` : ''}`,
      },
    },
  )
  tauri.on('close', (code) => {
    process.exitCode = code ?? 1
  })
}
