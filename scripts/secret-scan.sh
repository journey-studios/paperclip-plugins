#!/usr/bin/env bash
set -euo pipefail

gitleaks_bin=${GITLEAKS_BIN:-gitleaks}
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

git rev-parse --verify HEAD >/dev/null
config_file="$(git rev-parse --show-toplevel)/.gitleaks.toml"
# This redacted baseline contains only the fixed historical synthetic fixture:
# ad739a1, tests/snapshot-safety.test.mjs, private-key at line 35.
baseline_file="$(git rev-parse --show-toplevel)/scripts/gitleaks-baseline.json"

pipe_index=0
assert_pipe_scan() {
  local label=$1 input=$2 expected_status=$3
  shift 3
  local report="$tmp_dir/pipe-$((pipe_index += 1)).json" status=0 rule_id

  printf '%s\n' "$input" \
    | "$gitleaks_bin" detect --pipe --redact --no-banner \
        --config "$config_file" \
        --report-format json --report-path "$report" \
    || status=$?
  if [[ "$status" -ne "$expected_status" ]]; then
    echo "Secret scanner preflight failed: $label returned status $status, expected $expected_status." >&2
    exit 1
  fi
  if [[ "$expected_status" -eq 0 ]]; then
    jq --exit-status 'type == "array" and length == 0' "$report" >/dev/null || {
      echo "Secret scanner preflight failed: $label produced unexpected findings." >&2
      exit 1
    }
    return
  fi

  for rule_id in "$@"; do
    jq --exit-status --arg id "$rule_id" \
      'type == "array" and any(.[]; .RuleID == $id)' "$report" >/dev/null || {
      echo "Secret scanner preflight failed: $label did not report expected rule $rule_id." >&2
      exit 1
    }
  done
  jq --exit-status --argjson count "$#" \
    'type == "array" and length == $count' \
    "$report" >/dev/null || {
    echo "Secret scanner preflight failed: $label produced unexpected findings." >&2
    exit 1
  }
}

# Exact synthetic fixtures are exempt, but a changed AWS key and PEM body
# must be reported. Build the canaries from fragments so they are absent from
# this script's own source scan.
synthetic_aws='AKIAABCDEFGHIJKLMNOP'
near_aws="${synthetic_aws%P}Q"
assert_pipe_scan 'exact synthetic AWS fixture' "aws_access_key_id=$synthetic_aws" 0

pem_begin=$(printf '%s%s%s' '-----' 'BEGIN PRIVATE KEY' '-----')
pem_end=$(printf '%s%s%s' '-----' 'END PRIVATE KEY' '-----')
synthetic_pem=$(printf '%s\n%s\n%s' \
  "$pem_begin" 'private-material' "$pem_end")
assert_pipe_scan 'exact synthetic private-key fixture' "$synthetic_pem" 0

escaped_synthetic_pem=$(printf '%s\\n%s\\n%s' \
  "$pem_begin" 'private-material' "$pem_end")
assert_pipe_scan 'exact escaped synthetic private-key fixture' \
  "const privateKey = \"$escaped_synthetic_pem\";" 0

escaped_near_pem=$(printf '%s\\n%s\\n%s' \
  "$pem_begin" 'private-material-extra' "$pem_end")
printf -v pem_pat '%s%s%s%s' 'ghp_' 'abcdefghijkl' 'mnopqrstuvwx' 'yz0123456789'
assert_pipe_scan 'near-match private-key with same-line PAT' \
  "const privateKey = \"$escaped_near_pem\"; github_token=$pem_pat" \
  1 'private-key' 'github-pat'
assert_pipe_scan 'near-match AWS fixture' "aws_access_key_id=$near_aws" 1 'aws-access-token'

printf -v canary '%s%s%s%s' 'ghp_' 'abcdefghijkl' 'mnopqrstuvwx' 'yz0123456789'
assert_pipe_scan 'same-line exact AWS fixture and GitHub PAT' \
  "const fixture = \"$synthetic_aws\"; github_token=$canary" 1 'github-pat'
assert_pipe_scan 'same-line exact escaped PEM fixture and GitHub PAT' \
  "const privateKey = \"$escaped_synthetic_pem\"; github_token=$canary" 1 'github-pat'

printf -v canary '%s%s%s%s' 'ghp_' 'abcdefghijkl' 'mnopqrstuvwx' 'yz0123456789'
assert_pipe_scan 'GitHub PAT canary' "github_token=$canary" 1 'github-pat'

printf -v combined_aws '%s%s' 'AKIA' 'BCDEFGHIJKLMNOPQ'
printf -v combined_pat '%s%s%s%s' 'ghp_' 'abcdefghijkl' 'mnopqrstuvwx' 'yz0123456789'
assert_pipe_scan 'same-line GitHub PAT and AWS token' \
  "const fixture = \"$synthetic_aws\"; github_token=$combined_pat aws_access_key_id=$combined_aws" \
  1 'github-pat' 'aws-access-token'
unset canary combined_pat combined_aws synthetic_aws near_aws synthetic_pem escaped_synthetic_pem \
  escaped_near_pem pem_pat

# The sole baseline entry is tied to one historical synthetic-test finding.
# Verify it does not suppress a new private-key finding at the same path/line.
baseline_test_repo="$tmp_dir/baseline-regression"
mkdir -p "$baseline_test_repo/tests"
git -C "$baseline_test_repo" init -q
git -C "$baseline_test_repo" config user.email secret-scan@example.invalid
git -C "$baseline_test_repo" config user.name 'Secret Scan Test'
{
  for ((line = 1; line < 35; line++)); do printf '\n'; done
  printf '%s\n%s\n%s\n' "$pem_begin" 'different-material' "$pem_end"
} > "$baseline_test_repo/tests/snapshot-safety.test.mjs"
git -C "$baseline_test_repo" add tests/snapshot-safety.test.mjs
git -C "$baseline_test_repo" -c commit.gpgsign=false -c core.hooksPath=/dev/null \
  commit -q -m 'Add a new synthetic key at baseline path and line'
baseline_test_report="$tmp_dir/baseline-regression.json"
baseline_test_status=0
"$gitleaks_bin" detect --source "$baseline_test_repo" --redact --no-banner \
  --log-opts='--full-history --all --no-ext-diff --no-textconv' \
  --config "$config_file" --baseline-path "$baseline_file" \
  --report-format json --report-path "$baseline_test_report" \
  || baseline_test_status=$?
if [[ "$baseline_test_status" -ne 1 ]] \
  || ! jq --exit-status 'type == "array" and any(.[]; .RuleID == "private-key" and .StartLine == 35)' \
      "$baseline_test_report" >/dev/null; then
  echo "Secret scanner preflight failed: baseline hid a new private-key finding at the same path and line." >&2
  exit 1
fi
unset pem_begin pem_end

history_report="$tmp_dir/history.json"
# Native Git mode keeps findings scoped to each diff and preserves file/commit
# attribution, instead of interpreting concatenated patches as one key block.
"$gitleaks_bin" detect --source "$(git rev-parse --show-toplevel)" --redact --no-banner \
  --log-opts="--full-history --all --no-ext-diff --no-textconv" \
  --config "$config_file" --baseline-path "$baseline_file" \
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
