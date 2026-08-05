// @ts-check
// ESLint v10 flat config
// 文档：https://eslint.org/docs/latest/use/configure/configuration-files
import js from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"

export default tseslint.config(
  // 全局忽略（与 .gitignore / .prettierignore 保持一致）
  {
    ignores: [
      "node_modules/",
      "dist/",
      "build/",
      "out/",
      "coverage/",
      "docs/.vitepress/cache/",
      "docs/.vitepress/dist/",
      ".workbuddy/dist-build/",
      ".research/",
      ".workbuddy/",
      "temp/",
      "tmp/",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // 所有 JS/TS 源文件：Node 环境
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // CLI 工具允许使用 console
      "no-console": "off",
      // 允许未使用的函数参数以 _ 开头（常见于占位参数）
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

  // CommonJS 文件
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
    },
  },
)
