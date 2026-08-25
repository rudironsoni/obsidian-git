import { describe, expect, it } from "vitest";
import {
    containsLg2Error,
    isWasmTrap,
    Lg2Error,
} from "../../../src/gitManager/wasmGit/lg2";

describe("containsLg2Error", () => {
    it("detects wasm traps reported as THROW lines", () => {
        expect(containsLg2Error("THROW: memory access out of bounds")).toBe(
            true
        );
    });

    it("ignores upstream-missing chatter", () => {
        expect(
            containsLg2Error("error: reference 'origin/main' not found")
        ).toBe(false);
    });
});

describe("isWasmTrap", () => {
    it("recognizes WebAssembly.RuntimeError and OOB messages", () => {
        expect(isWasmTrap(new WebAssembly.RuntimeError("unreachable"))).toBe(
            true
        );
        expect(isWasmTrap(new Error("memory access out of bounds"))).toBe(true);
        expect(
            isWasmTrap(new Error("Aborted(native code called abort())"))
        ).toBe(true);
        expect(isWasmTrap(new Error("pathspec did not match"))).toBe(false);
        expect(isWasmTrap("string")).toBe(false);
    });
});

describe("Lg2Error", () => {
    it("keeps the original argv, not Emscripten's ./this.program prefix", () => {
        const error = new Lg2Error(
            ["add", "note.md"],
            "",
            "THROW: memory access out of bounds"
        );
        expect(error.args[0]).toBe("add");
        expect(error.args).not.toContain("./this.program");
        expect(error.message).toMatch(/^git add note\.md failed:/);
    });
});
