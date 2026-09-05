import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { defineConfig } from 'tsup'

function commit(): string {
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
	} catch {
		return 'unknown'
	}
}

function dirty(): boolean {
	try {
		return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0
	} catch {
		return true
	}
}

function sourceTreeSha256(): string {
	const files = execFileSync('git', [
		'ls-files',
		'--cached',
		'--others',
		'--exclude-standard',
		'--',
		'src',
		'tools',
		'package.json',
		'tsconfig.json',
		'tsconfig.test.json',
	], { encoding: 'utf8' })
		.split(/\r?\n/)
		.filter(Boolean)
		.sort()
	const hash = createHash('sha256')
	for (const file of files) {
		hash.update(file.replaceAll('\\', '/'))
		hash.update('\0')
		hash.update(readFileSync(file))
		hash.update('\0')
	}
	return hash.digest('hex')
}

const packageJson: unknown = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))

function packageVersion(value: unknown): string {
	if (typeof value !== 'object' || value === null || !('version' in value) || typeof value.version !== 'string') {
		throw new Error('package.json does not contain a string version')
	}
	return value.version
}

export default defineConfig({
	entry: { 'ch-identity': 'tools/ch-identity/cli.ts' },
	format: ['cjs'],
	platform: 'node',
	target: 'node24',
	bundle: true,
	noExternal: ['@awasm/noble', '@geomitron/midi-file', 'lodash', 'rfc4648'],
	splitting: false,
	clean: true,
	outDir: 'dist/ch-identity',
	outExtension: () => ({ js: '.cjs' }),
	define: {
		__SCAN_CHART_COMMIT__: JSON.stringify(commit()),
		__SCAN_CHART_DIRTY__: JSON.stringify(dirty()),
		__SCAN_CHART_SOURCE_TREE_SHA256__: JSON.stringify(sourceTreeSha256()),
		__SCAN_CHART_VERSION__: JSON.stringify(packageVersion(packageJson)),
	},
})
