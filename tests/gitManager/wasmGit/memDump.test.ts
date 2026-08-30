import { describe, expect, it } from "vitest";
import { WasmGitHttpBridge } from "../../../src/gitManager/wasmGit/httpBridge";
import { Lg2 } from "../../../src/gitManager/wasmGit/lg2";
import {
    applyMemDump,
    dumpMemRoots,
    loadMemDump,
} from "../../../src/gitManager/wasmGit/memDump";

describe("memDump", () => {
    it("round-trips files in MEMFS", async () => {
        const lg2 = new Lg2(new WasmGitHttpBridge());
        await lg2.init();
        lg2.fs.mkdir("/dump-test");
        lg2.fs.writeFile("/dump-test/a.txt", "hello");
        const dump = dumpMemRoots(lg2.fs, ["/dump-test"]);
        expect(
            dump.files.some((file) => file.path === "/dump-test/a.txt")
        ).toBe(true);
        lg2.fs.unlink("/dump-test/a.txt");
        loadMemDump(lg2.fs, dump);
        expect(lg2.fs.readFile("/dump-test/a.txt", { encoding: "utf8" })).toBe(
            "hello"
        );
        lg2.fs.writeFile("/dump-test/extra.txt", "nope");
        applyMemDump(lg2.fs, ["/dump-test"], dump);
        expect(lg2.fs.analyzePath("/dump-test/extra.txt").exists).toBe(false);
        lg2.unload();
    });
});
