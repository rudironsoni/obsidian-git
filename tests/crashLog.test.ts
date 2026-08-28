import { describe, expect, it } from "vitest";
import { formatCrashLogLine } from "../src/crashLog";

describe("formatCrashLogLine", () => {
    it("writes an ISO timestamp, phase, and JSON extra", () => {
        const line = formatCrashLogLine("onload", { gitReady: false });
        expect(line).toMatch(
            /^\d{4}-\d{2}-\d{2}T.*Z \[onload\] \{"gitReady":false\}\n$/
        );
    });

    it("omits extra when it is undefined", () => {
        const line = formatCrashLogLine("onunload");
        expect(line).toMatch(/Z \[onunload\]\n$/);
        expect(line).not.toContain("undefined");
    });
});
