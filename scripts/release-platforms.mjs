export const releaseTargets = {
  'aarch64-apple-darwin': {
    platform: 'darwin-aarch64',
    installers: ['.dmg'],
    updates: [{ bundle: 'app', extension: '.app.tar.gz' }],
  },
  'x86_64-apple-darwin': {
    platform: 'darwin-x86_64',
    installers: ['.dmg'],
    updates: [{ bundle: 'app', extension: '.app.tar.gz' }],
  },
  'x86_64-pc-windows-msvc': {
    platform: 'windows-x86_64',
    installers: ['.exe', '.msi'],
    updates: [
      { bundle: 'nsis', extension: '.exe' },
      { bundle: 'msi', extension: '.msi' },
    ],
  },
  'x86_64-unknown-linux-gnu': {
    platform: 'linux-x86_64',
    installers: ['.deb', '.AppImage'],
    updates: [
      { bundle: 'appimage', extension: '.AppImage' },
      { bundle: 'deb', extension: '.deb' },
    ],
  },
}
