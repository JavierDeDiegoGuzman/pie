/**
 * Where the bytes of files attached to messages live. The database keeps, per
 * file, its hash, type, size and the name `write` returned (`pie_attachments`);
 * the store keeps the bytes under that name. Events only carry the hash.
 *
 * - folder(dir): one file per content hash, written atomically. What
 *   `Storage.sqlite(file)` uses by default, in `attachments/` next to the file.
 * - memory: nothing survives the process. What `Storage.memory` uses.
 * - your own: any layer that provides `Attachments` (S3, R2, a NAS...), passed
 *   as `Pie.layer({ attachments })`.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Context, Effect, Layer } from "effect"

export class Attachments extends Context.Service<Attachments, {
  /** Stores the bytes of the file with this content hash (once) and returns its name in the store. */
  readonly write: (hash: string, data: Uint8Array) => Effect.Effect<string>
  /** The bytes stored under a name `write` returned, if they are still there. */
  readonly read: (name: string) => Effect.Effect<Uint8Array | undefined>
}>()("pie/Attachments") {}

/** Files in a folder, one per content hash, written atomically (a temporary file, then a rename). */
export const folder = (dir: string): Layer.Layer<Attachments> =>
  Layer.succeed(Attachments, Attachments.of({
    write: (hash, data) =>
      Effect.promise(async () => {
        const file = path.join(dir, hash)
        try {
          await fs.access(file)
        } catch {
          await fs.mkdir(dir, { recursive: true })
          const temp = `${file}.${process.pid}.tmp`
          await fs.writeFile(temp, data)
          await fs.rename(temp, file)
        }
        return hash
      }),
    read: (name) => Effect.promise(() => fs.readFile(path.join(dir, name)).then((b) => new Uint8Array(b), () => undefined))
  }))

/** In memory: nothing survives the process. */
export const memory: Layer.Layer<Attachments> = Layer.sync(Attachments, () => {
  const files = new Map<string, Uint8Array>()
  return Attachments.of({
    write: (hash, data) => Effect.sync(() => (files.set(hash, data), hash)),
    read: (name) => Effect.sync(() => files.get(name))
  })
})
