/** Runs a script under Supervisor and exits with its final code. */
import { Supervisor } from "../../src/index.ts"

const [script, ...args] = process.argv.slice(2) as [string, ...Array<string>]
Supervisor.run({ script, args, onStart: (attempt) => attempt < 5 }).then((code) => process.exit(code))
