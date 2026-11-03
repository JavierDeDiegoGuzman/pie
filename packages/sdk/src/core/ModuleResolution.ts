/**
 * Lets plugin files that live anywhere (~/.pie/plugins, <repo>/.pie/plugins)
 * import "effect", "effect/*" and "@pie/sdk" without installing anything: bare
 * specifiers are resolved to the copies the running Pie uses. This also keeps
 * a single Effect runtime, which plugins need (services and fibers are shared).
 *
 * Uses Node's synchronous in-thread module hooks (module.registerHooks).
 */
import * as module from "node:module"

const SDK_ENTRY = new URL("../index.ts", import.meta.url).href

let registered = false

export const register = (): void => {
  if (registered) return
  const registerHooks = (module as { registerHooks?: (hooks: unknown) => unknown }).registerHooks
  if (typeof registerHooks !== "function") return
  registered = true
  const shared = (specifier: string): string | undefined => {
    if (specifier === "@pie/sdk") return SDK_ENTRY
    if (specifier === "effect" || specifier.startsWith("effect/") || specifier.startsWith("@effect/")) {
      try {
        return import.meta.resolve(specifier)
      } catch {
        return undefined
      }
    }
    return undefined
  }
  registerHooks({
    resolve: (
      specifier: string,
      context: unknown,
      next: (specifier: string, context: unknown) => unknown
    ) => {
      const url = shared(specifier)
      return url === undefined ? next(specifier, context) : { url, shortCircuit: true, format: "module" }
    }
  })
}
