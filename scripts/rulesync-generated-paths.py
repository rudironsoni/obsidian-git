#!/usr/bin/env python3
"""Print generated Rulesync output paths, excluding Cursor Cloud environment.json."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP = {ROOT / ".cursor" / "environment.json"}

PATTERNS = [
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    "QWEN.md",
    "kilo.jsonc",
    "opencode.jsonc",
    ".mcp.json",
    ".cursor/mcp.json",
    ".rules",
    ".aiignore",
    ".cursorignore",
    ".geminiignore",
    ".github/copilot-instructions.md",
]
DIRS = [
    ".cursor",
    ".claude",
    ".codex",
    ".agent",
    ".agents",
    ".copilot",
    ".opencode",
    ".github/agents",
    ".github/skills",
    ".github/prompts",
    ".github/hooks",
    ".vscode",
]


def main() -> None:
    seen: set[str] = set()
    for pattern in PATTERNS:
        path = ROOT / pattern
        if path.is_file() and path not in SKIP:
            seen.add(pattern)

    for directory in DIRS:
        base = ROOT / directory
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if not path.is_file() or path in SKIP:
                continue
            rel = path.relative_to(ROOT).as_posix()
            if rel == ".cursor/environment.json":
                continue
            seen.add(rel)

    for rel in sorted(seen):
        print(rel)


if __name__ == "__main__":
    main()
