/**
 * The fixed core: the parts the agent can use but not modify. Everything else
 * is a plugin loaded through the PluginHost.
 */
import { Layer } from "effect"
import { PluginHost } from "./PluginHost.ts"
import { PluginLoader } from "./PluginLoader.ts"
import { Registries } from "./Registry.ts"
import { Composition } from "./State.ts"

export const layer = Layer.effect(PluginLoader, PluginLoader.make).pipe(
  Layer.provideMerge(Layer.effect(PluginHost, PluginHost.make)),
  Layer.provideMerge(Layer.effect(Registries, Registries.make)),
  Layer.provideMerge(Layer.effect(Composition, Composition.make))
)
