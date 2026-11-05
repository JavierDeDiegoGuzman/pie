/**
 * Built-in plugin: the agent's tools. Like pi, the model gets few tools and
 * does the rest with bash; names, parameters and output limits follow pi so
 * models trained on pi-style harnesses feel at home.
 *
 *   read · write · edit · bash
 *
 * Paths are resolved against the session cwd.
 *
 * Durability: read/write are naturally idempotent. edit is made
 * idempotent: if an oldText is gone but its newText is already present, that
 * replacement counts as applied, so a re-run after a crash converges instead of
 * failing. bash is not idempotent: after a crash mid-command the model is told
 * the outcome is unknown.
 */
import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Effect, Schema } from "effect"
import { Plugin, type ToolOutput, defineTool } from "pie-agent"

export const MAX_LINES = 2000
/** Seconds; a command that never ends (e.g. find /) would otherwise block the run forever. */
export const DEFAULT_BASH_TIMEOUT = 300
export const MAX_BYTES = 50 * 1024

const resolve = (cwd: string, p: string | undefined) => path.resolve(cwd, p ?? ".")

const fail = (content: string): ToolOutput => ({ content, isError: true })

const attempt = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (e) => (e instanceof Error ? e.message : String(e)) })

/** Keeps the first lines/bytes (read). */
const truncateHead = (lines: ReadonlyArray<string>, maxLines = MAX_LINES, maxBytes = MAX_BYTES) => {
  const out: Array<string> = []
  let bytes = 0
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1
    if (out.length >= maxLines || bytes + size > maxBytes) return { lines: out, truncated: true }
    out.push(line)
    bytes += size
  }
  return { lines: out, truncated: false }
}

/** Keeps the last lines/bytes (bash: the end of the output matters most). */
const truncateTail = (text: string) => {
  const lines = text.split("\n")
  const out: Array<string> = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(lines[i]!) + 1
    if (out.length >= MAX_LINES || bytes + size > MAX_BYTES) return { text: out.reverse().join("\n"), truncated: true }
    out.push(lines[i]!)
    bytes += size
  }
  return { text: out.reverse().join("\n"), truncated: false }
}

interface ProcessResult {
  readonly code: number | null
  readonly output: string
  readonly timedOut: boolean
}

/** Runs a process; interrupting the Effect kills its whole process group. */
const run = (command: string, args: ReadonlyArray<string>, cwd: string, timeoutSeconds?: number) =>
  Effect.callback<ProcessResult, string>((resume) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    let timedOut = false
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
      } catch {
        // already gone
      }
    }
    const timer = timeoutSeconds === undefined ? undefined : setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutSeconds * 1000)
    child.stdout.on("data", (chunk) => (output += chunk))
    child.stderr.on("data", (chunk) => (output += chunk))
    child.on("error", (error) => {
      clearTimeout(timer)
      resume(Effect.fail(error.message))
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resume(Effect.succeed({ code, output, timedOut }))
    })
    return Effect.sync(() => {
      clearTimeout(timer)
      kill()
    })
  })

const read = defineTool({
  name: "read",
  description:
    `Read the contents of a file. Output is truncated to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). ` +
    `Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
  parameters: Schema.Struct({
    path: Schema.String.annotate({ description: "Path to the file to read (relative or absolute)" }),
    offset: Schema.optional(Schema.Int).annotate({ description: "Line number to start reading from (1-indexed)" }),
    limit: Schema.optional(Schema.Int).annotate({ description: "Maximum number of lines to read" })
  }),
  idempotent: true,
  execute: ({ limit, offset, path: p }, { cwd }) =>
    attempt(() => fs.readFile(resolve(cwd, p), "utf8")).pipe(
      Effect.map((text) => {
        const all = text.split("\n")
        const start = Math.max(0, (offset ?? 1) - 1)
        if (start >= all.length && all.length > 0) return fail(`offset ${offset} is beyond the end of the file (${all.length} lines)`)
        const slice = all.slice(start, limit === undefined ? undefined : start + limit)
        const { lines, truncated } = truncateHead(slice)
        const next = start + lines.length + 1
        const more = truncated || (limit !== undefined && start + limit < all.length)
        return {
          content: lines.join("\n") + (more ? `\n\n[${all.length - next + 1} more lines; continue with offset=${next}]` : ""),
          details: { totalLines: all.length, truncated }
        }
      }),
      Effect.catch((message) => Effect.succeed(fail(message)))
    )
})

const write = defineTool({
  name: "write",
  description:
    "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
  parameters: Schema.Struct({
    path: Schema.String.annotate({ description: "Path to the file to write (relative or absolute)" }),
    content: Schema.String.annotate({ description: "Content to write to the file" })
  }),
  idempotent: true,
  execute: ({ content, path: p }, { cwd }) => {
    const file = resolve(cwd, p)
    return attempt(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, content)
    }).pipe(
      Effect.as({ content: `Wrote ${Buffer.byteLength(content)} bytes to ${p}` }),
      Effect.catch((message) => Effect.succeed(fail(message)))
    )
  }
})

const Edit = Schema.Struct({
  oldText: Schema.String.annotate({
    description:
      "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call."
  }),
  newText: Schema.String.annotate({ description: "Replacement text for this targeted edit." })
})

const countOccurrences = (haystack: string, needle: string) => {
  if (needle.length === 0) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

const edit = defineTool({
  name: "edit",
  description:
    "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. " +
    "If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. " +
    "Do not include large unchanged regions just to connect distant changes.",
  parameters: Schema.Struct({
    path: Schema.String.annotate({ description: "Path to the file to edit (relative or absolute)" }),
    edits: Schema.Array(Edit).annotate({
      description:
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits."
    })
  }),
  idempotent: true,
  execute: ({ edits, path: p }, { cwd }) => {
    const file = resolve(cwd, p)
    return Effect.gen(function*() {
      const original = yield* attempt(() => fs.readFile(file, "utf8"))
      const ranges: Array<{ start: number; end: number; newText: string }> = []
      let alreadyApplied = 0
      for (const [i, e] of edits.entries()) {
        const n = countOccurrences(original, e.oldText)
        if (n === 1) {
          const start = original.indexOf(e.oldText)
          ranges.push({ start, end: start + e.oldText.length, newText: e.newText })
        } else if (n === 0 && e.newText.length > 0 && original.includes(e.newText)) {
          alreadyApplied++ // re-run after a crash: this replacement is already in the file
        } else if (n === 0) {
          return fail(`edits[${i}].oldText was not found in ${p}`)
        } else {
          return fail(`edits[${i}].oldText matches ${n} places in ${p}; add surrounding context to make it unique`)
        }
      }
      ranges.sort((a, b) => a.start - b.start)
      for (let i = 1; i < ranges.length; i++) {
        if (ranges[i]!.start < ranges[i - 1]!.end) return fail("edits overlap; merge them into one edit")
      }
      let result = original
      for (const r of [...ranges].reverse()) result = result.slice(0, r.start) + r.newText + result.slice(r.end)
      if (result !== original) yield* attempt(() => fs.writeFile(file, result))
      return {
        content: `Applied ${ranges.length} edit(s) to ${p}` + (alreadyApplied > 0 ? ` (${alreadyApplied} already applied)` : ""),
        details: { applied: ranges.length, alreadyApplied }
      }
    }).pipe(Effect.catch((message) => Effect.succeed(fail(message))))
  }
})

const bash = defineTool({
  name: "bash",
  description:
    `Execute a bash command in the current working directory. Returns stdout and stderr. ` +
    `Output is truncated to last ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). Timeout: ${DEFAULT_BASH_TIMEOUT}s unless given.`,
  parameters: Schema.Struct({
    command: Schema.String.annotate({ description: "Bash command to execute" }),
    timeout: Schema.optional(Schema.Int).annotate({ description: "Timeout in seconds (default 300)" })
  }),
  idempotent: false,
  execute: ({ command, timeout = DEFAULT_BASH_TIMEOUT }, { cwd }) =>
    run("bash", ["-c", command], cwd, timeout).pipe(
      Effect.map(({ code, output, timedOut }) => {
        const { text, truncated } = truncateTail(output.replace(/\n$/, ""))
        const notes = [
          truncated ? "[output truncated; showing the end]" : undefined,
          timedOut ? `[timed out after ${timeout}s]` : undefined,
          code !== 0 && !timedOut ? `[exit code ${code}]` : undefined
        ].filter(Boolean)
        return {
          content: [text.length > 0 ? text : "(no output)", ...notes].join("\n"),
          isError: timedOut || code !== 0,
          details: { exitCode: code, truncated, timedOut }
        }
      }),
      Effect.catch((message) => Effect.succeed(fail(message)))
    )
})

export const tools = [read, write, edit, bash]

export default Plugin.define({
  id: "coding-tools",
  setup: (ctx) =>
    ctx.tools.transform((registry) => {
      for (const tool of tools) registry.set(tool.name, tool)
    })
})
