import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    // Defaults from eslint-config-next.
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Prisma's generated client.
    "src/generated/**",
    // Node preload shim — necessarily CommonJS.
    "scripts/*.cjs",
    // Verification harness, not shipped application code.
    "e2e-verify.mjs",
    "diag.mjs",
    "shot.mjs",
  ]),
]);

export default eslintConfig;
