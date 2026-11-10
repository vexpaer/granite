# User scope updates

## U2 — 2026-11-10

用户更正：「修改规格,所有的都不需要真机测试与云端测试,之后我手动测就行」。已同步到权威规格书。

- Windows 与 Android 的实机应用验收均由用户交付后手测，本次不执行、不阻塞交付或发布。
- 真实 S3-compatible/WebDAV、真实云端上传下载及另一设备/跨设备同步验收均由用户后续手测，本次不执行、不索取云凭证。
- 保留功能实现、本地单元/集成/浏览器测试、原生编译检查、GitHub Actions 构建、APK 签名及产物检查。
- 未执行项目标记 `USER MANUAL / NOT VERIFIED`，不得标记 `PASS`。Android 模拟器/虚拟设备仍禁止；已知的数据安全、启动与核心阅读故障仍须修复。
- 本条覆盖 U1 及其他文档中将 Windows 实机或真实云端测试列为当前发布阻塞的旧规定。

## U1 — 2026-11-09（已由 U2 扩展）

2026-11-09: 用户更正「不需要进行android真机验证」。Android physical-device installation/runtime verification is waived for this task. Android GitHub Actions build, debug APK artifact, release workflow, and code validation remain required. Android emulators/virtual devices remain prohibited. This override supersedes the original specification's physical Android device gate; it does not claim Android runtime has been observed.
