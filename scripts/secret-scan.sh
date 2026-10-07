#!/usr/bin/env bash
set -euo pipefail

gitleaks_bin=${GITLEAKS_BIN:-gitleaks}
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

git rev-parse --verify HEAD >/dev/null
config_file="$(git rev-parse --show-toplevel)/.gitleaks.toml"

canary_report="$tmp_dir/canary.json"
printf -v canary '%s%s%s%s' 'ghp_' 'abcdefghijkl' 'mnopqrstuvwx' 'yz0123456789'
canary_status=0
printf 'github_token=%s\n' "$canary" \
  | "$gitleaks_bin" detect --pipe --redact --no-banner \
      --config "$config_file" \
      --report-format json --report-path "$canary_report" \
  || canary_status=$?
unset canary
if [[ "$canary_status" -ne 1 ]]; then
  echo "Secret scanner canary failed: expected one detected GitHub PAT." >&2
  exit 1
fi
jq --exit-status 'type == "array" and length > 0 and any(.[]; .RuleID == "github-pat")' \
  "$canary_report" >/dev/null || {
    echo "Secret scanner canary failed: expected a github-pat JSON finding." >&2
    exit 1
  }

history_report="$tmp_dir/history.json"
# Native Git mode keeps findings scoped to each diff and preserves file/commit
# attribution, instead of interpreting concatenated patches as one key block.
"$gitleaks_bin" detect --source "$(git rev-parse --show-toplevel)" --redact --no-banner \
  --log-opts="--full-history --all --no-ext-diff --no-textconv" \
  --config "$config_file" \
  --report-format json --report-path "$history_report"

source_dir="$tmp_dir/source"
mkdir -p "$source_dir"
git archive HEAD | tar -x -C "$source_dir"
"$gitleaks_bin" detect --no-git --source "$source_dir" --config "$config_file" --redact --no-banner \
  --report-format json --report-path "$tmp_dir/source.json"

shopt -s nullglob
archives=(.package-output/*.tgz)
if [[ "${#archives[@]}" -eq 0 ]]; then
  echo "No plugin package archives found for secret scanning." >&2
  exit 1
fi
archive_index=0
for archive in "${archives[@]}"; do
  archive_index=$((archive_index + 1))
  python3 scripts/validate-package-archive.py "$archive"
  extracted="$tmp_dir/package-$archive_index"
  mkdir -p "$extracted"
  tar -xzf "$archive" --directory "$extracted"
  "$gitleaks_bin" detect --no-git --source "$extracted" --config "$config_file" --redact --no-banner \
    --report-format json --report-path "$tmp_dir/package-$archive_index.json"
done

echo "Secret scan passed for Git history, tracked source, and ${#archives[@]} plugin package archive(s)."
