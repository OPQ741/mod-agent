# mod-agent · 统一入口
#
# 目的：给人类协作者与 AI 编码代理一个跨语言的单一命令面，
# 目标与 package.json scripts 保持一一对应，实际执行仍走 npm。
# 常用目标速查：
#   make install        首次拉仓后一次性装依赖与 Git 钩子
#   make docs           本地预览文档站（VitePress，默认 http://localhost:5173）
#   make docs-build     构建静态产物到 docs/.vitepress/dist
#   make lint           全量校验（ESLint + markdownlint + 链接 + AGENTS 命令 + Prettier）
#   make lint-fix       自动修复格式与 lint 问题
#   make typecheck      TypeScript 严格模式类型检查
#   make links          校验 docs/ 页内 / 跨页链接
#   make agents         校验 AGENTS.md 里引用的 npm run 命令真实存在
#   make format-check   仅检查格式
#   make check          lint + typecheck（CI 会跑的最小子集）

.PHONY: help install docs docs-build lint lint-fix format format-check typecheck links agents check

help:
	@sed -n '2,20p' Makefile

install:
	npm ci

docs:
	npm run docs

docs-build:
	npm run docs:build

lint:
	npm run lint

lint-fix:
	npm run lint:fix

format:
	npm run format

format-check:
	npm run format:check

typecheck:
	npm run typecheck

links:
	npm run lint:links

agents:
	npm run lint:agents

check: lint typecheck
