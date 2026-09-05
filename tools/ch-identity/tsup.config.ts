import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { defineConfig } from 'tsup'

const packageJson: unknown = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))

function packageVersion(value: unknown): string {
	if (typeof value !== 'object' || value === null || !('version' in value) || typeof value.version !== 'string') {
		throw new Error('package.json does not contain a string version')
	}
	return value.version
}

function requiredBuildValue(name: string): string {
	const value = process.env[name]
	if (value === undefined) throw new Error(`Missing build provenance: ${name}`)
	return value
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
		'process.env.SCAN_CHART_BUILD_COMMIT': JSON.stringify(requiredBuildValue('SCAN_CHART_BUILD_COMMIT')),
		'process.env.SCAN_CHART_BUILD_DIRTY': JSON.stringify(requiredBuildValue('SCAN_CHART_BUILD_DIRTY')),
		'process.env.SCAN_CHART_BUILD_SOURCE_TREE_SHA256': JSON.stringify(requiredBuildValue('SCAN_CHART_BUILD_SOURCE_TREE_SHA256')),
		'process.env.SCAN_CHART_BUILD_VERSION': JSON.stringify(packageVersion(packageJson)),
	},
})
