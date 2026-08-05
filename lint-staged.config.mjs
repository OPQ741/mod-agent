/**
 * lint-staged：仅对暂存区文件运行校验，避免全量扫描
 * @type {import('lint-staged').Configuration}
 */
export default {
  // JS/TS：先 ESLint 自动修复，再 Prettier 格式化
  "*.{js,mjs,cjs,ts,mts,cts}": ["eslint --fix", "prettier --write"],
  // 数据与样式类文件：仅格式化（注意：prettier 不支持 svg，故单独排除）
  "*.{json,jsonc,yml,yaml,css,scss,html,xml}": ["prettier --write"],
  // Markdown：Prettier 格式化 + markdownlint 修复 + VitePress 链接校验
  "*.md": ["prettier --write", "markdownlint-cli2 --fix", "node scripts/verify-doc-links.mjs"],
}
