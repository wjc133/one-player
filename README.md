<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="112" height="112" alt="One Player 图标" />

# One Player

**搜索、聆听、收藏，把喜欢的音乐留在身边。**

基于 Tauri 2、Rust、React 和 TypeScript 的桌面音乐播放器，支持 LX 自定义源、本地音乐库与 WALKMAN 音乐管理。

[![Release](https://img.shields.io/github/v/release/wjc133/one-player?display_name=tag)](https://github.com/wjc133/one-player/releases)
[![Build](https://github.com/wjc133/one-player/actions/workflows/release.yml/badge.svg)](https://github.com/wjc133/one-player/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[下载安装](https://github.com/wjc133/one-player/releases) · [功能特性](#功能特性) · [快速上手](#快速上手) · [本地开发](#本地开发) · [反馈问题](https://github.com/wjc133/one-player/issues)

</div>

## 功能特性

- **多平台音乐搜索**：搜索 KW、KG、TX、WY 和 MG 的歌曲、专辑，查看专辑曲目并直接加入播放队列。
- **专注聆听**：全屏播放页、滚动歌词、顺序播放、列表循环、单曲循环与随机播放，切歌淡入淡出。播放失败时自动跳过连续失败的歌曲，快速切歌时忽略过期的音频请求。当前歌词加大显示，支持调整并记住整体歌词字号。
- **歌词循环**：在播放详情用 `I` / `O` 标记循环区间，或用 `Ctrl` + 点击选择要反复听的歌词。选好范围后可聚焦其中的歌词，并用 0.3x、0.5x、0.7x 或 1x 播放。在「设置 → 歌词循环」可设置默认最小单位和循环倍速。
- **AI 辅助学歌词**：在「设置 → 歌词循环」启用后，可配置硅基流动中国站、DeepSeek 或其他 OpenAI 兼容服务。聚焦后可手动或自动发送范围内的原词用于语种识别和注音，英语在词上方显示音标，日语显示假名。
- **播放队列**：在歌曲操作菜单中设为「下一首播放」，或从歌单、播放队列移除歌曲。
- **菜单栏播放**：通过菜单栏或系统托盘控制播放，选择关闭时退出或隐藏并继续播放，可在设置中控制图标是否显示。macOS 可在离开正在播放页、最小化或隐藏窗口后显示当前一句歌词。
- **歌曲缓存**：在线歌曲首次播放后自动缓存，再次播放优先读取本机副本。默认 512 MB，可在「设置 → 通用」调整容量，设为 0 MB 时关闭。空间不足时优先移除访问次数最少的歌曲，次数相同则先移除最久未播放的歌曲。
- **自己的音乐库**：创建、重命名、合并与删除歌单。合并时自动跳过重复歌曲并保留原歌单。删除歌单需二次确认。支持导入本地音乐并读取歌曲名、歌手、专辑、时长与内嵌封面。
- **导入平台歌单**：读取本机 LX Music 的默认列表、我的收藏与自建歌单，保留歌曲顺序和混合平台信息；macOS 还可读取已安装网易云音乐中的个人创建或收藏歌单。支持批量分别导入，或合并到一个已有歌单，重复导入自动合并。歌单导航支持搜索和独立滚动。
- **封面本地缓存**：歌曲、歌单和专辑封面按需加载并保存在本地，重启后继续复用；每次请求 30 秒超时，每轮最多尝试 3 次，失败后重新打开歌单可再次尝试。
- **收藏整张专辑**：保存专辑曲目与封面快照；可选收藏时自动下载，也可手动下载整张专辑、补齐尚未下载的歌曲。
- **下载与离线播放**：显示下载进度，将歌曲信息、封面和 One Player 标记写入音频标签；从下载目录重建已下载列表，支持本地播放与确认后删除文件。
- **WALKMAN 音乐管理**：检测以 `WALKMAN` 开头的磁盘卷，浏览 `MUSIC` 目录、查看容量、双向复制音乐、补全标签与封面，支持批量处理。
- **LX 自定义源兼容**：从本地文件或 URL 导入脚本，也可检测本机 LX，选择并批量导入自定义源，不再依赖 LX 当前启用的默认源。
- **自定义源更新**：从更新提示中的地址获取新脚本，验证并初始化成功后替换原音源，保留音源标识与更新提醒偏好；更新地址为网页或其他非脚本内容时，在默认浏览器中打开。
- **按习惯设置**：通用、音源与应用更新分栏管理，支持深色、浅色、紫色与跟随系统主题，可配置音质、代理、下载目录和标签补全覆盖策略。
- **应用内更新**：启动后及每 6 小时自动检查正式版，在设置中查看 Markdown 格式的更新说明和下载进度，确认后安装并重启；支持关闭自动检查。应用和音源更新说明共用紧凑排版，标题字号与当前界面保持一致。

## 下载安装

从 [GitHub Releases](https://github.com/wjc133/one-player/releases) 下载对应系统与架构的安装包：

| 系统 | 架构 | 安装包 |
| --- | --- | --- |
| macOS | Apple Silicon（M 系列） | `*_aarch64.dmg` |
| macOS | Intel | `*_x64.dmg` |
| Windows | x64 | `*-setup.exe` 或 `*.msi` |
| Linux | x64 | `*.AppImage` 或 `*.deb` |

macOS 打开 DMG 后将应用拖入「应用程序」。Linux 的 AppImage 需要先赋予执行权限，例如在下载目录运行 `chmod +x ./*.AppImage`。每个版本同时提供 `SHA256SUMS.txt`，可用 `shasum -a 256`（macOS）或 `sha256sum`（Linux）核对下载文件。

当前 macOS 安装包未使用开发者证书签名，也未经过 Apple 公证。如果首次打开提示“应用已损坏”或“无法验证开发者”，确认文件来自本仓库的 Releases，并先将应用拖入「应用程序」，再在终端运行：

```bash
xattr -dr com.apple.quarantine "/Applications/One Player.app"
```

这条命令会移除 One Player 的隔离标记，随后重新打开应用。安装在其他位置时，请将路径替换为实际位置。详见 [macOS 安装说明](docs/macos-installation.md)。

Windows 安装包暂未配置 Authenticode 签名，SmartScreen 可能显示安全提示。

### 应用内更新

在 **设置 → 应用更新** 中查看当前版本并手动检查更新。正式构建默认在启动 8 秒后检查一次，此后每 6 小时检查；检查与下载使用通用 HTTP 代理。发现新版本后，设置导航显示「新」标记，不会自动下载或打断播放。

点击「下载更新」后可继续播放音乐；更新包通过签名校验后，点击「安装并重启」并确认才会安装。音乐下载和本地导入尚未完成时禁止安装；WALKMAN 传输和文件编辑应先完成。更新失败可重试，网络不可用不会阻止应用启动或播放。

更新只跟随 GitHub Releases 的最新正式版，不自动切换到 Pre-release。macOS 按 Apple Silicon / Intel 选择更新包；Windows 保留 NSIS / MSI 安装类型；Linux 保留 AppImage / Deb 安装类型，Deb 更新可能需要系统管理员授权。更新包签名用于校验来源，与 Apple 签名、公证和 Windows Authenticode 签名相互独立。

应用内更新从 `v0.2.0` 开始提供。使用 `v0.1.0`、`v0.1.1` 的用户需要先手动下载安装 `v0.2.0` 或更新版本，此后可通过应用内更新升级。

## 快速上手

1. 打开 **设置 → 音源**，导入你信任的 LX 兼容脚本；若本机已安装 LX，也可选择并导入其中的自定义源。
2. 选择音乐平台，搜索歌曲或专辑，即可播放、加入收藏或下载。可用音质取决于源脚本声明的能力及实际返回结果。
3. 在「我的列表」中创建歌单、导入本地音乐文件，或点击「导入歌单」选择 LX Music 或网易云音乐并勾选歌单。LX Music 需先启动并打开「我的列表」；网易云歌单导入支持 macOS，需先登录并加载个人歌单。导入时可选择「合并到…」并搜索已有目标歌单；在歌单上右键或点击更多按钮可重命名、合并歌单。已下载音乐可以脱离在线音源播放。
4. 使用 WALKMAN 时，以 USB 存储模式连接设备；设备挂载名称需以 `WALKMAN` 开头，并包含 `MUSIC` 目录。

应用不附带自定义音源、账号或音乐内容。在线搜索结果与播放能力取决于第三方服务及自行导入的脚本。

## 自定义源兼容

实现 LX 自定义源 API `2.0.0` 的核心接口：

| 能力 | 支持内容 |
| --- | --- |
| 环境 | `globalThis.lx.version = '2.0.0'`、`lx.env = 'desktop'`、`lx.currentScriptInfo` |
| 事件 | `EVENT_NAMES.request / inited / updateAlert`、`lx.on / lx.send` |
| 网络与工具 | `lx.request`、`lx.utils.buffer / crypto / zlib` |
| 平台标识 | `kw / kg / tx / wy / mg / local` |
| 请求动作 | `musicUrl / lyric / pic`，包含能力、音质与返回值校验 |

脚本在独立 Web Worker 中执行，宿主桥接协议所需的网络、加密和压缩能力，请求设有 20 秒超时。请仅导入信任的脚本；Worker 隔离不等同于完整的恶意代码沙箱。

从 LX 导入时，支持当前 `user_api.json` 与旧版 `userApi.json`，可解压 `gz_` zlib 格式脚本；无需配置默认源，可勾选多个音源批量导入，单个无效脚本不影响其他音源。重复导入会复用已有源，同一时间启用一个自定义源。

## 本地开发

### 环境准备

- [Node.js](https://nodejs.org/) **24 或更高版本**。
- [pnpm](https://pnpm.io/installation) **12.14.0**，版本固定在 `package.json`。
- [Rust / rustup](https://rustup.rs/)。项目在 `src-tauri/rust-toolchain.toml` 中固定 **Rust 1.90.0**。
- 对应系统的 [Tauri 2 开发依赖](https://v2.tauri.app/start/prerequisites/)：macOS 的 Xcode Command Line Tools、Windows 的 MSVC C++ 构建工具与 WebView2、Linux 的 WebKitGTK 等。

```bash
git clone https://github.com/wjc133/one-player.git
cd one-player
pnpm install --frozen-lockfile
rustup toolchain install 1.90.0
pnpm tauri dev
```

`pnpm tauri` 会从项目配置读取 Rust 版本并选择对应工具链。开发模式同时启动 Vite 与桌面窗口，前端改动支持热更新。开发模式不会自动检查应用更新，仍可手动检查。

### 常用命令

```bash
pnpm dev             # 仅启动前端开发服务器
pnpm test            # 前端逻辑测试
pnpm build           # TypeScript 检查与前端生产构建
pnpm release:check   # 检查各处版本号一致
pnpm build:release   # 构建当前系统的桌面安装包
```

```bash
cd src-tauri
cargo test --locked --lib
```

桌面产物位于 `src-tauri/target/release/bundle/`。单独使用浏览器启动前端时，文件管理、下载、自定义源存储等原生能力需要 Tauri 宿主。Rust 测试中依赖真实设备、外部音频样本或 FFmpeg 的用例默认忽略，可按用例注释在准备好环境后运行。

正式打包会生成更新包及签名，需要 `TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。本机若已备份到 `~/.config/one-player/updater-signing/one-player.key` 和同目录的 `password.txt`，`pnpm tauri build` / `pnpm build:release` 会自动读取；显式设置的环境变量优先。其他开发机器可以使用维护者提供的签名凭据；仅验证打包流程时，也可通过 Tauri CLI 配置覆盖临时关闭 `bundle.createUpdaterArtifacts`，这些产物不应用作正式更新。

### 项目结构

```text
src/
  App.tsx                主界面、播放队列、收藏与设置
  components/            WALKMAN 页面与封面组件
  lib/                   音乐平台、歌词、原生调用与音源宿主
  source-runtime.ts      自定义源 Worker 运行时
src-tauri/
  src/                   Rust 原生能力、下载、标签与设备管理
  tauri.conf.json        桌面窗口与打包配置
  rust-toolchain.toml     Rust 工具链版本
tests/                   前端逻辑测试
scripts/                 工具链启动与发布校验脚本
.github/workflows/       GitHub Actions 发布工作流
```

## 自动发布

[Release 工作流](.github/workflows/release.yml) 在推送 `v*` tag 时运行，自动完成版本校验、测试、四个构建目标的打包与更新签名、统一 `latest.json` 和 SHA-256 校验文件生成，以及 GitHub Release 创建与附件上传。所有平台构建成功且更新包、签名齐全后才公开 Release；带 `-beta.1` 等后缀的版本自动标记为 Pre-release，并根据提交记录生成更新说明。`latest.json` 使用对应 Release 的完整更新说明。

发布前，让以下四处版本号保持一致：

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock` 中 `one-player` 包的版本（修改 Cargo.toml 后运行 `cd src-tauri && cargo check` 更新）

例如，发布 `0.6.0` 时运行以下命令。

```bash
pnpm release:check
pnpm test
git add .
git commit -m "chore(release): 发布 v0.6.0"
git tag -a v0.6.0 -m "One Player v0.6.0"
git push origin HEAD
git push origin v0.6.0
```

tag 必须与应用版本严格对应，例如版本 `0.2.0-beta.1` 对应 `v0.2.0-beta.1`；版本不一致会在打包前停止工作流。

也可在 **Actions → Release → Run workflow** 手动运行，验证所有平台的打包结果。手动运行仅保留 7 天的构建附件，不创建 Release。发布使用 GitHub 自带的 `GITHUB_TOKEN`，无需额外配置个人访问令牌。

更新签名要求在 **Settings → Secrets and variables → Actions** 配置：

- `TAURI_SIGNING_PRIVATE_KEY`：加密私钥文件的完整内容。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：解密私钥的密码。

公钥随 `src-tauri/tauri.conf.json` 提交。私钥和密码保存在仓库外，不能作为构建附件上传。丢失签名密钥会影响已安装客户端继续更新，请同时备份私钥与密码，不要在常规发版时重新生成密钥。

当前工作流发布未使用开发者证书签名、未经过 Apple 公证的 macOS 安装包，无需配置 Apple 证书或公证凭据。macOS 首次打开的处理方法见 [安装说明](docs/macos-installation.md)。

发布文案优先读取 `.github/release-notes/<tag>.md`，没有对应版本文件时使用通用模板。工作流基于 [Tauri 官方 GitHub Actions 指南](https://v2.tauri.app/distribute/pipelines/github/) 与 [tauri-action](https://github.com/tauri-apps/tauri-action)。Windows 签名需要另行配置 [Authenticode 证书或签名服务](https://v2.tauri.app/distribute/sign/windows/)。

## 已知限制

- 在线平台接口与自定义源可能变更，部分歌曲或音质可能不可用。
- 本地音频的实际播放能力由系统 WebView 与编解码器决定；能读取标签或复制到 WALKMAN 的格式，不一定能在应用中播放。
- 收藏专辑快照可以离线查看；离线播放需要先下载对应音频文件。
- WALKMAN 以挂载的文件系统方式管理，要求设备提供 USB 存储访问；仅提供 MTP 的设备不在当前支持范围内。
- 当前聚焦本地桌面使用，暂未提供云同步、歌单广场、排行榜与桌面歌词。

## 参与贡献

欢迎通过 [Issues](https://github.com/wjc133/one-player/issues) 报告问题或提出建议。反馈时请附上系统版本、应用版本、复现步骤和必要日志；涉及自定义源时请提供接口行为或最小复现，避免提交私人凭据与受限制的音频文件。

提交 Pull Request 前请运行 `pnpm test`、`pnpm build` 与 Rust 测试。涉及下载、音频标签或设备文件写入的修改，请说明验证过的格式与平台。

## 致谢与许可

感谢 [Tauri](https://tauri.app/)、[React](https://react.dev/)、[LX](https://github.com/lyswhut/lx-music-desktop) 以及项目使用的开源依赖。

One Player 使用 [MIT License](LICENSE)。第三方软件、脚本与音乐内容的权利及许可归各自权利人所有；请确保对访问、下载和管理的内容拥有相应权限。
