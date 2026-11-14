// Loads each entry point of package.json's "exports" by the package's own name, in plain Node, as a package user
// would: with import, and with require. Bundlers accept imports that Node refuses (a named import from a CommonJS
// module, say), so a build that only a bundler can load fails here. It's JavaScript run by plain Node, not TypeScript
// run by tsx, because tsx's loader would resolve modules its own way and could hide what Node refuses.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { name, exports } = require('../package.json')

for (const entry of Object.keys(exports)) {
	const specifier = entry === '.' ? name : `${name}/${entry.slice(2)}`
	const esmNames = Object.keys(await import(specifier)).sort().join()
	const cjsNames = Object.keys(require(specifier)).sort().join()
	if (!esmNames || !cjsNames) throw new Error(`${specifier}: a build exports nothing`)
	if (esmNames !== cjsNames) throw new Error(`${specifier}: the ESM and CommonJS builds export different names`)
}
