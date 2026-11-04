/**
 * Built-in plugin: the base system prompt plus per-session environment
 * (cwd, date, platform). Replace or disable it to change the agent's persona.
 */
import { Effect } from "effect"
import { Plugin } from "pie-agent"

export const BASE_PROMPT = `You are Pie, a coding agent that works in the user's repository through tools.

Guidelines:
- Read before you edit. Use read to look at files and bash (ls, rg, find) to explore.
- Prefer edit for targeted changes; use write only for new files or full rewrites.
- Use bash to run builds, tests and other commands. Keep commands non-interactive.
- When a tool reports an error, read it and adjust instead of repeating the same call.
- If a tool result says its outcome is unknown, check the current state before retrying.
- Be concise. Show file paths when you reference code.`

export default Plugin.define({
  id: "system-prompt",
  setup: (ctx) =>
    Effect.gen(function*() {
      const text = typeof ctx.options.text === "string" ? ctx.options.text : BASE_PROMPT
      yield* ctx.prompt.transform((parts) => {
        parts.push({ key: "system-prompt/base", text })
      })
      yield* ctx.hook("context", (event) =>
        Effect.sync(() => {
          event.system.push({
            key: "system-prompt/environment",
            text: `Environment:\n- Working directory: ${event.cwd}\n- Date: ${new Date().toISOString().slice(0, 10)}\n- Platform: ${process.platform}`
          })
        }))
    })
})
