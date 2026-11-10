# Granite

免费开源、Local-first、插件优先的私人数字书房。面向 Windows 与 Android，基于 Tauri 2、Rust、Vue 3、TypeScript 与 Cordis，无需 Granite 账号或常驻服务器。

## 开发

```powershell
$env:RUSTUP_HOME = Join-Path $PWD '.cache/rustup'
$env:CARGO_HOME = Join-Path $PWD '.cache/cargo'
rustup toolchain install stable-x86_64-pc-windows-msvc --profile minimal
npm ci
npm run desktop
```

依赖安装在本目录的 `node_modules`，npm 缓存在 `.cache/npm`，Cargo 和 Rust 工具链分别位于 `.cache/cargo`、`.cache/rustup`。桌面脚本选择 MSVC，输出位于 `target/host-msvc`。Android 脚本使用 `.cache/android-toolchain` 内已有的 JDK/SDK/NDK，Gradle 缓存在 `.cache/gradle`；环境安装说明见 [Android 构建](docs/android/ci.md)。Windows 需要预先安装 Rustup、Visual Studio C++ Build Tools 和 WebView2。

```powershell
npm run check
npm run desktop:build
npm run android:init
npm run android:build
```

`npm run dev` 仅供界面开发预览；浏览器预览使用 IndexedDB。原生目录授权、安全凭证及云同步由 Windows/Android 宿主提供。产品运行不需要 Node.js 或本地 HTTP 服务。

## 产品与验证

- 权威规格：[Granite 规格书](granite%20规格书/Granite%20规格书.md)
- 需求追踪：[验收记录](docs/acceptance.md)
- 架构：[架构决策](docs/architecture-decisions.md)
- 本次用户更正：[实机与真实云端验收交由用户手测](docs/task-overrides.md)
- 收到安装包后：[手动检查清单](docs/user-manual-checklist.md)
- 所有第三方资源来源：[素材说明](public/assets/SOURCES.md)

主项目 AGPL-3.0-only；第三方依赖保留各自许可证。请勿向仓库提交个人书籍、云存储密钥或 Android 签名材料。发布状态以有实际证据的验收记录为准。
