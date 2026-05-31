import { existsSync } from 'node:fs'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import sanitize from 'sanitize-filename'

import { DOCS_URL } from './constants'
import { diffBTracks, type BTrackElementDiff } from './btrack'

export interface BundleDiff {
	path: string
	kind: string
	baseline: unknown
	working: unknown
	instrument?: string
	difficulty?: string
	firstDifferingElement?: BTrackElementDiff
}

export interface BundleInput {
	relPath: string
	inputRoot: string
	diffLabel: string
	diffs: BundleDiff[]
	btracks?: {
		labelA: string
		labelB: string
		getA: (instrument: string, difficulty: string) => Promise<Uint8Array | null>
		getB: (instrument: string, difficulty: string) => Promise<Uint8Array | null>
	}
}

/** Writes capped self-contained investigation bundles for a deterministic diff set. */
export async function writeInvestigationBundles(inputs: BundleInput[], outputRoot: string, maxBundles: number): Promise<void> {
	const selected = [...inputs].sort((a, b) => a.relPath.localeCompare(b.relPath)).slice(0, maxBundles)
	for (const input of selected) {
		await writeInvestigationBundle(input, join(outputRoot, sanitizeBundlePath(input.relPath)))
	}
}

/** Writes one investigation bundle with copied chart input and optional btrack bytes. */
export async function writeInvestigationBundle(input: BundleInput, bundleDir: string): Promise<void> {
	await mkdir(bundleDir, { recursive: true })
	const enrichedDiffs = await writeBTrackArtifacts(input, join(bundleDir, 'btrack'))
	await copyChartInputs(join(input.inputRoot, input.relPath), join(bundleDir, 'input'))
	await writeFile(join(bundleDir, 'diff.json'), JSON.stringify(enrichedDiffs, null, 2))
	await writeFile(join(bundleDir, 'INVESTIGATION.md'), buildInvestigationMarkdown(input, enrichedDiffs), 'utf8')
}

/** Returns a safe single-directory name for a corpus relative path. */
export function sanitizeBundlePath(relPath: string): string {
	return sanitize(relPath.replace(/[\\/]+/g, '__')) || 'root'
}

function buildInvestigationMarkdown(input: BundleInput, diffs: BundleDiff[]): string {
	const firstTrackDiff = diffs.find(diff => diff.instrument && diff.difficulty)
	const firstTick = diffs.map(diff => diff.firstDifferingElement?.tick).find(tick => tick !== undefined)
	const likelySource = likelySourceHint(input, diffs)
	return [
		`# Investigation: ${input.relPath}`,
		'',
		`Diff type: ${input.diffLabel}`,
		`Chart-format reference: ${DOCS_URL}`,
		'',
		'## Summary',
		`- Diff count: ${diffs.length}`,
		firstTrackDiff ? `- First changed track: ${firstTrackDiff.instrument}/${firstTrackDiff.difficulty}` : '- First changed track: none detected',
		firstTick !== undefined ? `- First differing btrack tick: ${firstTick}` : '- First differing btrack tick: not available',
		'',
		'## Start Here',
		`1. Open \`input/notes.chart\` or \`input/notes.mid\`${firstTick !== undefined ? ` near tick ${firstTick}` : ''}.`,
		`2. Compare the event semantics against ${DOCS_URL}.`,
		`3. Inspect likely source area: \`${likelySource}\`.`,
		'4. Use `diff.json` and `btrack/` to confirm which side changed.',
		'',
		'## Notable Diffs',
		...diffs.slice(0, 20).map(diff => `- \`${diff.path}\`: ${truncate(diff.baseline)} -> ${truncate(diff.working)}`),
		'',
	].join('\n')
}

async function writeBTrackArtifacts(input: BundleInput, btrackDir: string): Promise<BundleDiff[]> {
	const diffs = input.diffs.map(diff => ({ ...diff }))
	if (!input.btracks) return diffs
	const tracks = new Map<string, { instrument: string; difficulty: string }>()
	for (const diff of diffs) {
		if (diff.instrument && diff.difficulty) tracks.set(`${diff.instrument}|${diff.difficulty}`, diff as { instrument: string; difficulty: string })
	}
	if (tracks.size === 0) return diffs

	await mkdir(btrackDir, { recursive: true })
	for (const track of tracks.values()) {
		const a = await input.btracks.getA(track.instrument, track.difficulty)
		const b = await input.btracks.getB(track.instrument, track.difficulty)
		if (!a || !b) continue
		const baseName = `${track.instrument}_${track.difficulty}.bchart`
		await writeFile(join(btrackDir, `${input.btracks.labelA}.${baseName}`), a)
		await writeFile(join(btrackDir, `${input.btracks.labelB}.${baseName}`), b)
		const structural = diffBTracks(a, b)
		await writeFile(join(btrackDir, `${track.instrument}_${track.difficulty}.diff.json`), JSON.stringify(structural, null, 2))
		const first = structural[0]
		for (const diff of diffs) {
			if (diff.instrument === track.instrument && diff.difficulty === track.difficulty) diff.firstDifferingElement = first
		}
	}
	return diffs
}

async function copyChartInputs(sourceDir: string, targetDir: string): Promise<void> {
	await mkdir(targetDir, { recursive: true })
	for (const name of ['notes.chart', 'notes.mid', 'song.ini']) {
		const source = join(sourceDir, name)
		if (existsSync(source)) await cp(source, join(targetDir, basename(name)))
	}
}

function likelySourceHint(input: BundleInput, diffs: BundleDiff[]): string {
	if (diffs.some(diff => diff.path.includes('trackHash') || diff.path.includes('btrack'))) return 'src/chart/track-hasher.ts'
	if (diffs.some(diff => diff.path.startsWith('metadata') || diff.path.includes('ini'))) return 'src/ini/'
	return existsSync(join(input.inputRoot, input.relPath, 'notes.mid')) ? 'src/chart/midi-file-parser.ts' : 'src/chart/chart-file-parser.ts'
}

function truncate(value: unknown, max = 120): string {
	const text = typeof value === 'string' ? value : JSON.stringify(value)
	if (text === undefined) return 'undefined'
	return text.length > max ? `${text.slice(0, max)}...` : text
}
