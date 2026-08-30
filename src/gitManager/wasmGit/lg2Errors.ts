export interface Lg2Result {
    stdout: string;
    stderr: string;
}

const ERROR_PATTERNS = [
    /^Bad news:/m,
    /\s\[-?\d+\]( - |$)/m,
    /^THROW: /m,
    /^USAGE: /m,
    /^usage: /m,
    /^Unsupported option/m,
    /^Unknown command line argument/m,
    /^Command not found/m,
    /^failed to /m,
    /^Unable to /m,
    /^invalid command/m,
    /^command is not valid/m,
    /^Unable to open repository/m,
];

export function containsLg2Error(stderr: string): boolean {
    return ERROR_PATTERNS.some((pattern) => pattern.test(stderr));
}

/** True when `callMain` died of a WebAssembly trap / abort, not a git error. */
export function isWasmTrap(error: unknown): boolean {
    if (
        typeof WebAssembly !== "undefined" &&
        error instanceof WebAssembly.RuntimeError
    ) {
        return true;
    }
    if (!(error instanceof Error)) return false;
    if (error.name === "RuntimeError") return true;
    return (
        /memory access out of bounds/i.test(error.message) ||
        /unreachable/i.test(error.message) ||
        /table index is out of bounds/i.test(error.message) ||
        /maximum call stack/i.test(error.message) ||
        /^Aborted\(/i.test(error.message)
    );
}
