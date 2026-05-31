export type NormalizedJson = null | boolean | number | string | NormalizedJson[] | { [key: string]: NormalizedJson }

/** Normalizes scan-chart output so byte-identical NDJSON means semantic equality. */
export function normalizeSnapshot(scanned: unknown): NormalizedJson {
	return normalizeValue('', scanned)
}

function normalizeValue(keyPath: string, value: unknown): NormalizedJson {
	if (value === null || value === undefined) return null
	if (typeof value === 'boolean' || typeof value === 'number') return value
	if (typeof value === 'string') return isHashPath(keyPath) ? stripBase64Padding(value) : value
	if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
		return `<binary length=${(value as Uint8Array).byteLength}>`
	}
	if (Array.isArray(value)) {
		return normalizeArray(keyPath, value)
	}

	const obj = value as Record<string, unknown>
	if (keyPath === 'albumArt') {
		return obj.md5 == null ? null : sortObjectKeys({ md5: normalizeValue('albumArt.md5', obj.md5) })
	}

	const out: Record<string, NormalizedJson> = {}
	for (const [key, nested] of Object.entries(obj)) {
		if (nested === undefined) continue
		out[key] = normalizeValue(keyPath ? `${keyPath}.${key}` : key, nested)
	}
	return sortObjectKeys(out)
}

function normalizeArray(keyPath: string, values: unknown[]): NormalizedJson[] {
	const normalized = values.map((item, index) => normalizeValue(`${keyPath}[${index}]`, item))

	if (keyPath === 'folderIssues' || keyPath === 'metadataIssues' || keyPath === 'notesData.chartIssues') {
		return [...normalized].sort(stableJsonCompare)
	}

	if (keyPath === 'notesData.trackHashes' || keyPath === 'notesData.noteCounts' || keyPath === 'notesData.maxNps') {
		return [...normalized].sort((a, b) => {
			const aKey = trackArrayKey(a)
			const bKey = trackArrayKey(b)
			return aKey.localeCompare(bKey)
		})
	}

	if (keyPath === 'notesData.instruments') {
		return [...normalized].map(String).sort()
	}

	return normalized
}

function trackArrayKey(value: NormalizedJson): string {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return ''
	const record = value as Record<string, NormalizedJson>
	return `${String(record.instrument ?? '')}/${String(record.difficulty ?? '')}`
}

function sortObjectKeys(obj: Record<string, NormalizedJson>): Record<string, NormalizedJson> {
	const out: Record<string, NormalizedJson> = {}
	for (const key of Object.keys(obj).sort()) {
		out[key] = obj[key]
	}
	return out
}

function stableJsonCompare(a: unknown, b: unknown): number {
	return JSON.stringify(a).localeCompare(JSON.stringify(b))
}

/** Returns true for hash fields whose base64url padding is not semantically meaningful. */
export function isHashPath(keyPath: string): boolean {
	return keyPath === 'chartHash' || /^notesData\.trackHashes\[\d+\]\.hash$/.test(keyPath) || /^notesData\.trackHashes\[[^\]]+\]\.hash$/.test(keyPath)
}

/** Canonicalizes base64url hash strings emitted with or without trailing padding. */
export function stripBase64Padding(value: string): string {
	return value.replace(/=+$/g, '')
}
