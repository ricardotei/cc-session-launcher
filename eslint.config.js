const { defineConfig } = require("eslint/config");
const raycastConfig = require("@raycast/eslint-config");

module.exports = defineConfig([
  { ignores: ["dist/**", "dist-cli/**", "node_modules/**", "raycast-env.d.ts"] },
  ...raycastConfig,
  // This config file is CommonJS, so require() is expected here.
  { files: ["eslint.config.js"], rules: { "@typescript-eslint/no-require-imports": "off" } },
]);
