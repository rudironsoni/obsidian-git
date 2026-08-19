/** Consecutive foreground deaths after which git startup is skipped. */
export const CRASH_LOOP_THRESHOLD = 2;

/** The device-local persisted state used by {@link StartupGuard}. */
export interface StartupGuardStorage {
    getSessionActive(): boolean;
    setSessionActive(value: boolean): void;
    getStartupCrashCount(): number;
    setStartupCrashCount(value: number): void;
    getStartupSafeMode(): boolean;
    setStartupSafeMode(value: boolean): void;
}

/**
 * Breaks out of startup crash loops on mobile.
 *
 * When the repository needs more memory than the device allows, git work
 * triggered right after launch (restored source-control view, auto pull on
 * boot, an overdue auto commit-and-sync) gets the app killed by the OS,
 * relaunched, and killed again — the user never gets a chance to disable
 * anything.
 *
 * Detection relies on foreground tracking: on mobile a normal exit always
 * backgrounds the app first, so a session that ends while still in the
 * foreground was killed. After {@link CRASH_LOOP_THRESHOLD} consecutive
 * foreground deaths the guard enters safe mode, in which automatic git
 * startup is skipped until the user explicitly retries.
 */
export class StartupGuard {
    constructor(private readonly storage: StartupGuardStorage) {}

    /**
     * Records a plugin boot and updates the crash-loop detection state.
     *
     * @param foreground whether the app is visible right now; sessions
     * launched in the background must not count as foreground deaths later.
     */
    recordBoot(foreground: boolean): void {
        if (!this.storage.getStartupSafeMode()) {
            const previousSessionCrashed = this.storage.getSessionActive();
            const count = previousSessionCrashed
                ? this.storage.getStartupCrashCount() + 1
                : 0;
            if (count >= CRASH_LOOP_THRESHOLD) {
                this.storage.setStartupSafeMode(true);
                this.storage.setStartupCrashCount(0);
            } else {
                this.storage.setStartupCrashCount(count);
            }
        }
        this.storage.setSessionActive(foreground);
    }

    /**
     * Tracks foreground/background transitions so that a kill while
     * backgrounded (the normal way mobile apps end) is not treated as a
     * crash on the next boot.
     */
    setForeground(foreground: boolean): void {
        this.storage.setSessionActive(foreground);
    }

    isSafeMode(): boolean {
        return this.storage.getStartupSafeMode();
    }

    /** Re-arms git startup after an explicit user action. */
    exitSafeMode(): void {
        if (this.storage.getStartupSafeMode()) {
            this.storage.setStartupSafeMode(false);
        }
        this.storage.setStartupCrashCount(0);
    }
}
