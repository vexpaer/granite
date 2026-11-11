# Granite

免费开源、Local-first、插件优先的私人数字书房。面向 Windows 与 Android，基于 Tauri 2、Rust、Vue 3、TypeScript 与 Cordis，无需 Granite 账号或常驻服务器。

## 下载 v0.1.0

- [Windows x64 安装包](https://github.com/vexpaer/granite/releases/download/v0.1.0/Granite-0.1.0-windows-x64-setup.exe)（8.04 MB，未做 Windows 代码签名，需要 WebView2）
- [Android ARM64 APK](https://github.com/vexpaer/granite/releases/download/v0.1.0/Granite-v0.1.0-aarch64.apk)（22.97 MB，发布密钥签名，Android 7.0 / API 24 起）
- [发布说明](https://github.com/vexpaer/granite/releases/tag/v0.1.0) · [SHA-256 校验清单](https://github.com/vexpaer/granite/releases/download/v0.1.0/SHA256SUMS)

首版包含 EPUB/PDF/TXT/MOBI 阅读、PDF 标注直接写回、多书库、Markdown 笔记与附件、标签、统计、备份、WebDAV/S3 同步和 Cordis 插件。自动化检查与产物校验已通过；实机运行与真实云端测试按当前 U3 要求豁免，尚未验证，也不要求手动补测。完整缓冲操作上限为 512 MiB，详见[验收记录](docs/acceptance.md)。

## 开发与构建（仅 GitHub Actions）

```powershell
git pull
# 编辑源码后提交并推送
git add .
git commit -m "Describe the change"
git push
```

本机仅维护源码和 Git 工作副本，不安装 Node、Rust、Python、JDK、Android SDK 或浏览器测试环境。推送/PR 自动触发 [Windows](https://github.com/vexpaer/granite/actions/workflows/windows.yml) 和 [Android](https://github.com/vexpaer/granite/actions/workflows/android.yml) 检查与打包；也可在 Actions 页面点击 **Run workflow** 手动构建。安装包从运行页面的 Artifacts 下载，无需下载到开发目录。

```powershell
git tag vX.Y.Z
git push origin vX.Y.Z
```

发布前先更新源码中的版本号。`v*` 标签触发两个平台的构建并上传到同一 GitHub Release，各自附带 `SHA256SUMS.windows` / `SHA256SUMS.android`。Windows 暂无代码签名，Android 使用 GitHub Secrets 内的发布密钥。

测试只保留 GitHub 可执行的简单类型/单元检查、原生检查、打包与产物校验；GitHub 无法做的测试全部豁免，不安排本机或手动补测。历史实机/浏览器记录仅保留为历史证据。完整规则见 [CI 流程](docs/ci.md)。产品运行不需要 Node.js 或本地 HTTP 服务。

清理旧本地环境可双击根目录的 `CLEAN-LOCAL.cmd`；脚本只删除列明的可重建项目文件，保留源码、Git 和 `private/signing`，结果写入忽略目录 `private/local-cleanup-report.json`。

## 产品与验证

- 权威规格：[Granite 规格书](granite%20规格书/Granite%20规格书.md)
- 需求追踪：[验收记录](docs/acceptance.md)
- 架构：[架构决策](docs/architecture-decisions.md)
- 当前用户更正：[所有构建与最简测试迁移到 GitHub](docs/task-overrides.md)
- 所有第三方资源来源：[素材说明](public/assets/SOURCES.md)

主项目 AGPL-3.0-only；第三方依赖保留各自许可证。请勿向仓库提交个人书籍、云存储密钥或 Android 签名材料。发布状态以有实际证据的验收记录为准。
