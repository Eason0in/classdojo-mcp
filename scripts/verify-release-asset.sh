#!/usr/bin/env bash
set -euo pipefail

checksums_file="${1:?checksums file is required}"
asset_name="${2:?asset name is required}"
match_count="$(awk -v asset="${asset_name}" '$2 == asset { count++ } END { print count + 0 }' "${checksums_file}")"

if [[ "${match_count}" -ne 1 ]]; then
  echo "Expected exactly one checksum for ${asset_name}, found ${match_count}." >&2
  exit 1
fi

expected_checksum="$(awk -v asset="${asset_name}" '$2 == asset { print $1 }' "${checksums_file}")"
actual_checksum="$(sha256sum "${asset_name}" | awk '{ print $1 }')"

if [[ "${actual_checksum}" != "${expected_checksum}" ]]; then
  echo "${asset_name}: FAILED" >&2
  exit 1
fi

echo "${asset_name}: OK"
