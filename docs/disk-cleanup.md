# 2026-11-11 本地空间清理

盘点项目 `E:\GITHUB\granite`，逻辑文件总量为 **71,272,792,423 bytes（71.27 GB / 66.38 GiB）**。主要是根目录 `target` 42.00 GB、`.cache` 19.79 GB、`src-tauri` 中的嵌套构建 6.36 GB、原生桥接构建 2.51 GB，以及依赖和测试环境。Git 历史约 25 MB，私有签名备份约 4 KB。

这些生成内容可从 GitHub 的源码、锁文件、工作流和已有 Release 重建或下载。源码、规格、Git 历史、已跟踪的测试资料以及 `private/signing` 保留。清理不卸载系统共享软件，也不处理本项目目录之外的文件。

本轮自动审批拒绝了批量递归删除，也拒绝了单独清理 `.venv`，工具只返回 `blocked by policy`。**尚未删除，也不能把 71.27 GB 记作实际回收量。**

用户可双击根目录 `CLEAN-LOCAL.cmd` 执行已准备的明确目录清单；也可以在 PowerShell 中用 `./scripts/clean-local.ps1 -Preview` 只查看。脚本检查 Git 根目录、工作区边界、跟踪文件及链接，保留并核对签名文件，在 `private/local-cleanup-report.json` 记录删除结果及前后盘符可用空间。运行完成后以实际盘符空间和报告为准；被占用的目录会单独报告失败，不能当作已清理。

脚本语法已在 [GitHub Windows run 42964634660](https://github.com/vexpaer/granite/actions/runs/42964634660) 通过检查；未代用户运行删除。Windows 和 Android 的远程构建均已通过，之后无需在本机重建这些环境。

后续不再在本机安装依赖或构建测试，当前流程见 [ci.md](ci.md)。
