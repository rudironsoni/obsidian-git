#!/usr/bin/env bash
# Sync vendor/wasm-git from a wasm-git git commit.
#
# The wasm-git npm package ships prebuilt WebAssembly binaries. The GitHub
# source tree does not, so this script builds Release-async with Emscripten
# when emcc is available. When the target commit has no libgit2/build changes
# since the last npm release, it falls back to the published npm tarball.
set -euo pipefail

COMMIT="${1:-38eeaccd488535aeaf0e8de01dcdc6148379c839}"
VENDOR_DIR="$(cd "$(dirname "$0")/../vendor/wasm-git" && pwd)"
WORK_DIR="${TMPDIR:-/tmp}/wasm-git-update-$$"

cleanup() {
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

git clone --filter=blob:none https://github.com/petersalomonsen/wasm-git.git repo
cd repo
git fetch --depth 1 origin "$COMMIT"
git checkout "$COMMIT"

NPM_VERSION="$(node -p "require('./package.json').version")"
LAST_RELEASE_COMMIT="$(npm view "wasm-git@${NPM_VERSION}" gitHead 2>/dev/null || true)"

if [[ -n "$LAST_RELEASE_COMMIT" ]] && git merge-base --is-ancestor "$LAST_RELEASE_COMMIT" HEAD; then
    echo "Commit $COMMIT is at or after npm wasm-git@${NPM_VERSION}; using published tarball."
    cd "$WORK_DIR"
    npm pack "wasm-git@${NPM_VERSION}"
    rm -rf "$VENDOR_DIR"
    mkdir -p "$VENDOR_DIR"
    tar -xzf "wasm-git-${NPM_VERSION}.tgz" -C "$VENDOR_DIR" --strip-components=1
    rm -f "$VENDOR_DIR"/lg2.js "$VENDOR_DIR"/lg2.wasm "$VENDOR_DIR"/lg2_opfs*.js \
        "$VENDOR_DIR"/lg2_opfs*.wasm "$VENDOR_DIR"/README.md
    printf '%s\n' "$COMMIT" >"$VENDOR_DIR/SOURCE_COMMIT"
    exit 0
fi

if ! command -v emcc >/dev/null 2>&1; then
    echo "wasm-git commit $COMMIT requires a source build, but emcc was not found." >&2
    echo "Install Emscripten 6.0.3, then re-run this script." >&2
    exit 1
fi

npm install
sh setup.sh
cd emscriptenbuild
./build.sh Release-async
cd ..

rm -rf "$VENDOR_DIR"
mkdir -p "$VENDOR_DIR"
cp emscriptenbuild/libgit2/examples/lg2_async.js "$VENDOR_DIR/"
cp emscriptenbuild/libgit2/examples/lg2_async.wasm "$VENDOR_DIR/"
cp COPYING lg2_opfs_auto.js package.json "$VENDOR_DIR/"
printf '%s\n' "$COMMIT" >"$VENDOR_DIR/SOURCE_COMMIT"

echo "Updated vendor/wasm-git from commit $COMMIT"
