#!/bin/sh
set -eu

usage() {
  printf '%s\n' 'Usage: sh install.sh' \
    'Installs quotahot-hook into ~/.local/bin.' \
    'Requires Node.js >=24. Registers only the OpenCode plugin; no sudo needed.'
}

if [ "$#" -gt 0 ]; then
  case "$1" in
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
fi

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js >=24 is required. Install Node.js, then retry.' >&2
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("Node.js >=24 is required."); process.exit(1); }'

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$source_dir/quotahot-hook" ]; then
  bundle_dir=$source_dir
else
  bundle_dir=$(CDPATH= cd -- "$source_dir/.." && pwd)/dist
fi
if [ ! -f "$bundle_dir/quotahot-hook" ]; then
  printf '%s\n' "Build output missing in $bundle_dir." \
    'Run npm run build in hooks/ or extract the install package.' >&2
  exit 1
fi
printf 'Build output directory: %s\n' "$bundle_dir"

bin_dir=$HOME/.local/bin
target_binary=$bin_dir/quotahot-hook
mkdir -p "$bin_dir"
binary_tmp=$(mktemp "$bin_dir/.quotahot-hook.XXXXXX")
if ! install -m 0755 "$bundle_dir/quotahot-hook" "$binary_tmp"; then
  rm -f "$binary_tmp"
  printf '%s\n' 'Failed to copy quotahot-hook.' >&2
  exit 1
fi
mv -f "$binary_tmp" "$target_binary"
node "$target_binary" install
printf '\n%s\n' 'Installed. Add the command directory to your shell PATH:' \
  '  export PATH="$HOME/.local/bin:$PATH"' \
  'Then run: quotahot-hook help' \
  'Restart OpenCode for the integration to take effect.'
