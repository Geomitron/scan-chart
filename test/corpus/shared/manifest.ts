import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'

import { getExtension } from './files'

export interface Manifest {
	inputRoot: string
	createdAt: string
	relPaths: string[]
}

const SKIPPED_DIRECTORIES = new Set(['__MACOSX', '.git', 'node_modules'])

/** Builds or loads the sorted chart-folder manifest shared by corpus adapters. */
export async function ensureManifest(manifestPath: string, inputRoot: string, regenerate: boolean): Promise<Manifest> {
	const resolvedInput = resolve(inputRoot)
	if (!regenerate && existsSync(manifestPath)) {
		try {
			const raw = await readFile(manifestPath, 'utf8')
			const manifest = JSON.parse(raw) as Manifest
			if (Array.isArray(manifest.relPaths)) {
				if (!sameResolvedPath(manifest.inputRoot, resolvedInput)) {
					throw new Error(
						`Cached manifest was built for ${manifest.inputRoot}, but --input is ${resolvedInput}. ` +
							'Pass --regenerateManifest to rebuild it for this corpus.',
					)
				}
				return manifest
			}
		} catch (err) {
			if (err instanceof Error && err.message.includes('Cached manifest was built for')) throw err
			console.warn(`[manifest] Failed to read existing manifest, regenerating. ${err}`)
		}
	}

	const relPaths: string[] = []
	console.log(`[manifest] Enumerating chart folders under ${resolvedInput}`)
	await walkChartFolders(resolvedInput, resolvedInput, relPaths)
	relPaths.sort()

	const manifest: Manifest = {
		inputRoot: resolvedInput,
		createdAt: new Date().toISOString(),
		relPaths,
	}
	await mkdir(dirname(manifestPath), { recursive: true })
	await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
	return manifest
}

/** Recursively walks a corpus and appends chart-folder relative paths. */
export async function walkChartFolders(root: string, dir: string, out: string[]): Promise<void> {
	let entries
	try {
		entries = await readdir(dir, { withFileTypes: true })
	} catch (err) {
		console.warn(`[manifest] Skipping unreadable directory ${dir}: ${err}`)
		return
	}

	const subdirs: string[] = []
	const fileExts: string[] = []
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRECTORIES.has(entry.name)) subdirs.push(entry.name)
		} else if (entry.isFile()) {
			fileExts.push(getExtension(entry.name))
		}
	}

	if (subdirs.length === 0 && appearsToBeChartFolder(fileExts)) {
		out.push(toPosix(relative(root, dir)))
		return
	}

	for (const subdir of subdirs) {
		await walkChartFolders(root, join(dir, subdir), out)
	}
}

/** Returns true for terminal folders containing notes plus at least one audio file. */
export function appearsToBeChartFolder(extensions: string[]): boolean {
	const ext = extensions.map(extension => extension.toLowerCase())
	const containsNotes = ext.includes('chart') || ext.includes('mid')
	const containsAudio = ext.some(extension => extension === 'ogg' || extension === 'mp3' || extension === 'wav' || extension === 'opus')
	return containsNotes && containsAudio
}

/** Converts OS-specific separators to manifest-stable POSIX separators. */
export function toPosix(path: string): string {
	return path.split(sep).join(posix.sep)
}

function sameResolvedPath(a: string, b: string): boolean {
	const left = resolve(a)
	const right = resolve(b)
	return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}
