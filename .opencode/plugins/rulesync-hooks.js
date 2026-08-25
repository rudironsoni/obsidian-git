export const RulesyncHooksPlugin = async ({ $ }) => {
  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        await $`echo 'obsidian-git harness active | Vitest + WDIO | edit .rulesync only'`;
      }
    },
    "tool.execute.after": async (input) => {
      {
        const __re = new RegExp("Write|Edit");
        if (__re.test(input.tool)) {
          await $`git diff --name-only | grep '\\.ts$' >/dev/null && pnpm run tsc || true`;
        }
      }
    },
    "tool.execute.before": async (input) => {
      {
        const __re = new RegExp("Bash");
        if (__re.test(input.tool)) {
          await $`echo 'Executing bash command. Do not edit generated agent files; change .rulesync/ instead.'`;
        }
      }
    },
  };
};
