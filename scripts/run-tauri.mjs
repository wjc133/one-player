import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
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
  const toolchainBin = dirname(cargo.stdout.trim())
  const environment = {
    ...process.env,
    PATH: `${toolchainBin}${process.env.PATH ? `${delimiter}${process.env.PATH}` : ''}`,
    RUSTUP_TOOLCHAIN: channel,
    RUSTC: join(toolchainBin, 'rustc'),
  }
  const signingDirectory = join(homedir(), '.config', 'one-player', 'updater-signing')
  const signingKey = join(signingDirectory, 'one-player.key')
  if (process.argv[2] === 'build' && !environment.TAURI_SIGNING_PRIVATE_KEY && existsSync(signingKey)) {
    environment.TAURI_SIGNING_PRIVATE_KEY = signingKey
    if (environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
      environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = readFileSync(join(signingDirectory, 'password.txt'), 'utf8').trim()
    }
  }
  const tauri = spawn(
    join(root, 'node_modules/.bin/tauri'),
    process.argv.slice(2),
    {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: environment,
    },
  )
  tauri.on('close', (code) => {
    process.exitCode = code ?? 1
  })
}
