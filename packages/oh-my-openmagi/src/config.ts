import path from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import { z } from "zod"
import { executors } from "./types"

const model = z.string().regex(/^[^/\s]+\/[^\s]+$/, "Model must be provider/model")
const duration = z.number().int().positive().max(2147483647)

export const configSchema = z
  .object({
    council: z
      .object({
        model: model.optional(),
        members: z
          .object({ melchior: model.optional(), balthasar: model.optional(), casper: model.optional() })
          .strict()
          .default({}),
        fallbackModels: z.array(model).default([]),
      })
      .strict()
      .default({ members: {}, fallbackModels: [] }),
    executors: z.partialRecord(z.enum(executors), model).default({}),
    reporting: z
      .object({
        intervalMs: z
          .number()
          .int()
          .positive()
          .max(31 * 86400000)
          .default(3600000),
      })
      .strict()
      .default({ intervalMs: 3600000 }),
    resilience: z
      .object({
        requestTimeoutMs: duration.default(180000),
        stallTimeoutMs: duration.default(1800000),
        retryBaseMs: duration.default(15000),
        retryMaxMs: duration.default(1800000),
      })
      .strict()
      .default({ requestTimeoutMs: 180000, stallTimeoutMs: 1800000, retryBaseMs: 15000, retryMaxMs: 1800000 }),
    verification: z
      .array(
        z
          .object({
            name: z.string().min(1),
            command: z.array(z.string()).min(1),
            cwd: z.string().optional(),
            timeoutMs: duration.default(120000),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
export type Settings = z.infer<typeof configSchema>
export async function loadConfig(directory: string) {
  const file = Bun.file(path.join(directory, ".magi", "openmagi.jsonc"))
  if (!(await file.exists())) return configSchema.parse({})
  const errors: ParseError[] = []
  const value: unknown = parse(await file.text(), errors, { allowTrailingComma: true })
  if (errors.length) throw new Error("Invalid .magi/openmagi.jsonc: " + JSON.stringify(errors))
  return configSchema.parse(value)
}
