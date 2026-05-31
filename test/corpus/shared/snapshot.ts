import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import * as readline from 'node:readline'

import type { Manifest } from './manifest'
import type { NormalizedJson } from './normalize'

export interface SnapshotRecord {
	relPath: string
	snapshot?: NormalizedJson
	error?: string
}

export type SnapshotAdapter = (inputRoot: string, relPath: string) => Promise<SnapshotRecord>

export interface SnapshotMetadata {
	label: string
	inputRoot: string
	createdAt: string
}

/** Returns a readable string for thrown values captured in snapshot records. */
export function errorToString(err: unknown): string {
	if (err instanceof Error) return `${err.name}: ${err.message}`
	try {
		return JSON.stringify(err)
	} catch {
		return String(err)
	}
}

/** Writes one sorted NDJSON snapshot by scanning every manifest entry. */
export async function writeSnapshot(
	manifest: Manifest,
	inputRoot: string,
	outputPath: string,
	adapter: SnapshotAdapter,
): Promise<void> {
	await mkdir(dirname(outputPath), { recursive: true })
	const partialPath = `${outputPath}.partial`
	const out = createWriteStream(partialPath)
	let completed = 0
	let errors = 0
	for (const relPath of manifest.relPaths) {
		let record: SnapshotRecord
		try {
			record = await adapter(resolve(inputRoot), relPath)
		} catch (err) {
			record = { relPath, error: errorToString(err) }
		}
		if (record.error) errors++
		out.write(JSON.stringify(record) + '\n')
		completed++
		if (completed % 100 === 0 || completed === manifest.relPaths.length) {
			console.log(`[snapshot] ${completed}/${manifest.relPaths.length} scanned (${errors} errors)`)
		}
	}
	await new Promise<void>((res, rej) => out.end((err: Error | null | undefined) => (err ? rej(err) : res())))
	await finalizeSortedNdjson(partialPath, outputPath)
}

/** Streams a sorted snapshot NDJSON file into typed records. */
export async function* readSnapshot(path: string): AsyncGenerator<SnapshotRecord> {
	const stream = createReadStream(path, { encoding: 'utf8' })
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
	for await (const line of rl) {
		if (!line.trim()) continue
		try {
			yield JSON.parse(line) as SnapshotRecord
		} catch (err) {
			console.warn(`[snapshot] Skipping malformed line in ${path}: ${err}`)
		}
	}
}

/** Sorts and deduplicates a partial NDJSON snapshot by `relPath`. */
export async function finalizeSortedNdjson(partialPath: string, finalPath: string): Promise<void> {
	const records = new Map<string, string>()
	const stream = createReadStream(partialPath, { encoding: 'utf8' })
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
	for await (const line of rl) {
		if (!line.trim()) continue
		const record = JSON.parse(line) as SnapshotRecord
		records.set(record.relPath, line)
	}

	const tmpPath = `${finalPath}.tmp`
	const out = createWriteStream(tmpPath)
	for (const relPath of [...records.keys()].sort()) {
		out.write(records.get(relPath)! + '\n')
	}
	await new Promise<void>((res, rej) => out.end((err: Error | null | undefined) => (err ? rej(err) : res())))
	await rename(tmpPath, finalPath)
}

/** Returns the conventional snapshot path for a label. */
export function snapshotPath(outputDir: string, label: string): string {
	return join(outputDir, `${label}.ndjson`)
}

/** Returns the sidecar metadata path for a snapshot. */
export function snapshotMetadataPath(path: string): string {
	return `${path}.meta.json`
}

/** Writes the corpus identity metadata that makes snapshot cache reuse safe. */
export async function writeSnapshotMetadata(path: string, metadata: Omit<SnapshotMetadata, 'createdAt'>): Promise<void> {
	await writeFile(snapshotMetadataPath(path), JSON.stringify({ ...metadata, inputRoot: resolve(metadata.inputRoot), createdAt: new Date().toISOString() }, null, 2))
}

/** Returns true when an existing snapshot sidecar matches the requested corpus and label. */
export async function snapshotMetadataMatches(path: string, label: string, inputRoot: string): Promise<boolean> {
	try {
		const raw = await readFile(snapshotMetadataPath(path), 'utf8')
		const metadata = JSON.parse(raw) as SnapshotMetadata
		return metadata.label === label && sameResolvedPath(metadata.inputRoot, inputRoot)
	} catch {
		return false
	}
}

function sameResolvedPath(a: string, b: string): boolean {
	const left = resolve(a)
	const right = resolve(b)
	return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}
