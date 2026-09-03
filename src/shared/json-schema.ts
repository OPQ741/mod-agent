/**
 * Zod → JSON Schema 转换器。
 *
 * 为什么自己写而不引三方库：工具 schema 是**下发给模型的契约**，任何不兼容特性
 * （`$ref` 解引用失败、`oneOf` 展开错、默认值丢失）都会让模型拿到一份与运行时校验
 * 规则不一致的描述，从而产生"我以为能传、实际被拒"的工具调用。自己写可以把支持面
 * 钉死在一个确定的子集上，并对不支持的类型显式失败，而不是静默产出错误 schema。
 */

import { z } from "zod"

export interface JsonSchemaObject {
  type?: string | string[]
  description?: string
  properties?: Record<string, JsonSchemaObject>
  required?: string[]
  additionalProperties?: boolean | JsonSchemaObject
  items?: JsonSchemaObject
  enum?: unknown[]
  const?: unknown
  default?: unknown
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  pattern?: string
  anyOf?: JsonSchemaObject[]
}

const UNSUPPORTED = "__unsupported__"

/** 把 Zod schema 转成 JSON Schema（draft 2020-12 的子集）。 */
export function toJsonSchema(schema: z.ZodTypeAny): JsonSchemaObject {
  const out = convert(schema)
  if (out === UNSUPPORTED) {
    throw new Error(
      `Unsupported Zod type in tool schema: ${schema.constructor?.name ?? "unknown"}. ` +
        "Only object/string/number/int/boolean/array/enum/literal/optional/default/nullable/union/record are supported.",
    )
  }
  return out
}

function convert(schema: z.ZodTypeAny): JsonSchemaObject | typeof UNSUPPORTED {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def: Record<string, any> = (schema as any)._def ?? {}
  const description: string | undefined = def.description
  const base = (next: JsonSchemaObject): JsonSchemaObject =>
    description ? { ...next, description } : next

  const typeName: string | undefined = def.typeName

  switch (typeName) {
    case "ZodObject": {
      const shape: Record<string, z.ZodTypeAny> =
        typeof def.shape === "function" ? def.shape() : (def.shape ?? {})
      const properties: Record<string, JsonSchemaObject> = {}
      const required: string[] = []
      for (const [key, value] of Object.entries(shape)) {
        const converted = convert(value as z.ZodTypeAny)
        if (converted === UNSUPPORTED) return UNSUPPORTED
        properties[key] = converted
        if (!isOptional(value as z.ZodTypeAny)) required.push(key)
      }
      const unknownKeys = def.unknownKeys ?? "strip"
      return base({
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        ...(unknownKeys === "passthrough" ? { additionalProperties: true } : {}),
        ...(unknownKeys === "strict" ? { additionalProperties: false } : {}),
      })
    }
    case "ZodString": {
      const out: JsonSchemaObject = { type: "string" }
      for (const check of def.checks ?? []) {
        if (check.kind === "min") out.minLength = check.value
        else if (check.kind === "max") out.maxLength = check.value
        else if (check.kind === "startsWith") out.pattern = `^${escapeRegExp(check.value)}`
        else if (check.kind === "endsWith") out.pattern = `${escapeRegExp(check.value)}$`
        else if (check.kind === "regex") out.pattern = check.regex?.source
      }
      return base(out)
    }
    case "ZodNumber": {
      const out: JsonSchemaObject = { type: "number" }
      let isInt = false
      for (const check of def.checks ?? []) {
        if (check.kind === "int") isInt = true
        else if (check.kind === "min") out.minimum = check.value
        else if (check.kind === "max") out.maximum = check.value
      }
      if (isInt) out.type = "integer"
      return base(out)
    }
    case "ZodBoolean":
      return base({ type: "boolean" })
    case "ZodArray": {
      const items = convert(def.type as z.ZodTypeAny)
      if (items === UNSUPPORTED) return UNSUPPORTED
      const out: JsonSchemaObject = { type: "array", items }
      const min = def.exactLength ?? def.minLength
      const max = def.exactLength ?? def.maxLength
      if (typeof min?.value === "number") out.minItems = min.value
      if (typeof max?.value === "number") out.maxItems = max.value
      return base(out)
    }
    case "ZodEnum":
      return base({ type: "string", enum: [...(def.values ?? [])] })
    case "ZodLiteral":
      return base({ const: def.value })
    case "ZodOptional": {
      const inner = convert(def.innerType as z.ZodTypeAny)
      return inner === UNSUPPORTED ? UNSUPPORTED : inner
    }
    case "ZodNullable": {
      const inner = convert(def.innerType as z.ZodTypeAny)
      if (inner === UNSUPPORTED) return UNSUPPORTED
      return { anyOf: [inner, { type: "null" }] }
    }
    case "ZodDefault": {
      const inner = convert(def.innerType as z.ZodTypeAny)
      if (inner === UNSUPPORTED) return UNSUPPORTED
      const defaultValue = typeof def.defaultValue === "function" ? def.defaultValue() : undefined
      return { ...inner, ...(defaultValue !== undefined ? { default: defaultValue } : {}) }
    }
    case "ZodUnion": {
      const options: JsonSchemaObject[] = []
      for (const option of def.options ?? []) {
        const converted = convert(option as z.ZodTypeAny)
        if (converted === UNSUPPORTED) return UNSUPPORTED
        options.push(converted)
      }
      return base({ anyOf: options })
    }
    case "ZodRecord": {
      const valueType = convert((def.valueType ?? z.unknown()) as z.ZodTypeAny)
      if (valueType === UNSUPPORTED) return UNSUPPORTED
      return base({ type: "object", additionalProperties: valueType })
    }
    case "ZodAny":
    case "ZodUnknown":
      return base({})
    case "ZodEffects": {
      // .refine() / .transform() 不改变 wire 形状，转内部 schema 即可
      const inner = convert(def.schema as z.ZodTypeAny)
      return inner === UNSUPPORTED ? UNSUPPORTED : base(inner)
    }
    default:
      return UNSUPPORTED
  }
}

function isOptional(schema: z.ZodTypeAny): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const typeName: string | undefined = (schema as any)._def?.typeName
  return typeName === "ZodOptional" || typeName === "ZodDefault"
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** 工具 schema 的形态校验：下发前先确认能转，避免运行时才发现不兼容。 */
export function assertConvertible(schema: z.ZodTypeAny, toolName: string): JsonSchemaObject {
  try {
    return toJsonSchema(schema)
  } catch (err) {
    throw new Error(
      `Tool "${toolName}" has an input schema that cannot be converted to JSON Schema: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    )
  }
}
