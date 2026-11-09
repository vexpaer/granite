#!/usr/bin/env bash
set -euo pipefail

mode="${1:-debug}"
signature_requirement="${2:-any}"
output_dir="artifacts/android/${mode}"
mkdir -p "$output_dir"

apk_root="src-tauri/gen/android/app/build/outputs/apk"
mapfile -d '' apks < <(find "$apk_root" -type f -name '*.apk' -print0 | sort -z)
if [[ "${#apks[@]}" -eq 0 ]]; then
  echo "No APK found under $apk_root" >&2
  exit 1
fi

android_home="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$android_home" ]]; then
  echo "ANDROID_HOME or ANDROID_SDK_ROOT must be set" >&2
  exit 1
fi

find_tool() {
  local name="$1"
  local search_root="$2"
  find "$search_root" -type f -name "$name" -print | sort -V | tail -n 1
}

apksigner="$(find_tool apksigner "$android_home/build-tools")"
aapt="$(find_tool aapt "$android_home/build-tools")"
if [[ -z "$apksigner" || -z "$aapt" ]]; then
  echo "apksigner and aapt are required" >&2
  exit 1
fi

: > "$output_dir/apk-inspection.txt"
sha256sum "${apks[@]}" > "$output_dir/SHA256SUMS"

for apk in "${apks[@]}"; do
  {
    echo "APK: $apk"
    "$aapt" dump badging "$apk" | sed -n '1,12p'
    "$apksigner" verify --verbose --print-certs "$apk"
    echo
  } | tee -a "$output_dir/apk-inspection.txt"
done

if [[ "$signature_requirement" == "signed" ]]; then
  if grep -q "DOES NOT VERIFY" "$output_dir/apk-inspection.txt"; then
    echo "Release APK signature verification failed" >&2
    exit 1
  fi
fi
