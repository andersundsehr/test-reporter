#!/usr/bin/env bash

# Source this file to make test-reporter available in the current shell.
install_test_reporter() {
  local installer_dir bundle_path download_dir node_major

  if ! command -v node >/dev/null 2>&1; then
    echo 'test-reporter requires Node.js 22 or newer.' >&2
    return 1
  fi
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')" || return 1
  if [ "$node_major" -lt 22 ]; then
    echo 'test-reporter requires Node.js 22 or newer.' >&2
    return 1
  fi

  installer_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)" || return 1
  bundle_path="$installer_dir/test-reporter.cjs"

  if [ ! -f "$bundle_path" ]; then
    local base_url
    base_url="${TEST_REPORTER_BASE_URL:-https://github.com/andersundsehr/test-reporter/releases/latest/download}"
    download_dir="$(mktemp -d "${TMPDIR:-/tmp}/test-reporter.XXXXXXXX")" || return 1
    bundle_path="$download_dir/test-reporter.cjs"
    if ! curl --fail --silent --show-error --location \
      "${base_url%/}/test-reporter.cjs" --output "$bundle_path"; then
      return 1
    fi
  fi

  # An absolute path preserves the caller's working directory for reports and Git metadata.
  export TEST_REPORTER_BUNDLE="$bundle_path"
}

test-reporter() {
  node "$TEST_REPORTER_BUNDLE" "$@"
}

install_test_reporter
