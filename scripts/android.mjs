import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolchain = path.join(root, '.cache', 'android-toolchain');
const sdk = path.join(toolchain, 'android-sdk');
const jdk = path.join(toolchain, 'jdk17');
const windows = process.platform === 'win32';
const env = {
  ...process.env,
  CARGO_HOME: path.join(root, '.cache', 'cargo'),
  CARGO_TARGET_DIR: path.join(root, 'target'),
  GRADLE_USER_HOME: path.join(root, '.cache', 'gradle'),
  ...(windows ? {
    RUSTUP_HOME: path.join(root, '.cache', 'rustup'),
    RUSTUP_TOOLCHAIN: 'stable-x86_64-pc-windows-msvc',
  } : {}),
  ...(existsSync(sdk) ? {
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    NDK_HOME: path.join(sdk, 'ndk', '29.0.13846066'),
  } : {}),
  ...(existsSync(jdk) ? { JAVA_HOME: jdk } : {}),
};
env.PATH = [
  env.JAVA_HOME && path.join(env.JAVA_HOME, 'bin'),
  env.ANDROID_HOME && path.join(env.ANDROID_HOME, 'platform-tools'),
  env.ANDROID_HOME && path.join(env.ANDROID_HOME, 'cmdline-tools', 'latest', 'bin'),
  process.env.PATH,
].filter(Boolean).join(path.delimiter);
const child = spawn(process.execPath, [path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'android', ...process.argv.slice(2)], {
  cwd: root, env, stdio: 'inherit', windowsHide: true,
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
