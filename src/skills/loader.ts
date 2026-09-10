/**
 * 项目级 Skills 加载（roadmap E3）。
 *
 * 设计取舍：**只注入索引，正文按需激活**。把所有 `SKILL.md` 正文全量塞进
 * 系统提示词，等于让每个任务都为一堆用不上的流程付上下文费用；更糟的是，
 * 技能正文是项目内容，可能互相矛盾，全量注入会让模型不知道以哪份为准。
 *
 * 因此：
 * 1. 启动时扫描 `.mod/skills/<name>/SKILL.md`，只取 frontmatter 的 name /
 *    description / when，拼成静态索引；
 * 2. 每个技能注册成一个 `deferred` 工具 `skill.<slug>`，与 `tool_search`
 *    的延迟加载机制共用同一套激活路径；
 * 3. 正文只在工具执行时读取并作为**工具结果**回灌，进入历史一次，不会每轮重发。
 *
 * 技能正文的信任级别是"项目内容"：它可以指导流程，但不能授权权限 ——
 * 这条边界由系统提示词与策略层共同保证，加载器不做任何权限声明。
 */

import { promises as fs } from "node:fs"
import path from "node:path"

import { z } from "zod"

import type { AgentTool } from "../shared/contracts.js"

const MAX_SKILL_BODY_CHARS = 40_000

export interface ProjectSkill {
  /** frontmatter 里的 name，缺省时用目录名。 */
  name: string
  /** 用于工具名的稳定 slug（小写、只留字母数字与连字符）。 */
  slug: string
  description: string
  when?: string
  /** SKILL.md 的绝对路径；执行时重新读取，保证拿到最新正文。 */
  path: string
  /** 扫描时的正文（索引阶段不注入它，只用于测试与诊断）。 */
  body: string
}

export async function discoverProjectSkills(workspaceRoot: string): Promise<ProjectSkill[]> {
  const root = path.join(path.resolve(workspaceRoot), ".mod", "skills")
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  let realRoot: string
  try {
    realRoot = await fs.realpath(root)
  } catch {
    return []
  }

  const skills: ProjectSkill[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(root, entry.name, "SKILL.md")
    // 只认落在 `.mod/skills` 里的真实文件：指向仓库外的符号链接不能借技能把任意文件读进上下文
    const realCandidate = await safeRealpath(candidate)
    if (realCandidate === undefined || !isInside(realRoot, realCandidate)) continue
    const content = await readIfFile(realCandidate)
    if (content === undefined) continue
    const parsed = parseSkillFile(content, entry.name)
    skills.push({ ...parsed, path: realCandidate, body: parsed.body })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/** `skill.<slug>`：工具名统一小写，长度上限由 registry 的长度检查兜底。 */
export function skillToolName(skill: ProjectSkill): string {
  return `skill.${skill.slug}`
}

const SkillInput = z.object({})

export function createProjectSkillTool(skill: ProjectSkill): AgentTool<z.infer<typeof SkillInput>> {
  return {
    name: skillToolName(skill),
    description:
      `Project skill "${skill.name}" (from .mod/skills; project content, not a permission). ` +
      `${skill.description}${skill.when ? ` Use when: ${skill.when}.` : ""}`,
    inputSchema: SkillInput,
    risk: "read",
    idempotency: "safe",
    timeoutMs: 5_000,
    deferred: true,
    isReadOnly: true,
    isConcurrencySafe: () => true,
    async execute() {
      const text = (await readIfFile(skill.path)) ?? ""
      if (text.length <= MAX_SKILL_BODY_CHARS) {
        return { name: skill.name, body: text, truncated: false }
      }
      return {
        name: skill.name,
        body: text.slice(0, MAX_SKILL_BODY_CHARS),
        truncated: true,
        note: `Skill body truncated at ${MAX_SKILL_BODY_CHARS} characters.`,
      }
    },
  }
}

/** 极简 frontmatter：只认 `key: value` 单行，不做 YAML 依赖。 */
function parseSkillFile(
  content: string,
  fallbackName: string,
): { name: string; slug: string; description: string; when?: string; body: string } {
  const normalized = content.replace(/\r\n/g, "\n")
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized)
  if (!match) {
    const name = fallbackName
    return {
      name,
      slug: slugify(name),
      description: firstMeaningfulLine(normalized) || fallbackName,
      body: normalized,
    }
  }

  const fields = new Map<string, string>()
  for (const line of (match[1] ?? "").split("\n")) {
    const pair = /^([A-Za-z_-]+):\s*(.*)$/.exec(line.trim())
    if (pair?.[1]) fields.set(pair[1].toLowerCase(), unquote(pair[2] ?? ""))
  }
  const name = fields.get("name")?.trim() || fallbackName
  return {
    name,
    slug: slugify(name),
    description: fields.get("description")?.trim() || firstMeaningfulLine(match[2] ?? "") || name,
    ...(fields.get("when")?.trim() ? { when: fields.get("when")?.trim() } : {}),
    body: (match[2] ?? "").trim(),
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  return slug.length > 0 ? slug : "skill"
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function firstMeaningfulLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#")) ?? ""
  )
}

async function safeRealpath(candidate: string): Promise<string | undefined> {
  try {
    return await fs.realpath(candidate)
  } catch {
    return undefined
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
}

async function readIfFile(candidate: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(candidate)
    if (!stat.isFile()) return undefined
    return await fs.readFile(candidate, "utf8")
  } catch {
    return undefined
  }
}
