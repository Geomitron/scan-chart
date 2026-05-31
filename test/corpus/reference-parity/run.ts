import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { blake3 } from '@awasm/noble'
import { base64url } from 'rfc4648'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { calculateTrackHash, parseChartAndIni } from 'src'
import { scanParsedChart } from 'src/chart/scan-parsed-chart'
import type { Difficulty, Instrument } from 'src/types'

import { DEFAULT_SNAPSHOTS_DIR, REPO_ROOT } from '../shared/constants'
import { loadChartFolderFiles } from '../shared/files'
import { ensureManifest } from '../shared/manifest'
import { writeInvestigationBundles, type BundleInput } from '../shared/bundles'

interface ChJsonEntry {
	song: string
	trackHashes: { instrument: string; difficulty: string; trackHash: string }[]
}

interface ScanChartHashes {
	chartHash: string
	tracks: { instrument: Instrument; difficulty: Difficulty; hash: string; btrack?: Uint8Array }[]
}

interface ParityMismatch {
	relPath: string
	label: string
	diffs: { key: string; ch?: string; sc?: string }[]
	scTracks?: Map<string, Uint8Array>
}

const DEFAULT_CH_BIN = resolve(REPO_ROOT, 'test', 'corpus', 'reference-parity', 'ch-bin', 'Release', 'net8.0', 'HashScanTool.exe')

const argv = yargs(hideBin(process.argv))
	.options({
		input: { alias: 'i', type: 'string', demandOption: true, normalize: true, describe: 'Corpus root folder.' },
		chBin: { type: 'string', default: DEFAULT_CH_BIN, normalize: true, describe: 'Path to HashScanTool.exe.' },
		chJson: { type: 'string', default: join(DEFAULT_SNAPSHOTS_DIR, 'ch-hashes.json'), normalize: true, describe: 'HashScanTool JSON output.' },
		chLog: { type: 'string', default: join(DEFAULT_SNAPSHOTS_DIR, 'ch-stdout.log'), normalize: true, describe: 'HashScanTool stdout/stderr log.' },
		report: { type: 'string', default: join(DEFAULT_SNAPSHOTS_DIR, 'ch-diff.txt'), normalize: true, describe: 'Report path.' },
		scCache: { type: 'string', default: join(DEFAULT_SNAPSHOTS_DIR, 'sc-hashes.json'), normalize: true, describe: 'scan-chart hash cache.' },
		skipChRun: { type: 'boolean', default: false, describe: 'Reuse existing --ch-json.' },
		skipScRescan: { type: 'boolean', default: false, describe: 'Reuse existing --sc-cache when possible.' },
		maxBundles: { type: 'number', default: 25, describe: 'Maximum investigation bundles to write.' },
	})
	.help()
	.parseSync()

void main()

/** Runs scan-chart against HashScanTool and reports per-track hash divergences. */
async function main(): Promise<void> {
	const inputRoot = resolve(argv.input)
	const chBin = resolve(argv.chBin)
	const chJsonPath = resolve(argv.chJson)
	const chLogPath = resolve(argv.chLog)
	const reportPath = resolve(argv.report)
	const scCachePath = resolve(argv.scCache)
	await mkdir(dirname(chJsonPath), { recursive: true })
	await mkdir(dirname(chLogPath), { recursive: true })
	await mkdir(dirname(reportPath), { recursive: true })
	await mkdir(dirname(scCachePath), { recursive: true })

	if (!argv.skipChRun) {
		if (!existsSync(chBin)) {
			console.error(`HashScanTool not found at ${chBin}. Pass --ch-bin <path> or place the binary at the default location.`)
			process.exit(2)
		}
		await runHashScanTool(chBin, inputRoot, chJsonPath, chLogPath)
	} else if (!existsSync(chJsonPath)) {
		console.error(`--skip-ch-run was set but ${chJsonPath} does not exist.`)
		process.exit(2)
	}

	const chRaw = JSON.parse(await readFile(chJsonPath, 'utf8')) as Record<string, ChJsonEntry>
	validateChJson(chRaw, chJsonPath)
	const chByHash = new Map<string, { key: string; entry: ChJsonEntry }>()
	const chByTrackHash = new Map<string, string>()
	for (const [key, entry] of Object.entries(chRaw)) {
		const normalizedKey = stripPad(key)
		chByHash.set(normalizedKey, { key, entry })
		for (const track of entry.trackHashes) chByTrackHash.set(stripPad(track.trackHash), normalizedKey)
	}

	const manifest = await ensureManifest(join(DEFAULT_SNAPSHOTS_DIR, 'manifest.json'), inputRoot, false)
	const scCache = await loadScCache(scCachePath)
	const nextCache: Record<string, Omit<ScanChartHashes, 'tracks'> & { tracks: Omit<ScanChartHashes['tracks'][number], 'btrack'>[] }> = {}
	const mismatches: ParityMismatch[] = []
	const stats = { total: 0, parseFailed: 0, matched: 0, identical: 0, trackDiff: 0, linked: 0, notParsedByCh: 0 }

	for (const relPath of manifest.relPaths) {
		stats.total++
		const sc = argv.skipScRescan && scCache.get(relPath) ? scCache.get(relPath)! : await scanFolder(inputRoot, relPath, false)
		if (!sc) {
			stats.parseFailed++
			continue
		}
		nextCache[relPath] = { chartHash: sc.chartHash, tracks: sc.tracks.map(({ instrument, difficulty, hash }) => ({ instrument, difficulty, hash })) }
		const chMatch = chByHash.get(stripPad(sc.chartHash))
		if (!chMatch) {
			const linked = await tryLinkByBchart(join(inputRoot, relPath), chByTrackHash)
			if (!linked) {
				stats.notParsedByCh++
				continue
			}
			stats.linked++
			const linkedEntry = chByHash.get(linked.chartHashKey)!
			const diffs = compareTracks(sc, linkedEntry.entry)
			if (diffs.length > 0) {
				const rescanned = await scanFolder(inputRoot, relPath, true)
				mismatches.push({ relPath, label: `chartHash differs, linked via ${linked.linkingTrack}`, diffs, scTracks: tracksToBTracks(rescanned) })
				stats.trackDiff++
			}
			continue
		}
		stats.matched++
		const diffs = compareTracks(sc, chMatch.entry)
		if (diffs.length === 0) {
			stats.identical++
		} else {
			const rescanned = await scanFolder(inputRoot, relPath, true)
			mismatches.push({ relPath, label: 'trackHash mismatch', diffs, scTracks: tracksToBTracks(rescanned) })
			stats.trackDiff++
		}
	}

	await writeFile(scCachePath, JSON.stringify(nextCache), 'utf8')
	await writeReport(reportPath, inputRoot, chJsonPath, stats, mismatches)
	await writeInvestigationBundles(
		mismatches.map<BundleInput>(mismatch => ({
			relPath: mismatch.relPath,
			inputRoot,
			diffLabel: mismatch.label,
			diffs: mismatch.diffs.map(diff => {
				const [instrument, difficulty] = diff.key.split('|') as [string, string]
				return {
					kind: 'changed',
					path: `notesData.trackHashes[${instrument}/${difficulty}].hash`,
					baseline: diff.ch,
					working: diff.sc,
					instrument,
					difficulty,
				}
			}),
			btracks: {
				labelA: 'hashscan',
				labelB: 'scan-chart',
				getA: async (instrument, difficulty) => readOptionalFile(join(inputRoot, mismatch.relPath, `${instrument}_${difficulty}.bchart`)),
				getB: async (instrument, difficulty) => mismatch.scTracks?.get(`${instrument}|${difficulty}`) ?? null,
			},
		})),
		join(DEFAULT_SNAPSHOTS_DIR, 'diffs'),
		argv.maxBundles,
	)
	if (mismatches.length > argv.maxBundles) {
		console.warn(`[corpus:parity] SYSTEMIC CHANGE: ${mismatches.length} charts differ; wrote only ${argv.maxBundles} bundles.`)
	}
	process.exit(mismatches.length > 0 ? 1 : 0)
}

async function runHashScanTool(chBin: string, inputRoot: string, jsonPath: string, logPath: string): Promise<void> {
	console.log(`[corpus:parity] running HashScanTool ${inputRoot} -> ${jsonPath}`)
	await new Promise<void>((res, rej) => {
		const log = createWriteStream(logPath)
		const child = spawn(chBin, ['scan', inputRoot, '--output', jsonPath], { stdio: ['ignore', 'pipe', 'pipe'] })
		child.stdout.pipe(log)
		child.stderr.pipe(log)
		child.on('error', rej)
		child.on('exit', code => {
			log.end()
			if (code === 0) res()
			else rej(new Error(`HashScanTool exited with code ${code}; see ${logPath}`))
		})
	})
}

async function scanFolder(inputRoot: string, relPath: string, includeBTrack: boolean): Promise<ScanChartHashes | null> {
	const files = await loadChartFolderFiles(join(inputRoot, relPath))
	const parseResult = parseChartAndIni(files)
	if (!parseResult.parsedChart) return null
	const chartHash = scanParsedChart(parseResult.parsedChart, false).chartHash
	const tracks = parseResult.parsedChart.trackData.map(track => {
		const output = calculateTrackHash(parseResult.parsedChart!, track.instrument, track.difficulty)
		return {
			instrument: track.instrument,
			difficulty: track.difficulty,
			hash: output.hash,
			btrack: includeBTrack ? output.btrack : undefined,
		}
	})
	return { chartHash, tracks }
}

function compareTracks(sc: ScanChartHashes, ch: ChJsonEntry): { key: string; ch?: string; sc?: string }[] {
	const chMap = new Map(ch.trackHashes.map(track => [`${track.instrument}|${track.difficulty}`, stripPad(track.trackHash)]))
	const diffs: { key: string; ch?: string; sc?: string }[] = []
	for (const track of sc.tracks) {
		const key = `${track.instrument}|${track.difficulty}`
		const chHash = chMap.get(key)
		if (chHash !== undefined && stripPad(track.hash) !== chHash) diffs.push({ key, ch: chHash, sc: stripPad(track.hash) })
	}
	return diffs.sort((a, b) => a.key.localeCompare(b.key))
}

async function tryLinkByBchart(folderAbs: string, chByTrackHash: Map<string, string>): Promise<{ chartHashKey: string; linkingTrack: string } | null> {
	const { readdir } = await import('node:fs/promises')
	const entries = await readdir(folderAbs, { withFileTypes: true })
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.bchart') || entry.name.endsWith('.scan-chart.bchart')) continue
		const data = new Uint8Array(await readFile(join(folderAbs, entry.name)))
		const trackHash = stripPad(base64url.stringify(blake3(data)))
		const chartHashKey = chByTrackHash.get(trackHash)
		if (chartHashKey) return { chartHashKey, linkingTrack: entry.name.replace(/\.bchart$/, '') }
	}
	return null
}

async function loadScCache(path: string): Promise<Map<string, ScanChartHashes>> {
	if (!existsSync(path)) return new Map()
	const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, ScanChartHashes>
	return new Map(Object.entries(raw))
}

async function writeReport(
	reportPath: string,
	inputRoot: string,
	chJsonPath: string,
	stats: Record<string, number>,
	mismatches: ParityMismatch[],
): Promise<void> {
	const out = createWriteStream(reportPath)
	const write = (line = '') => out.write(line + '\n')
	write('scan-chart vs HashScanTool reference parity')
	write(`input:   ${inputRoot}`)
	write(`ch-json: ${chJsonPath}`)
	write('')
	write('=== SUMMARY ===')
	for (const [key, value] of Object.entries(stats)) write(`${key}: ${value}`)
	write(`reported mismatches: ${mismatches.length}`)
	for (const mismatch of mismatches) {
		write('')
		write(`--- ${mismatch.relPath}`)
		write(mismatch.label)
		for (const diff of mismatch.diffs) write(`  ${diff.key}: hashscan=${diff.ch} scan-chart=${diff.sc}`)
	}
	await new Promise<void>((res, rej) => out.end((err: Error | null | undefined) => (err ? rej(err) : res())))
}

function validateChJson(chRaw: Record<string, ChJsonEntry>, chJsonPath: string): void {
	const bad = Object.entries(chRaw).find(([, entry]) => !entry || !Array.isArray(entry.trackHashes))
	if (bad) throw new Error(`${chJsonPath} contains entries without trackHashes; first bad key: ${bad[0]}`)
}

function tracksToBTracks(sc: ScanChartHashes | null): Map<string, Uint8Array> {
	return new Map((sc?.tracks ?? []).flatMap(track => (track.btrack ? [[`${track.instrument}|${track.difficulty}`, track.btrack] as const] : [])))
}

async function readOptionalFile(path: string): Promise<Uint8Array | null> {
	if (!existsSync(path)) return null
	return new Uint8Array(await readFile(path))
}

function stripPad(value: string): string {
	return value.replace(/=+$/u, '')
}
