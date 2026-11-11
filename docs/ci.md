# GitHub-only 构建与最简测试

2026-11-11，用户更正 U3 当前生效。所有依赖、工具链、构建、测试、签名和发布只在 GitHub-hosted Actions 执行。本机仅用于编辑源码与 Git 操作；私有签名备份仍受保护。

| 工作流 | 普通推送 / PR | 手动运行 | `v*` 标签 |
| --- | --- | --- | --- |
| [Windows](../.github/workflows/windows.yml) | 前端类型/单元检查、构建，MSVC 原生测试/检查，NSIS x64 安装包与校验值 Artifact | 同样构建，可下载 Artifact | 将安装包与 `SHA256SUMS.windows` 上传至对应 Release |
| [Android](../.github/workflows/android.yml) | 前端类型/单元检查、ARM64 Debug APK、桥接 JVM 测试及产物检查 | 发布密钥签名的候选 APK Artifact，不创建 Release | 签名 ARM64 APK 与 `SHA256SUMS.android` 上传至对应 Release |

只保留上述简单检查，不建立设备、浏览器、性能或复杂尺寸矩阵。GitHub 无法完成的实机、交互、真实云端与跨设备测试全部 **WAIVED / NOT VERIFIED**；不在本机执行，不要求后续补测，不标为通过。已知的数据安全、启动和核心阅读故障仍须修复。

构建环境仅使用 GitHub-hosted runner 和 Actions 缓存，不使用 self-hosted runner、本机路径或常驻本机服务。不要为了修复 CI 在本机重新安装依赖；提交修改后读取 Actions 结果。

Windows 安装包当前未签名。Android 继续使用已配置的四个 GitHub Secrets；`private/signing` 是保留的私有更新身份备份，不能上传或纳入清理目录。两个工作流可并发创建/更新同一 Release，按平台独立命名校验清单。已发布的 v0.1.0 及其原有聚合校验清单保持原样。

旧文档中的本地构建指令、浏览器/实机测试及手测安排均是 U3 前的历史记录，不能作为当前操作要求。GitHub Actions 工作流与本页定义当前流程。
