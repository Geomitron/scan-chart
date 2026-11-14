// Loads each built entry point as a package user would, in plain Node: the ESM files with import and the CommonJS
// files with require. Bundlers accept imports that Node refuses (a named import from a CommonJS module, say), so a
// build that only a bundler can load fails here.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const entries = ['index', 'competitive']

for (const entry of entries) {
	const esm = await import(pathToFileURL(`dist/${entry}.mjs`).href)
	const cjs = require(`../dist/${entry}.js`)
	const esmNames = Object.keys(esm).sort().join()
	const cjsNames = Object.keys(cjs).sort().join()
	if (esmNames !== cjsNames) throw new Error(`dist/${entry}: the ESM and CommonJS builds export different names`)
	if (!esmNames) throw new Error(`dist/${entry}: exports nothing`)
}
