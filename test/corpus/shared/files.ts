import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { File } from 'src/types'

const EMPTY_DATA = new Uint8Array(0)
const STUB_DATA_EXTENSIONS = new Set(['mp3', 'ogg', 'opus', 'wav', 'mp4', 'webm', 'avi', 'mpeg', 'vp8', 'ogv'])
const IGNORED_SCAN_FILES = [/\.bchart$/i]

/** Returns a lowercase extension without the dot. */
export function getExtension(fileName: string): string {
	const idx = fileName.lastIndexOf('.')
	return idx < 0 ? '' : fileName.slice(idx + 1).toLowerCase()
}

/** Returns true when a file extension is media data the scanners do not need to read. */
export function shouldStubFileData(fileName: string): boolean {
	return STUB_DATA_EXTENSIONS.has(getExtension(fileName))
}

/** Returns true when a file is a side artifact that must not be fed back into scan-chart. */
export function shouldIgnoreScannerInput(fileName: string): boolean {
	return IGNORED_SCAN_FILES.some(pattern => pattern.test(fileName))
}

/** Loads a chart folder into scan-chart's in-memory file shape, stubbing large media bytes. */
export async function loadChartFolderFiles(folderAbs: string): Promise<File[]> {
	const entries = await readdir(folderAbs, { withFileTypes: true })
	const files: File[] = []
	for (const entry of entries) {
		if (!entry.isFile() || shouldIgnoreScannerInput(entry.name)) continue
		if (shouldStubFileData(entry.name)) {
			files.push({ fileName: entry.name, data: EMPTY_DATA })
			continue
		}
		const buffer = await readFile(join(folderAbs, entry.name))
		files.push({ fileName: entry.name, data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) })
	}
	return files
}
