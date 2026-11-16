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
- **专注聆听**：全屏播放页、滚动歌词、顺序播放、列表循环、单曲循环与随机播放，切歌淡入淡出。
- **自己的音乐库**：创建多个收藏歌单、导入本地音乐，读取歌曲名、歌手、专辑、时长与内嵌封面。
- **收藏整张专辑**：保存专辑曲目与封面快照；可选收藏时自动下载，也可手动下载整张专辑、补齐尚未下载的歌曲。
- **下载与离线播放**：显示下载进度，将歌曲信息、封面和 One Player 标记写入音频标签；从下载目录重建已下载列表，支持本地播放与确认后删除文件。
- **WALKMAN 音乐管理**：检测以 `WALKMAN` 开头的磁盘卷，浏览 `MUSIC` 目录、查看容量、双向复制音乐、补全标签与封面，支持批量处理。
- **LX 自定义源兼容**：从本地文件或 URL 导入脚本，也可检测本机 LX 并一键导入当前默认自定义源。
- **按习惯设置**：深色、浅色与跟随系统主题，可配置音质、代理和下载目录。

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

## 快速上手

1. 打开 **设置 → 自定义源**，导入你信任的 LX 兼容脚本；若本机已安装 LX，也可使用一键导入。
2. 选择音乐平台，搜索歌曲或专辑，即可播放、加入收藏或下载。可用音质取决于源脚本声明的能力及实际返回结果。
3. 在收藏中创建歌单，或导入本地音乐文件。已下载音乐可以脱离在线音源播放。
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

从 LX 导入时，支持当前 `config_v2.json / user_api.json` 与旧版 `config.json / userApi.json`，可解压 `gz_` zlib 格式脚本；重复导入会复用已有源。同一时间启用一个自定义源。

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

`pnpm tauri` 会从项目配置读取 Rust 版本并选择对应工具链。开发模式同时启动 Vite 与桌面窗口，前端改动支持热更新。

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

[Release 工作流](.github/workflows/release.yml) 在推送 `v*` tag 时运行，自动完成版本校验、测试、四个平台的打包、SHA-256 校验文件生成以及 GitHub Release 创建与附件上传。所有平台构建成功后才公开 Release；带 `-beta.1` 等后缀的版本自动标记为 Pre-release，并根据提交记录生成更新说明。

发布前，让以下四处版本号保持一致：

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock` 中 `one-player` 包的版本（修改 Cargo.toml 后运行 `cd src-tauri && cargo check` 更新）

例如，发布当前 `0.1.0`：

```bash
pnpm release:check
pnpm test
git add .
git commit -m "chore(release): prepare v0.1.0"
git tag -a v0.1.0 -m "One Player v0.1.0"
git push origin HEAD
git push origin v0.1.0
```

tag 必须与应用版本严格对应，例如版本 `0.2.0-beta.1` 对应 `v0.2.0-beta.1`；版本不一致会在打包前停止工作流。

也可在 **Actions → Release → Run workflow** 手动运行，验证所有平台的打包结果。手动运行仅保留 7 天的构建附件，不创建 Release。发布使用 GitHub 自带的 `GITHUB_TOKEN`，无需额外配置个人访问令牌。

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
