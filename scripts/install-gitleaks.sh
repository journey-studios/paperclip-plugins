#!/usr/bin/env bash
set -euo pipefail

install_dir=${1:?usage: install-gitleaks.sh INSTALL_DIR}
archive="$RUNNER_TEMP/gitleaks_8.18.4_linux_x64.tar.gz"
url="https://github.com/gitleaks/gitleaks/releases/download/v8.18.4/gitleaks_8.18.4_linux_x64.tar.gz"
sha256="ba6dbb656933921c775ee5a2d1c13a91046e7952e9d919f9bac4cec61d628e7d"

mkdir -p "$install_dir"
curl --fail --location --silent --show-error "$url" --output "$archive"
printf '%s  %s\n' "$sha256" "$archive" | sha256sum --check --status
tar -xzf "$archive" --directory "$install_dir" gitleaks
"$install_dir/gitleaks" version | grep --fixed-strings --line-regexp '8.18.4' >/dev/null
