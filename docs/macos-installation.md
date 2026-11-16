# macOS 安装与首次打开

1. 从 [GitHub Releases](https://github.com/wjc133/one-player/releases) 下载对应架构的 DMG：M 系列芯片选择 `aarch64`，Intel 芯片选择 `x64`。
2. 打开 DMG，将 **One Player.app** 拖入「应用程序」。
3. 从「应用程序」打开 One Player。

当前版本未使用开发者证书签名，也未经过 Apple 公证。如果首次打开提示“应用已损坏”或“无法验证开发者”，确认安装包来自本仓库的 Releases 后，在终端运行：

```bash
xattr -dr com.apple.quarantine "/Applications/One Player.app"
```

这条命令递归移除 One Player 的 `com.apple.quarantine` 隔离标记。执行后重新打开应用即可；安装在其他位置或修改过应用名称时，请替换引号内的路径。

发布流程不需要 Apple 证书或公证凭据。macOS 构建使用 Tauri 的 ad-hoc 签名，以满足 Apple Silicon 对本地代码签名的要求；它不提供开发者身份认证或 Apple 公证。配置依据见 [Tauri 官方说明](https://v2.tauri.app/distribute/sign/macos/#ad-hoc-signing)。
