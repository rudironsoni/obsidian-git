import { describe, expect, it } from "vitest";
import { isGitObjectPayloadPath } from "../../../src/gitManager/wasmGit/gitObjectPayload";

describe("isGitObjectPayloadPath", () => {
    it("matches the object store and nothing else", () => {
        expect(isGitObjectPayloadPath("objects")).toBe(true);
        expect(isGitObjectPayloadPath("objects/pack")).toBe(true);
        expect(isGitObjectPayloadPath("objects/pack/pack-abc.pack")).toBe(true);
        expect(isGitObjectPayloadPath("objects/ab/cdef")).toBe(true);
        expect(isGitObjectPayloadPath("HEAD")).toBe(false);
        expect(isGitObjectPayloadPath("index")).toBe(false);
        expect(isGitObjectPayloadPath("refs/heads/main")).toBe(false);
        expect(isGitObjectPayloadPath("config")).toBe(false);
    });
});
