import type ObsidianGit from "src/main";

export class BranchStatusBar {
    constructor(
        private statusBarEl: HTMLElement,
        private readonly plugin: ObsidianGit
    ) {
        this.statusBarEl.addClass("mod-clickable");
        this.statusBarEl.onClickEvent((_) => {
            this.plugin.switchBranch().catch((e) => plugin.displayError(e));
        });
    }

    async display() {
        if (this.plugin.gitReady) {
            const current =
                await this.plugin.gitManager.readCurrentBranchFromVault();
            if (current != undefined) {
                this.statusBarEl.setText(current);
            } else {
                this.statusBarEl.empty();
            }
        } else {
            this.statusBarEl.empty();
        }
    }

    remove() {
        this.statusBarEl.remove();
    }
}
