# macOS 签名与 Apple 公证

发布流程使用 **Developer ID Application** 证书为应用与 DMG 签名，开启 Hardened Runtime，将应用提交给 Apple 公证，并将票据附加到应用。工作流在上传安装包前验证签名、开发团队、公证票据与 Gatekeeper 评估结果；校验失败会阻止发布。

本项目采用 Apple ID 与 App 专用密码认证。证书和密码保存在 GitHub Actions Secrets 中，Tauri 构建时自动导入临时钥匙串。开发者证书私钥、`.p12` 和密码均不应提交到 Git。

## 1. 导出正式分发证书

1. 打开 macOS **钥匙串访问**，选择「登录 → 我的证书」。
2. 找到 `Developer ID Application` 证书，展开后应能看到对应私钥。不要选 `Apple Development`。
3. 选中证书，右键选择「导出」，格式选 **个人信息交换（.p12）**，例如保存为 `~/Downloads/one-player-developer-id.p12`。
4. 为导出文件设置一个强密码，并完成 macOS 要求的钥匙串授权。这个密码随后填入 `APPLE_CERTIFICATE_PASSWORD`。

可用以下命令查看本机可用的签名身份：

```bash
security find-identity -v -p codesigning
```

## 2. 准备 Apple 公证认证

登录 [Apple 账户](https://account.apple.com/)，在「登录与安全性 → App 专用密码」中生成一个名为 `One Player GitHub Actions` 的专用密码。使用拥有相应开发团队权限的 Apple ID；`APPLE_PASSWORD` 填这个专用密码，而非 Apple 账户登录密码。

如果已经有可用的 App 专用密码，可以直接复用。团队 ID 可在 [Apple Developer 会员信息](https://developer.apple.com/account) 中确认，也能从 Developer ID Application 的证书名称中看到。

## 3. 配置仓库 Secrets

进入仓库 [Settings → Secrets and variables → Actions](https://github.com/wjc133/one-player/settings/secrets/actions)，添加以下 **Repository secrets**：

| Secret | 内容 |
| --- | --- |
| `APPLE_CERTIFICATE` | 导出 `.p12` 的 Base64 内容 |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `APPLE_SIGNING_IDENTITY` | 完整的 `Developer ID Application: 姓名 (TEAMID)` |
| `APPLE_ID` | 拥有对应开发团队权限的 Apple ID 邮箱 |
| `APPLE_PASSWORD` | Apple 账户生成的 App 专用密码 |
| `APPLE_TEAM_ID` | 对应开发团队的 Team ID |

已登录 GitHub CLI 时，可通过终端上传证书而不显示 Base64 内容：

```bash
base64 -i "$HOME/Downloads/one-player-developer-id.p12" | gh secret set APPLE_CERTIFICATE --repo wjc133/one-player
gh secret set APPLE_CERTIFICATE_PASSWORD --repo wjc133/one-player
gh secret set APPLE_ID --repo wjc133/one-player
gh secret set APPLE_PASSWORD --repo wjc133/one-player
```

后三条命令会依次提示输入值。若签名身份和 Team ID 尚未设置，再运行：

```bash
gh secret set APPLE_SIGNING_IDENTITY --repo wjc133/one-player
gh secret set APPLE_TEAM_ID --repo wjc133/one-player
```

`gh secret list --repo wjc133/one-player` 只列出名称和更新时间，可用来确认配置；GitHub 不支持回读 Secret 明文。

## 4. 验证和发布

先在 **Actions → Release → Run workflow** 手动运行，检查两种 Mac 架构是否都通过 `Verify macOS signature and notarization`。手动运行生成构建附件，正式发布由版本 tag 触发。

首次公证有时需要 Apple 较长时间处理；凭据无效、协议尚未接受或公证被拒绝时，日志会给出原因，应修正后重新运行，避免发布未经公证的 macOS 包。

签名与公证的区别及配置依据见 [Tauri 官方 macOS 签名指南](https://v2.tauri.app/distribute/sign/macos/)，Secret 管理见 [GitHub 官方文档](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)。本配置仅处理 macOS；Windows Authenticode 需要独立的证书与签名服务。
