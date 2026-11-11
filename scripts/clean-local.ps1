[CmdletBinding()]
param([switch]$Preview)

# User-run cleanup for the GitHub-only workflow. No build tool is required.
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$rootItem = Get-Item -LiteralPath $projectRoot -Force
if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'The project root must not be a junction or symbolic link.'
}
$gitRoot = (& git -C $projectRoot rev-parse --show-toplevel)
if ($LASTEXITCODE -ne 0 -or -not $gitRoot) { throw 'Cannot verify the Git checkout.' }
if ([IO.Path]::GetFullPath($gitRoot).TrimEnd('\') -ne $projectRoot) {
    throw 'The script must be inside the intended Granite Git checkout.'
}

# Explicit, rebuildable targets only. Never use git clean -fdx: it removes keys.
$targets = @(
    '.cache', '.venv', 'target', 'node_modules', 'dist',
    'playwright-report', 'test-results', 'public/pdfjs',
    'src-tauri/target', 'src-tauri/.cache',
    'native/android-bridge/target',
    'native/android-bridge/android/.tauri',
    'native/android-bridge/android/build',
    'packages/core/examples/basic-plugin/dist',
    'src-tauri/gen/android/.gradle', 'src-tauri/gen/android/.tauri',
    'src-tauri/gen/android/app/build', 'src-tauri/gen/android/build',
    'src-tauri/gen/android/buildSrc/.gradle',
    'src-tauri/gen/android/buildSrc/build',
    'src-tauri/gen/android/app/src/main/assets',
    'src-tauri/gen/android/app/src/main/java/app/granite/reader/generated',
    'src-tauri/gen/android/app/src/main/jniLibs',
    'src-tauri/gen/android/app/proguard-tauri.pro',
    'src-tauri/gen/android/app/tauri.build.gradle.kts',
    'src-tauri/gen/android/app/tauri.properties',
    'src-tauri/gen/android/tauri.settings.gradle',
    'src-tauri/gen/schemas', 'src-tauri/icons/ios',
    'src-tauri/icons/icon.icns',
    'artifacts/android', 'artifacts/windows', 'artifacts/release',
    'artifacts/screenshots/installed-granite.png',
    'private/qa-webview', 'private/qa-library'
)

function Assert-ProjectPath([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    if (-not $absolute.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Target is outside the checkout: $absolute"
    }
    return $absolute
}

$signingDirectory = Join-Path $projectRoot 'private/signing'
foreach ($privatePath in @((Join-Path $projectRoot 'private'), $signingDirectory)) {
    if ((Test-Path -LiteralPath $privatePath) -and
        ((Get-Item -LiteralPath $privatePath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Private backup/report directories must not be junctions or symbolic links.'
    }
}
$protectedFiles = @()
if (Test-Path -LiteralPath $signingDirectory) {
    $protectedFiles = @(Get-ChildItem -LiteralPath $signingDirectory -File -Force | ForEach-Object {
        [pscustomobject]@{ Path = $_.FullName; Hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
    })
}

# Validate every top-level target before deleting anything.
$validated = @()
foreach ($relative in $targets) {
    $absolute = Assert-ProjectPath (Join-Path $projectRoot $relative)
    if ($absolute -eq $signingDirectory -or $absolute.StartsWith($signingDirectory + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Signing backup is protected.'
    }
    $tracked = @(& git -C $projectRoot ls-files -- $relative)
    if ($LASTEXITCODE -ne 0 -or $tracked.Count -gt 0) { throw "Tracked files in cleanup target: $relative" }
    if (-not (Test-Path -LiteralPath $absolute)) { continue }
    $cursor = $absolute
    while ($cursor -ne $projectRoot) {
        if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Target or ancestor is a junction/symlink: $relative"
        }
        $cursor = [IO.Directory]::GetParent($cursor).FullName
    }
    $validated += [pscustomobject]@{ Relative = $relative; Absolute = $absolute }
}

if ($Preview) {
    $validated.Relative
    Write-Host 'Preview only. No files were removed.'
    exit 0
}

$driveName = [IO.Path]::GetPathRoot($projectRoot).TrimEnd('\').TrimEnd(':')
$beforeFree = (Get-PSDrive -Name $driveName).Free
$completed = @()
$failures = @()
foreach ($target in $validated) {
    try {
        $entry = Get-Item -LiteralPath $target.Absolute -Force
        if ($entry.PSIsContainer) {
            # Walk without following links, then unlink links before recursion.
            $pending = New-Object 'System.Collections.Generic.Stack[string]'
            $pending.Push($target.Absolute)
            $links = @()
            while ($pending.Count -gt 0) {
                $directory = $pending.Pop()
                foreach ($child in Get-ChildItem -LiteralPath $directory -Force) {
                    if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                        $links += (Assert-ProjectPath $child.FullName)
                    } elseif ($child.PSIsContainer) {
                        $pending.Push($child.FullName)
                    }
                }
            }
            foreach ($link in $links) { Remove-Item -LiteralPath $link -Force }
            Remove-Item -LiteralPath $target.Absolute -Recurse -Force
        } else {
            Remove-Item -LiteralPath $target.Absolute -Force
        }
        if (Test-Path -LiteralPath $target.Absolute) { throw 'Target still exists after removal.' }
        $completed += $target.Relative
        Write-Host "Removed: $($target.Relative)"
    } catch {
        $failures += [pscustomobject]@{ Target = $target.Relative; Error = $_.Exception.Message }
        Write-Warning "Incomplete: $($target.Relative) - $($_.Exception.Message)"
    }
}

foreach ($protected in $protectedFiles) {
    if (-not (Test-Path -LiteralPath $protected.Path) -or
        (Get-FileHash -LiteralPath $protected.Path -Algorithm SHA256).Hash -ne $protected.Hash) {
        throw 'Signing backup verification failed.'
    }
}
$afterFree = (Get-PSDrive -Name $driveName).Free
$report = [pscustomobject]@{
    CompletedAt = (Get-Date).ToString('o')
    CompletedTargets = $completed
    Failures = $failures
    BeforeFreeBytes = $beforeFree
    AfterFreeBytes = $afterFree
    FreeIncreaseBytes = $afterFree - $beforeFree
    SigningBackupUnchanged = $true
}
$reportDirectory = Join-Path $projectRoot 'private'
New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $reportDirectory 'local-cleanup-report.json') -Encoding UTF8
Write-Host ('Free space increased by {0:N2} GiB. Signing backup unchanged.' -f (($afterFree - $beforeFree) / 1GB))
if ($failures.Count -gt 0) { exit 1 }
