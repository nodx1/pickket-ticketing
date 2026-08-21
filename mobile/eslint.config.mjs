import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/", ".expo/", "dist/", "*.js", "*.mjs"],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", ignoreRestSiblings: true }],
      "@typescript-eslint/no-explicit-any": "error",
      // Phase E.-1: @pickket/lib barrel import 차단 — env.ts 의 process.env 참조로 RN 런타임 폭발
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@pickket/lib",
              message:
                "@pickket/lib barrel import 금지. 반드시 @pickket/lib/api 처럼 deep import 사용 (env.ts process.env 참조로 RN 폭발).",
            },
          ],
        },
      ],
    },
  },
);
