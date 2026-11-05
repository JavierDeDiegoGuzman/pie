/**
 * The registries and the PluginHost that fills them: what every extension is
 * loaded into.
 */
import { Layer } from "effect"
import { PluginHost } from "./PluginHost.ts"
import { Registries } from "./Registry.ts"
import { Composition } from "./State.ts"

export const layer = Layer.effect(PluginHost, PluginHost.make).pipe(
  Layer.provideMerge(Layer.effect(Registries, Registries.make)),
  Layer.provideMerge(Layer.effect(Composition, Composition.make))
)
