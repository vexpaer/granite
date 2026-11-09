# Android APK signing and release secrets

Release signing is configured only during the tagged Release job. Debug builds
use Android's normal debug key. Do not commit a Java keystore,
`keystore.properties`, passwords, or base64 secret values.

## Required GitHub Actions secrets

Create these repository secrets in `vexpaer/granite`:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Base64 encoding of the complete JKS/PKCS12 file |
| `ANDROID_KEYSTORE_PASSWORD` | Store password |
| `ANDROID_KEY_ALIAS` | Release key alias |
| `ANDROID_KEY_PASSWORD` | Key password |

`scripts/android-configure-signing.mjs` writes the decoded keystore and a
private properties file below `src-tauri/gen/android/app`, adds a release
`signingConfig` to the generated Gradle file, and leaves Git-tracked source
unchanged. The files are ignored and the CI runner is ephemeral.

## Generate a release key

Use a dedicated offline location under the ignored workspace cache for the
initial setup, then back it up in the user's password manager or another secure
location:

```powershell
$keyDir = 'E:\GITHUB\granite\.cache\android-signing'
New-Item -ItemType Directory -Force -Path $keyDir

keytool -genkeypair `
  -keystore "$keyDir\granite-release.jks" `
  -storetype JKS `
  -alias granite `
  -keyalg RSA `
  -keysize 4096 `
  -validity 10000
```

Use strong, distinct or deliberately identical store/key passwords according
to the chosen key policy. A lost release key cannot be replaced for an
existing application ID without changing signing identity.

## Upload the secrets

From PowerShell, with the same alias and passwords used above:

```powershell
$keyDir = 'E:\GITHUB\granite\.cache\android-signing'
[Convert]::ToBase64String(
  [IO.File]::ReadAllBytes("$keyDir\granite-release.jks")
) | Set-Content -NoNewline "$keyDir\granite-release.jks.base64"

gh secret set ANDROID_KEYSTORE_BASE64 `
  --repo vexpaer/granite `
  < "$keyDir\granite-release.jks.base64"

gh secret set ANDROID_KEYSTORE_PASSWORD --repo vexpaer/granite
gh secret set ANDROID_KEY_ALIAS --repo vexpaer/granite
gh secret set ANDROID_KEY_PASSWORD --repo vexpaer/granite
```

For the last three commands, `gh` prompts without echoing the value. Do not put
a real password in a committed file or command-line argument.

After upload, remove the base64 copy if it is no longer needed. Keep the
keystore and recovery data outside the repository or in the ignored cache.

## Tag release

After the Debug workflow passes:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

The Release job:

1. Requires all four signing secrets.
2. Builds an ARM64 Release APK with Tauri and NDK 29.
3. Runs `apksigner verify --verbose --print-certs`.
4. Dumps badging and merged-manifest checks with `aapt`.
5. Copies `Granite-<tag>-aarch64.apk` and `SHA256SUMS` to GitHub Release
   assets.
6. Never creates an AAB or starts an emulator.

The release is only evidenced when the actual run and downloaded assets have
been inspected.
