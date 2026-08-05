/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // 中文提交信息不做大小写限制
    "subject-case": [0],
    // header 放宽到 120 字符
    "header-max-length": [2, "always", 120],
    // body 每行放宽到 200 字符（中文）
    "body-max-line-length": [2, "always", 200],
    "footer-max-line-length": [2, "always", 200],
  },
}
