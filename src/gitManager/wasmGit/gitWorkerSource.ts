/**
 * Production esbuild replaces these with bundled worker IIFEs.
 * Tests keep `undefined` and run the same handlers on the plugin thread.
 *
 * CPU worker: hash, zlib, trees, index. No wasm-git glue.
 * lg2 worker: libgit2 commands. Loaded only for push/pull/clone.
 */
export const GIT_CPU_WORKER_SOURCE: string | undefined = undefined;
export const GIT_LG2_WORKER_SOURCE: string | undefined = undefined;
