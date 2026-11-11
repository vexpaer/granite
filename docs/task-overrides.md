# User scope updates

## U3 — 2026-11-11（当前生效）

用户指示：「以后所有的构建和cicd都迁移到github,本机只有git,然后测试github不能做的全部放弃,就做最简单的测试就行,现在帮我清理一下这个项目占用的磁盘」。

- 所有安装、构建、测试、签名和发布在 GitHub-hosted Actions 完成；本机只做源码编辑与 Git 操作，不再创建项目依赖/工具链/构建/测试缓存。
- 只保留简单的类型/单元检查、原生测试与编译、Windows/Android 打包和产物检查。不执行或新增浏览器、实机、真实云端、跨设备或性能测试矩阵。
- GitHub 无法做的测试全部豁免，不阻塞发布，也不再安排为必须完成的用户手测；记录为 `WAIVED / NOT VERIFIED`，不能记为通过。
- 清理项目内可重建缓存、环境和产物，保留源码、Git 历史、规格及必要的私有签名备份。已发布安装包继续从 GitHub Release 下载。
- 本条覆盖 U2 及其他文档的本机验证/手测要求。功能实现、已知故障修复、数据保护与签名材料禁止提交等要求仍有效。当前流程见 [ci.md](ci.md)。

## U2 — 2026-11-10

用户更正：「修改规格,所有的都不需要真机测试与云端测试,之后我手动测就行」。已同步到权威规格书。

- Windows 与 Android 的实机应用验收均由用户交付后手测，本次不执行、不阻塞交付或发布。
- 真实 S3-compatible/WebDAV、真实云端上传下载及另一设备/跨设备同步验收均由用户后续手测，本次不执行、不索取云凭证。
- 保留功能实现、本地单元/集成/浏览器测试、原生编译检查、GitHub Actions 构建、APK 签名及产物检查。
- 未执行项目标记 `USER MANUAL / NOT VERIFIED`，不得标记 `PASS`。Android 模拟器/虚拟设备仍禁止；已知的数据安全、启动与核心阅读故障仍须修复。
- 本条覆盖 U1 及其他文档中将 Windows 实机或真实云端测试列为当前发布阻塞的旧规定。

## U1 — 2026-11-09（已由 U2 扩展）

2026-11-09: 用户更正「不需要进行android真机验证」。Android physical-device installation/runtime verification is waived for this task. Android GitHub Actions build, debug APK artifact, release workflow, and code validation remain required. Android emulators/virtual devices remain prohibited. This override supersedes the original specification's physical Android device gate; it does not claim Android runtime has been observed.
