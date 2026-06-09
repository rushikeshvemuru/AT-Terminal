#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
module_dir="$(cd -- "$script_dir/.." && pwd)"

if [[ "$module_dir" == */target/debug/AT-modules/base ]]; then
  repo_root="${module_dir%/target/debug/AT-modules/base}"
  source_module_dir="$repo_root/AT-modules/base"
  if [[ -f "$source_module_dir/server/Cargo.toml" ]]; then
    module_dir="$source_module_dir"
  fi
fi

cd "$module_dir"

cargo run --manifest-path server/Cargo.toml --quiet
