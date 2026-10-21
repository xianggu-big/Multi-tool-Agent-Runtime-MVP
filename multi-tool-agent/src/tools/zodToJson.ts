// src/tools/zodToJson.ts — 将 Zod schema 转换为 JSON Schema（供模型 tool calling 使用）
// 仅支持本项目实际用到的 Zod 子集，避免引入额外依赖。

import { z, ZodTypeAny } from 'zod';

interface JSONSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JSONSchema;
  additionalProperties?: boolean;
  [k: string]: unknown;
}

function convert(schema: ZodTypeAny): JSONSchema {
  // 处理可选 / 默认值包装
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return convert((schema as any)._def.innerType);
  }
  if (schema instanceof z.ZodNullable) {
    const inner = convert((schema as any)._def.innerType);
    inner.type = inner.type ?? 'string';
    return inner;
  }
  if (schema instanceof z.ZodString) {
    const def: JSONSchema = { type: 'string' };
    const desc = (schema as any)._def.description;
    if (desc) def.description = desc;
    return def;
  }
  if (schema instanceof z.ZodNumber) {
    const def: JSONSchema = { type: 'number' };
    const desc = (schema as any)._def.description;
    if (desc) def.description = desc;
    return def;
  }
  if (schema instanceof z.ZodBoolean) {
    const def: JSONSchema = { type: 'boolean' };
    const desc = (schema as any)._def.description;
    if (desc) def.description = desc;
    return def;
  }
  if (schema instanceof z.ZodEnum) {
    const def: JSONSchema = { type: 'string', enum: (schema as any)._def.values };
    const desc = (schema as any)._def.description;
    if (desc) def.description = desc;
    return def;
  }
  if (schema instanceof z.ZodArray) {
    const def: JSONSchema = { type: 'array', items: convert((schema as any)._def.element) };
    const desc = (schema as any)._def.description;
    if (desc) def.description = desc;
    return def;
  }
  if (schema instanceof z.ZodObject) {
    const shape = (schema as any)._def.shape();
    const properties: Record<string, JSONSchema> = {};
    const required: string[] = [];
    for (const key of Object.keys(shape)) {
      const field = shape[key];
      properties[key] = convert(field);
      // 非可选字段视为必填
      if (!(field instanceof z.ZodOptional) && !(field instanceof z.ZodDefault)) {
        required.push(key);
      }
    }
    const def: JSONSchema = { type: 'object', properties };
    if (required.length) def.required = required;
    const desc = (schema as any)._def.description;
    if (desc) def.description = desc;
    return def;
  }
  if (schema instanceof z.ZodRecord) {
    return { type: 'object', additionalProperties: true };
  }
  if (schema instanceof z.ZodAny) {
    return {};
  }
  // 兜底
  return { type: 'string' };
}

export function zodToJsonSchema(schema: ZodTypeAny): JSONSchema {
  const out = convert(schema);
  out.additionalProperties = false;
  return out;
}
