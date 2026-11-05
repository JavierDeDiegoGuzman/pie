/**
 * The agent: Pie with the official plugins (an OpenCode Go model, the base
 * prompt, AGENTS.md, read/write/edit/bash) plus a short prompt that tells it
 * it is this app. No extra tools: it applies its changes with
 * `npm run apply` through bash (see AGENTS.md).
 */
import * as path from "node:path"
import { codingTools, contextFiles, opencodeGo, systemPrompt } from "@pie-agent/plugins"
import { Plugin } from "pie-agent"

export const MODEL = process.env.PIE_MODEL ?? "opencode-go/deepseek-v4.1-flash"
// The working copy (not the release that is running): that is what the agent edits.
const APP_DIR = path.resolve(process.env.PIE_SOURCE ?? path.join(import.meta.dirname, ".."))

const self = Plugin.define({
  id: "self-app",
  setup: (ctx) =>
    ctx.prompt.transform((parts) =>
      void parts.push({
        key: "self-app",
        text: `You are a personal assistant and, at the same time, the app the user is talking to you through. ` +
          `The app's source is ${APP_DIR} (see AGENTS.md there). When the user asks for a change to the app, edit it ` +
          `and apply it with \`npm run apply -- "what changed"\`. Answer briefly: the user is usually on a phone.`
      })
    )
})

export const agentPlugins = [opencodeGo, systemPrompt, contextFiles, codingTools, self]
