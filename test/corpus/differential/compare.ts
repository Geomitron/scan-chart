import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { isHashPath, stripBase64Padding } from '../shared/normalize'
import { readSnapshot, type SnapshotRecord } from '../shared/snapshot'

export interface DiffEntry {
	kind: 'changed' | 'addedInWorking' | 'removedInWorking'
	path: string
	baseline: unknown
	working: unknown
	instrument?: string
	difficulty?: string
}

export interface DiffSample {
	relPath: string
	hashChanged: boolean
	trackHashChanged: boolean
	diffs: DiffEntry[]
	baseline?: SnapshotRecord
	working?: SnapshotRecord
}

export interface ComparisonResult {
	stats: {
		total: number
		identical: number
		different: number
		hashChangedCharts: number
		trackHashChangedCharts: number
		onlyInBaseline: number
		onlyInWorking: number
		errorBaseline: number
		errorWorking: number
		errorBoth: number
	}
	diffSet: DiffSample[]
	diffSetSampleLimit: number
	onlyInBaseline: string[]
	onlyInWorking: string[]
	errorSamples: { relPath: string; baseline?: string; working?: string }[]
}

/** Compares two sorted NDJSON snapshots using the normalized snapshot contract. */
export async function compareSnapshots(
	baselinePath: string,
	workingPath: string,
	only: 'hash' | 'all',
	diffSetSampleLimit = Number.POSITIVE_INFINITY,
): Promise<ComparisonResult> {
	const result: ComparisonResult = {
		stats: {
			total: 0,
			identical: 0,
			different: 0,
			hashChangedCharts: 0,
			trackHashChangedCharts: 0,
			onlyInBaseline: 0,
			onlyInWorking: 0,
			errorBaseline: 0,
			errorWorking: 0,
			errorBoth: 0,
		},
		diffSet: [],
		diffSetSampleLimit,
		onlyInBaseline: [],
		onlyInWorking: [],
		errorSamples: [],
	}

	const baselineIter = readSnapshot(baselinePath)
	const workingIter = readSnapshot(workingPath)
	let baselineNext = await baselineIter.next()
	let workingNext = await workingIter.next()

	while (!baselineNext.done || !workingNext.done) {
		const baseline = baselineNext.done ? null : baselineNext.value
		const working = workingNext.done ? null : workingNext.value

		if (baseline && (!working || baseline.relPath < working.relPath)) {
			result.stats.total++
			result.stats.onlyInBaseline++
			result.onlyInBaseline.push(baseline.relPath)
			baselineNext = await baselineIter.next()
			continue
		}
		if (working && (!baseline || working.relPath < baseline.relPath)) {
			result.stats.total++
			result.stats.onlyInWorking++
			result.onlyInWorking.push(working.relPath)
			workingNext = await workingIter.next()
			continue
		}

		result.stats.total++
		const baselineRecord = baseline!
		const workingRecord = working!
		const baselineError = baselineRecord.error
		const workingError = workingRecord.error
		if (baselineError || workingError) {
			if (baselineError && workingError) result.stats.errorBoth++
			else if (baselineError) result.stats.errorBaseline++
			else result.stats.errorWorking++
			result.errorSamples.push({ relPath: baselineRecord.relPath, baseline: baselineError, working: workingError })
		} else if (JSON.stringify(baselineRecord.snapshot) === JSON.stringify(workingRecord.snapshot)) {
			result.stats.identical++
		} else {
			const diffs = diffSnapshots(baselineRecord.snapshot, workingRecord.snapshot)
			const hashChanged = diffs.some(diff => diff.path === 'chartHash')
			const trackHashChanged = diffs.some(diff => diff.path.startsWith('notesData.trackHashes[') && diff.path.endsWith('.hash'))
			if (hashChanged) result.stats.hashChangedCharts++
			if (trackHashChanged) result.stats.trackHashChangedCharts++
			if (only === 'all' || hashChanged || trackHashChanged) {
				result.stats.different++
				if (result.diffSet.length < diffSetSampleLimit) {
					result.diffSet.push({
						relPath: baselineRecord.relPath,
						hashChanged,
						trackHashChanged,
						diffs,
					})
				}
			} else {
				result.stats.identical++
			}
		}

		baselineNext = await baselineIter.next()
		workingNext = await workingIter.next()
	}

	return result
}

/** Recursively deep-diffs normalized snapshots with semantic track array keys. */
export function diffSnapshots(baseline: unknown, working: unknown, path = ''): DiffEntry[] {
	if (isHashPath(path) && typeof baseline === 'string' && typeof working === 'string' && stripBase64Padding(baseline) === stripBase64Padding(working)) {
		return []
	}
	if (Object.is(baseline, working)) return []
	if (typeof baseline !== typeof working || baseline === null || working === null) {
		return [buildDiff('changed', path || '<root>', baseline, working)]
	}
	if (Array.isArray(baseline) || Array.isArray(working)) {
		if (!Array.isArray(baseline) || !Array.isArray(working)) {
			return [buildDiff('changed', path || '<root>', baseline, working)]
		}
		return diffArrays(baseline, working, path)
	}
	if (typeof baseline === 'object') {
		const out: DiffEntry[] = []
		const baselineObj = baseline as Record<string, unknown>
		const workingObj = working as Record<string, unknown>
		const keys = new Set([...Object.keys(baselineObj), ...Object.keys(workingObj)])
		for (const key of keys) {
			const subPath = path ? `${path}.${key}` : key
			if (!(key in baselineObj)) out.push(buildDiff('addedInWorking', subPath, undefined, workingObj[key]))
			else if (!(key in workingObj)) out.push(buildDiff('removedInWorking', subPath, baselineObj[key], undefined))
			else out.push(...diffSnapshots(baselineObj[key], workingObj[key], subPath))
		}
		return out
	}
	return [buildDiff('changed', path || '<root>', baseline, working)]
}

/** Writes the human-readable top report for a comparison result. */
export async function writeComparisonReport(result: ComparisonResult, reportPath: string, baselinePath: string, workingPath: string): Promise<void> {
	await mkdir(dirname(reportPath), { recursive: true })
	const out = createWriteStream(reportPath)
	const write = (line = '') => out.write(line + '\n')
	write('scan-chart differential scan')
	write(`baseline: ${baselinePath}`)
	write(`working:  ${workingPath}`)
	write('')
	for (const line of summaryLines(result)) write(line)
	if (result.diffSet.length > 0) {
		write('')
		const sampled = result.diffSet.length < result.stats.different
		write(sampled ? `=== DIFFERENT SAMPLES (${result.diffSet.length} of ${result.stats.different}) ===` : `=== DIFFERENT (${result.diffSet.length}) ===`)
		for (const sample of result.diffSet) {
			write('')
			write(`--- ${sample.relPath}`)
			write(`chartHash changed: ${sample.hashChanged}`)
			write(`trackHash changed: ${sample.trackHashChanged}`)
			for (const diff of sample.diffs.slice(0, 80)) {
				write(`[${diff.kind}] ${diff.path}`)
				write(`  baseline: ${truncate(diff.baseline)}`)
				write(`  working:  ${truncate(diff.working)}`)
			}
		}
	}
	writeList(out, 'ONLY IN BASELINE', result.onlyInBaseline)
	writeList(out, 'ONLY IN WORKING', result.onlyInWorking)
	if (result.errorSamples.length > 0) {
		write('')
		write('=== ERRORS ===')
		for (const sample of result.errorSamples) {
			write(`${sample.relPath}: baseline=${sample.baseline ?? '<none>'} working=${sample.working ?? '<none>'}`)
		}
	}
	await new Promise<void>((res, rej) => out.end((err: Error | null | undefined) => (err ? rej(err) : res())))
}

/** Returns console/report summary lines for a comparison result. */
export function summaryLines(result: ComparisonResult): string[] {
	return [
		`Total charts compared: ${result.stats.total}`,
		`  identical:                 ${result.stats.identical}`,
		`  different:                 ${result.stats.different}`,
		`    chartHash changed:       ${result.stats.hashChangedCharts}`,
		`    trackHash changed:       ${result.stats.trackHashChangedCharts}`,
		`  only in baseline:          ${result.stats.onlyInBaseline}`,
		`  only in working:           ${result.stats.onlyInWorking}`,
		`  errored in baseline only:  ${result.stats.errorBaseline}`,
		`  errored in working only:   ${result.stats.errorWorking}`,
		`  errored in both:           ${result.stats.errorBoth}`,
	]
}

function diffArrays(baseline: unknown[], working: unknown[], path: string): DiffEntry[] {
	const baselineKeyed = keyTrackArray(path, baseline)
	const workingKeyed = keyTrackArray(path, working)
	if (baselineKeyed && workingKeyed) {
		const out: DiffEntry[] = []
		const keys = new Set([...baselineKeyed.keys(), ...workingKeyed.keys()])
		for (const key of keys) {
			const subPath = `${path}[${key}]`
			if (!baselineKeyed.has(key)) out.push(buildDiff('addedInWorking', subPath, undefined, workingKeyed.get(key)))
			else if (!workingKeyed.has(key)) out.push(buildDiff('removedInWorking', subPath, baselineKeyed.get(key), undefined))
			else out.push(...diffSnapshots(baselineKeyed.get(key), workingKeyed.get(key), subPath))
		}
		return out
	}

	if (baseline.length !== working.length) return [buildDiff('changed', path || '<root>', `Array(${baseline.length})`, `Array(${working.length})`)]
	return baseline.flatMap((value, index) => diffSnapshots(value, working[index], `${path}[${index}]`))
}

function keyTrackArray(path: string, values: unknown[]): Map<string, unknown> | null {
	if (path !== 'notesData.trackHashes' && path !== 'notesData.noteCounts' && path !== 'notesData.maxNps') return null
	const keyed = new Map<string, unknown>()
	for (const value of values) {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return null
		const record = value as Record<string, unknown>
		if (typeof record.instrument !== 'string' || typeof record.difficulty !== 'string') return null
		keyed.set(`${record.instrument}/${record.difficulty}`, value)
	}
	return keyed
}

function buildDiff(kind: DiffEntry['kind'], path: string, baseline: unknown, working: unknown): DiffEntry {
	const track = path.match(/notesData\.(?:trackHashes|noteCounts|maxNps)\[([^/]+)\/([^\]]+)\]/)
	return {
		kind,
		path,
		baseline,
		working,
		instrument: track?.[1],
		difficulty: track?.[2],
	}
}

function writeList(out: NodeJS.WritableStream, label: string, values: string[]): void {
	if (values.length === 0) return
	out.write(`\n=== ${label} (${values.length}) ===\n`)
	for (const value of values) out.write(`${value}\n`)
}

function truncate(value: unknown, max = 240): string {
	const text = typeof value === 'string' ? value : JSON.stringify(value)
	if (text === undefined) return 'undefined'
	return text.length > max ? `${text.slice(0, max)} ...(+${text.length - max} chars)` : text
}
