import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const env = {
  ...process.env,
  CARGO_HOME: path.join(root, '.cache', 'cargo'),
  CARGO_TARGET_DIR: path.join(root, 'target', windows ? 'host-msvc' : 'host'),
  ...(windows ? {
    RUSTUP_HOME: path.join(root, '.cache', 'rustup'),
    RUSTUP_TOOLCHAIN: 'stable-x86_64-pc-windows-msvc',
  } : {}),
};
const child = spawn(process.execPath, [path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), ...process.argv.slice(2)], {
  cwd: root, env, stdio: 'inherit', windowsHide: true,
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
