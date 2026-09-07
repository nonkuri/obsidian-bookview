import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

// The same rules the community plugin review runs, so its findings show up here
// first: `npm run lint`.
export default tseslint.config(
  {
    ignores: [
      "main.js",
      "test/harness.js",
      "scripts/**",
      // Vendored verbatim; our own typings alongside it are checked by tsc.
      "src/vendor/**",
      "esbuild.config.mjs",
      "version-bump.mjs",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  }
);
