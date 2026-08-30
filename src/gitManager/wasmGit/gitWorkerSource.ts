/**
 * Production esbuild replaces this with the bundled worker IIFE.
 * Tests keep `undefined` and run the same handlers on the plugin thread.
 */
export const GIT_WORKER_SOURCE: string | undefined = undefined;
