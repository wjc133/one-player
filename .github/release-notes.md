## 下载

| 系统 | 安装包 |
| --- | --- |
| macOS · Apple Silicon | `aarch64.dmg` |
| macOS · Intel | `x64.dmg` |
| Windows · x64 | `-setup.exe` 或 `.msi` |
| Linux · x64 | `.AppImage` 或 `.deb` |

`SHA256SUMS.txt` 包含所有安装包的 SHA-256 校验值。

### macOS 首次打开

此版本未使用开发者证书签名，也未经过 Apple 公证。如提示“应用已损坏”或“无法验证开发者”，确认下载自本仓库，并将应用拖入「应用程序」后，在终端运行：

```bash
xattr -dr com.apple.quarantine "/Applications/One Player.app"
```

随后重新打开 One Player。若安装在其他目录，请替换为实际应用路径。

Windows 安装包暂未配置 Authenticode 签名，系统可能显示安全提示。

应用不附带自定义音源；在线播放与下载需要自行导入兼容的 LX 自定义源。

使用方法、开发指南和已知限制请参阅 [README](https://github.com/wjc133/one-player#readme)。
