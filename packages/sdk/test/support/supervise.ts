/** Runs a script under Supervisor (with automatic rollback when --home is given) and exits with its final code. */
import { Supervisor } from "../../src/index.ts"

const argv = process.argv.slice(2)
const homeIndex = argv.indexOf("--home")
const home = homeIndex === -1 ? undefined : argv.splice(homeIndex, 2)[1]
const [script, ...args] = argv as [string, ...Array<string>]
Supervisor.run({
  script,
  args,
  ...(home ? { home } : {}),
  onStart: (attempt) => attempt < 6,
  onRollback: ({ toSeq }) => console.error(`supervisor: rolled back to #${toSeq}`)
}).then((code) => process.exit(code))
