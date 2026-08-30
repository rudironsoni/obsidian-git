import svelteParser from "svelte-eslint-parser";
import tsParser from "@typescript-eslint/parser";
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintPluginSvelte from "eslint-plugin-svelte";
import obsidianmd from "eslint-plugin-obsidianmd";
import { defineConfig } from "eslint/config";

export default defineConfig(
    {
        ignores: [
            "**/node_modules/",
            "**/main.js",
            "eslint.config.mjs",
            "esbuild.config.mjs",
            "scripts/**/*.py",
            "scripts/**/*.sh",
            ".obsidian-cache/",
            "e2e/vaults/",
            "tests/test-vault/",
        ],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    ...eslintPluginSvelte.configs["flat/prettier"],
    // Official Obsidian plugin rules. Keep plugin-registration objects unscoped.
    // Force rule-bearing TS/JS configs onto plugin source so tests/e2e/WDIO
    // are not scanned as plugin code.
    ...obsidianmd.configs.recommended.map((config) => {
        if (!config.rules) {
            return config;
        }
        const filesJson = JSON.stringify(config.files ?? []);
        if (filesJson.includes("package.json")) {
            return config;
        }
        return { ...config, files: ["src/**/*.ts"] };
    }),
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    args: "all",
                    argsIgnorePattern: "^_",
                    caughtErrors: "all",
                    caughtErrorsIgnorePattern: "^_",
                    destructuredArrayIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    ignoreRestSiblings: true,
                },
            ],
            // Pre-existing plugin logging (`console.error` in catch paths) and
            // status-bar/modal layout use inline styles. Wrong to rewrite as
            // part of enabling the official plugin; keep as warnings-free
            // debt until those call sites are migrated.
            "obsidianmd/rule-custom-message": "off",
            "obsidianmd/no-static-styles-assignment": "off",
        },
    },
    {
        files: ["**/*.svelte"],
        languageOptions: {
            parser: svelteParser,
            parserOptions: {
                extraFileExtensions: [".svelte"],
                parser: tsParser,
            },
        },
        rules: {
            "no-undef": "off",
        },
    },
    {
        files: ["eslint.config.mjs", "esbuild.config.mjs"],
        languageOptions: {
            parserOptions: {
                projectService: false,
            },
        },
    },
    {
        files: ["e2e/**/*.ts", "wdio.conf.mts"],
        ...tseslint.configs.disableTypeChecked,
        languageOptions: {
            ...tseslint.configs.disableTypeChecked.languageOptions,
            parserOptions: {
                projectService: false,
            },
        },
    }
);
