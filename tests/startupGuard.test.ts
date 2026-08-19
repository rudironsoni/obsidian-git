import { describe, expect, it } from "vitest";
import {
    CRASH_LOOP_THRESHOLD,
    StartupGuard,
    type StartupGuardStorage,
} from "../src/startupGuard";

function createGuard(): { guard: StartupGuard; storage: StartupGuardStorage } {
    const state = {
        sessionActive: false,
        crashCount: 0,
        safeMode: false,
    };
    const storage: StartupGuardStorage = {
        getSessionActive: () => state.sessionActive,
        setSessionActive: (value) => (state.sessionActive = value),
        getStartupCrashCount: () => state.crashCount,
        setStartupCrashCount: (value) => (state.crashCount = value),
        getStartupSafeMode: () => state.safeMode,
        setStartupSafeMode: (value) => (state.safeMode = value),
    };
    return { guard: new StartupGuard(storage), storage };
}

/** Simulates the app being killed and relaunched while in the foreground. */
function crashAndRelaunch(guard: StartupGuard): void {
    // A kill has no hook; the next boot simply observes the leftover state.
    guard.recordBoot(true);
}

describe("StartupGuard", () => {
    it("does not enter safe mode on the first boot", () => {
        const { guard } = createGuard();

        guard.recordBoot(true);

        expect(guard.isSafeMode()).toBe(false);
    });

    it("does not enter safe mode after a single foreground death", () => {
        const { guard } = createGuard();
        guard.recordBoot(true);

        crashAndRelaunch(guard);

        expect(guard.isSafeMode()).toBe(false);
    });

    it("enters safe mode after consecutive foreground deaths", () => {
        const { guard } = createGuard();
        guard.recordBoot(true);

        for (let i = 0; i < CRASH_LOOP_THRESHOLD; i++) {
            expect(guard.isSafeMode()).toBe(false);
            crashAndRelaunch(guard);
        }

        expect(guard.isSafeMode()).toBe(true);
    });

    it("stays in safe mode across further boots until exited", () => {
        const { guard } = createGuard();
        guard.recordBoot(true);
        for (let i = 0; i < CRASH_LOOP_THRESHOLD; i++) {
            crashAndRelaunch(guard);
        }

        guard.recordBoot(true);
        guard.recordBoot(true);

        expect(guard.isSafeMode()).toBe(true);
    });

    it("backgrounding resets the crash streak", () => {
        const { guard } = createGuard();
        guard.recordBoot(true);
        crashAndRelaunch(guard);

        // The user backgrounds the app; a later kill is a normal exit.
        guard.setForeground(false);
        guard.recordBoot(true);

        crashAndRelaunch(guard);
        expect(guard.isSafeMode()).toBe(false);
    });

    it("does not count sessions launched in the background", () => {
        const { guard } = createGuard();

        guard.recordBoot(false);
        guard.recordBoot(true);
        crashAndRelaunch(guard);

        expect(guard.isSafeMode()).toBe(false);
    });

    it("exitSafeMode re-arms the guard from a clean slate", () => {
        const { guard } = createGuard();
        guard.recordBoot(true);
        for (let i = 0; i < CRASH_LOOP_THRESHOLD; i++) {
            crashAndRelaunch(guard);
        }
        expect(guard.isSafeMode()).toBe(true);

        guard.exitSafeMode();

        expect(guard.isSafeMode()).toBe(false);
        // The retry itself may crash once without instantly re-tripping.
        crashAndRelaunch(guard);
        expect(guard.isSafeMode()).toBe(false);
        crashAndRelaunch(guard);
        expect(guard.isSafeMode()).toBe(true);
    });
});
