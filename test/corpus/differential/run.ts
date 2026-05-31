import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import { BASELINE_LABEL, DEFAULT_SNAPSHOTS_DIR } from '../shared/constants'
import { ensureManifest } from '../shared/manifest'
import { snapshotMetadataMatches, snapshotPath, writeSnapshotMetadata } from '../shared/snapshot'
import { writeInvestigationBundles, type BundleInput } from '../shared/bundles'
import { compareSnapshots, summaryLines, writeComparisonReport } from './compare'
import { getBaselineBTracks, getWorkingTreeBTracks } from './btracks'
import { defaultWorkerCount, writeSnapshotWithWorkerPool } from './scan-pool'

const argv = yargs(hideBin(process.argv))
	.options({
		input: { alias: 'i', type: 'string', demandOption: true, normalize: true, describe: 'Corpus root folder.' },
		output: { alias: 'o', type: 'string', default: DEFAULT_SNAPSHOTS_DIR, normalize: true, describe: 'Snapshot/report output folder.' },
		report: { type: 'string', normalize: true, describe: 'Human-readable report path.' },
		maxBundles: { type: 'number', default: 25, describe: 'Maximum investigation bundles to write.' },
		maxReportCharts: { type: 'number', default: 1000, describe: 'Maximum changed chart details to retain in the report.' },
		only: { choices: ['hash', 'all'] as const, default: 'all' as const, describe: 'Restrict reported diffs.' },
		regenerateManifest: { type: 'boolean', default: false, describe: 'Rebuild manifest even when cached.' },
		regenerateBaseline: { type: 'boolean', default: false, describe: 'Rebuild the cached baseline snapshot.' },
		workers: { alias: 'w', type: 'number', default: defaultWorkerCount(), describe: 'Snapshot scan worker process count.' },
	})
	.help()
	.parseSync()

void main()

/** Runs the fused differential scan command. */
async function main(): Promise<void> {
	const inputRoot = resolve(argv.input)
	const outputDir = resolve(argv.output)
	await mkdir(outputDir, { recursive: true })
	const manifest = await ensureManifest(join(outputDir, 'manifest.json'), inputRoot, argv.regenerateManifest)

	const baselinePath = snapshotPath(outputDir, BASELINE_LABEL)
	if (!argv.regenerateBaseline && existsSync(baselinePath) && await snapshotMetadataMatches(baselinePath, BASELINE_LABEL, inputRoot)) {
		console.log(`[corpus:diff] Reusing cached baseline snapshot ${baselinePath}`)
	} else {
		console.log(`[corpus:diff] Building baseline snapshot ${baselinePath}`)
		await writeSnapshotWithWorkerPool(manifest, inputRoot, baselinePath, 'baseline', argv.workers)
		await writeSnapshotMetadata(baselinePath, { label: BASELINE_LABEL, inputRoot })
	}

	const workingPath = snapshotPath(outputDir, 'working-tree')
	console.log(`[corpus:diff] Building fresh working-tree snapshot ${workingPath}`)
	await writeSnapshotWithWorkerPool(manifest, inputRoot, workingPath, 'working-tree', argv.workers)
	await writeSnapshotMetadata(workingPath, { label: 'working-tree', inputRoot })

	const result = await compareSnapshots(baselinePath, workingPath, argv.only, argv.maxReportCharts)
	for (const line of summaryLines(result)) console.log(line)

	const reportPath = resolve(argv.report ?? join(outputDir, `diff_${BASELINE_LABEL}__vs__working-tree.txt`))
	await writeComparisonReport(result, reportPath, baselinePath, workingPath)
	console.log(`[corpus:diff] Report written to ${reportPath}`)

	const bundleInputs = result.diffSet.map<BundleInput>(sample => {
		let baselineBTracks: Awaited<ReturnType<typeof getBaselineBTracks>> | null = null
		let workingBTracks: Awaited<ReturnType<typeof getWorkingTreeBTracks>> | null = null
		return {
			relPath: sample.relPath,
			inputRoot,
			diffLabel: 'baseline vs working tree',
			diffs: sample.diffs,
			btracks: {
				labelA: 'baseline',
				labelB: 'working',
				getA: async (instrument, difficulty) => {
					baselineBTracks ??= await getBaselineBTracks(inputRoot, sample.relPath)
					return baselineBTracks.get(`${instrument}|${difficulty}`) ?? null
				},
				getB: async (instrument, difficulty) => {
					workingBTracks ??= await getWorkingTreeBTracks(inputRoot, sample.relPath)
					return workingBTracks.get(`${instrument}|${difficulty}`) ?? null
				},
			},
		}
	})
	await writeInvestigationBundles(bundleInputs, join(outputDir, 'diffs'), argv.maxBundles)
	if (result.stats.different > argv.maxBundles) {
		console.warn(`[corpus:diff] SYSTEMIC CHANGE: ${result.stats.different} charts differ; wrote only ${argv.maxBundles} bundles.`)
	}

	const failing =
		result.stats.different +
		result.stats.onlyInBaseline +
		result.stats.onlyInWorking +
		result.stats.errorBaseline +
		result.stats.errorWorking +
		result.stats.errorBoth
	process.exit(failing > 0 ? 1 : 0)
}
