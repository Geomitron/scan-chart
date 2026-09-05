import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

interface BuildProvenance {
	readonly scanChartVersion: string
	readonly scanChartCommit: string
	readonly scanChartDirty: boolean
	readonly sourceTreeSha256: string
}

function git(args: readonly string[]): string {
	return execFileSync('git', [...args], { encoding: 'utf8' }).trim()
}

function sourceTreeSha256(): string {
	const files = git([
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
	])
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

function packageVersion(): string {
	const value: unknown = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
	if (typeof value !== 'object' || value === null || !('version' in value) || typeof value.version !== 'string') {
		throw new Error('package.json does not contain a string version')
	}
	return value.version
}

function isBuildProvenance(value: unknown): value is BuildProvenance {
	return typeof value === 'object'
		&& value !== null
		&& 'scanChartVersion' in value
		&& typeof value.scanChartVersion === 'string'
		&& 'scanChartCommit' in value
		&& typeof value.scanChartCommit === 'string'
		&& 'scanChartDirty' in value
		&& typeof value.scanChartDirty === 'boolean'
		&& 'sourceTreeSha256' in value
		&& typeof value.sourceTreeSha256 === 'string'
}

function assertBuiltProvenance(expected: BuildProvenance, environment: NodeJS.ProcessEnv): void {
	const output = execFileSync(process.execPath, [
		join('dist', 'ch-identity', 'ch-identity.cjs'),
		'provenance',
	], { encoding: 'utf8', env: environment })
	const actual: unknown = JSON.parse(output)
	if (!isBuildProvenance(actual)) throw new Error('Built ch-identity returned invalid provenance')
	const keys = [
		'scanChartVersion',
		'scanChartCommit',
		'scanChartDirty',
		'sourceTreeSha256',
	] satisfies readonly (keyof BuildProvenance)[]
	for (const key of keys) {
		if (actual[key] !== expected[key]) {
			throw new Error(`Built provenance mismatch for ${key}: ${String(actual[key])} != ${String(expected[key])}`)
		}
	}
}

function main(): void {
	const expected: BuildProvenance = {
		scanChartVersion: packageVersion(),
		scanChartCommit: git(['rev-parse', 'HEAD']),
		scanChartDirty: git(['status', '--porcelain']).length > 0,
		sourceTreeSha256: sourceTreeSha256(),
	}
	const environment = {
		...process.env,
		SCAN_CHART_BUILD_COMMIT: expected.scanChartCommit,
		SCAN_CHART_BUILD_DIRTY: String(expected.scanChartDirty),
		SCAN_CHART_BUILD_SOURCE_TREE_SHA256: expected.sourceTreeSha256,
		SCAN_CHART_BUILD_VERSION: expected.scanChartVersion,
	}
	const root = process.cwd()
	execFileSync(process.execPath, [
		join(root, 'node_modules', 'tsup', 'dist', 'cli-default.js'),
		'--config',
		join('tools', 'ch-identity', 'tsup.config.ts'),
	], { env: environment, stdio: 'inherit' })
	assertBuiltProvenance(expected, environment)
	execFileSync(process.execPath, [
		join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
		join('tools', 'ch-identity', 'package-release.ts'),
	], { env: environment, stdio: 'inherit' })
}

main()
