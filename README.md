# One Player

使用 Rust、Tauri 2、React 与 TypeScript 实现的轻量音乐播放器，聚焦以下功能：

- 酷我、酷狗、QQ、网易云、咪咕歌曲搜索
- 本地收藏列表与播放队列
- Rust 后端下载
- 全屏播放页与滚动歌词
- 深色、浅色主题与代理、音质、下载目录设置
- LX Music Desktop 自定义源 API `2.0.0` 兼容层
- 自动检测本机 LX Music Desktop，并一键导入当前默认自定义源

不包含歌单广场、排行榜、同步、桌面歌词等功能。

## 自定义源兼容

运行时实现了原协议中的：

- `globalThis.lx.version = '2.0.0'`
- `globalThis.lx.env = 'desktop'`
- `EVENT_NAMES.request / inited / updateAlert`
- `lx.on / lx.send / lx.request`
- `lx.currentScriptInfo`
- `lx.utils.buffer / crypto / zlib`
- `kw / kg / tx / wy / mg / local` 能力、动作与音质校验
- 音乐地址、歌词、封面返回值校验与 20 秒请求超时

自定义源脚本运行在独立 Web Worker 中，无法直接访问主窗口或 Tauri API；宿主只桥接协议规定的网络、加密和压缩能力。

设置页会检测 LX Music Desktop 的默认数据目录。若 LX 当前启用的是自定义源，可直接读取并解压 `gz_` zlib 脚本、导入到 One Player 并自动启用；重复导入会复用已有源。兼容当前 `config_v2.json` / `user_api.json` 与旧版 `config.json` / `userApi.json` 存储。

## 开发

```bash
pnpm install
pnpm tauri dev
```

生产构建：

```bash
pnpm tauri build
```

