/**
 * The official Pie extensions. Pass the ones you want to Pie.layer:
 *
 *   Pie.layer({ plugins: [opencodeGo, systemPrompt, contextFiles, codingTools] })
 *   Pie.layer({ plugins: defaults })   // the same four
 */
import type { Plugin } from "pie-agent"
import codingTools from "./coding-tools/index.ts"
import contextFiles from "./context-files/index.ts"
import opencodeGo from "./opencode-go/index.ts"
import systemPrompt from "./system-prompt/index.ts"
import todo from "./todo/index.ts"

export { codingTools, contextFiles, opencodeGo, systemPrompt, todo }
export * as OpenCodeGo from "./opencode-go/provider.ts"

/** A coding agent: an OpenCode Go model, the base prompt, AGENTS.md files and read/write/edit/bash. */
export const defaults: ReadonlyArray<Plugin.Plugin> = [opencodeGo, systemPrompt, contextFiles, codingTools]
