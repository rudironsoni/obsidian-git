import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const E2E_VAULT_DIR = path.join(repoRoot, "tests", "test-vault");

export function ensureE2eVaultGitRepo(vaultPath = E2E_VAULT_DIR): void {
    fs.mkdirSync(vaultPath, { recursive: true });
    const gitDir = path.join(vaultPath, ".git");
    if (fs.existsSync(gitDir)) {
        return;
    }
    execFileSync("git", ["init"], { cwd: vaultPath });
    execFileSync("git", ["config", "user.email", "e2e@obsidian-git.test"], {
        cwd: vaultPath,
    });
    execFileSync("git", ["config", "user.name", "obsidian-git e2e"], {
        cwd: vaultPath,
    });
    execFileSync("git", ["add", "-A"], { cwd: vaultPath });
    execFileSync(
        "git",
        ["commit", "--allow-empty", "-m", "e2e vault fixture"],
        { cwd: vaultPath }
    );
}
