interface IgnoreRule {
    /** Directory of the `.gitignore` that contributed this rule, or "". */
    sourceDir: string;
    negated: boolean;
    directoryOnly: boolean;
    /** Pattern is relative to `sourceDir` (contained a `/`). */
    anchored: boolean;
    regex: RegExp;
}

/**
 * Matches pathnames against `.gitignore` / `info/exclude` rules.
 *
 * The matcher is used so `status` can classify untracked files without
 * putting them in the in-memory worktree for libgit2 to inspect.
 */
export class GitIgnore {
    private readonly rules: IgnoreRule[] = [];
    private negationCount = 0;

    get hasNegations(): boolean {
        return this.negationCount > 0;
    }

    /**
     * Adds the rules from one ignore file.
     *
     * @param sourceDir repository-relative directory containing the file
     * (`""` for the worktree root or for `.git/info/exclude`).
     */
    addFile(sourceDir: string, content: string): void {
        for (const raw of content.split("\n")) {
            const rule = parseRule(sourceDir, raw);
            if (!rule) continue;
            this.rules.push(rule);
            if (rule.negated) this.negationCount += 1;
        }
    }

    /**
     * Returns true when `path` itself or any parent directory is ignored.
     * Used for files nested under a `dir/` rule.
     */
    ignoresPathOrParent(path: string): boolean {
        if (this.ignores(path, false)) return true;
        let dir = parentOf(path);
        while (dir !== "") {
            if (this.ignores(dir, true)) return true;
            dir = parentOf(dir);
        }
        return false;
    }

    /** Returns true when `path` (repository-relative) is ignored. */
    ignores(path: string, isDirectory: boolean): boolean {
        let ignored = false;
        for (const rule of this.rules) {
            if (!pathIsUnder(path, rule.sourceDir)) continue;
            const relative =
                rule.sourceDir === ""
                    ? path
                    : path.substring(rule.sourceDir.length + 1);
            if (relative === "") continue;
            if (rule.directoryOnly && !isDirectory) {
                // A `dir/` rule ignores the directory and everything in it
                // once the directory itself has been classified as ignored.
                continue;
            }
            if (rule.regex.test(relative)) {
                ignored = !rule.negated;
            }
        }
        return ignored;
    }

    /**
     * Returns true when a directory can be skipped entirely during a vault
     * walk because it is ignored and no later negation can un-ignore a child.
     */
    canSkipDirectory(path: string): boolean {
        if (!this.ignores(path, true)) return false;
        if (!this.hasNegations) return true;
        // A negation might un-ignore a child; keep walking.
        return false;
    }
}

function parseRule(sourceDir: string, raw: string): IgnoreRule | undefined {
    let line = raw.replace(/\r$/, "");
    if (line === "" || line.startsWith("#")) return undefined;
    // Unescaped trailing spaces are ignored.
    line = line.replace(/(?<!\\) +$/, "").replace(/\\ /g, " ");
    if (line === "") return undefined;

    let negated = false;
    if (line.startsWith("!")) {
        negated = true;
        line = line.substring(1);
    }
    if (line.startsWith("\\")) {
        line = line.substring(1);
    }

    let directoryOnly = false;
    if (line.endsWith("/")) {
        directoryOnly = true;
        line = line.slice(0, -1);
    }
    if (line === "") return undefined;

    const anchored = line.includes("/");
    const pattern = anchored && line.startsWith("/") ? line.substring(1) : line;
    return {
        sourceDir,
        negated,
        directoryOnly,
        anchored,
        regex: globToRegExp(pattern, anchored),
    };
}

function parentOf(path: string): string {
    const index = path.lastIndexOf("/");
    return index <= 0 ? "" : path.substring(0, index);
}

function pathIsUnder(path: string, dir: string): boolean {
    if (dir === "") return true;
    return path === dir || path.startsWith(`${dir}/`);
}

/**
 * Converts a gitignore glob into a regular expression that is matched
 * against the path relative to the ignore file's directory.
 */
function globToRegExp(pattern: string, anchored: boolean): RegExp {
    let source = "^";
    // Unanchored patterns match in any directory, including the current one.
    if (!anchored) {
        source += "(?:.*/)?";
    }
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i]!;
        if (char === "*") {
            if (pattern[i + 1] === "*") {
                // `**` matches across directories. A following `/` is
                // optional so `**/foo` also matches `foo` at this level.
                i += 1;
                if (pattern[i + 1] === "/") {
                    i += 1;
                    source += "(?:.*/)?";
                } else {
                    source += ".*";
                }
            } else {
                source += "[^/]*";
            }
            continue;
        }
        if (char === "?") {
            source += "[^/]";
            continue;
        }
        if (char === "[") {
            const close = pattern.indexOf("]", i + 1);
            if (close > i) {
                source += pattern.substring(i, close + 1);
                i = close;
                continue;
            }
        }
        if ("+()^$.{}|\\".includes(char)) {
            source += `\\${char}`;
        } else {
            source += char;
        }
    }
    source += "$";
    return new RegExp(source);
}
