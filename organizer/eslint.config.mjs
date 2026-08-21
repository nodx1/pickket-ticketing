import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // `_` 접두사는 "의도적 미사용"의 표준 신호 — v2 위임으로 비워둔 compat 시그니처 인자 등.
      // (규칙을 끄는 게 아니라 미사용 판정에서 제외. consumer 앱과 동일 컨벤션.)
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Node CommonJS scripts (.cjs) — `require()` 사용이 정상
    "**/*.cjs",
  ]),
]);

export default eslintConfig;
