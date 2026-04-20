import { defaultMetadata } from './ini-scanner'

/**
 * Metadata input shape accepted by `writeIniFile`. Matches the shape
 * `parseChartAndIni` produces on `parsedChart.metadata`: any subset of the
 * known ini fields, plus optional `extraIniFields` for unknown keys preserved
 * for round-trip.
 */
export type IniMetadata = Partial<typeof defaultMetadata> & {
	extraIniFields?: { [key: string]: string }
}

/**
 * Serialize metadata to a `song.ini` string with CRLF line endings.
 *
 * Emission rules:
 *   - Starts with a `[song]` header.
 *   - Known fields emit in the order defined by `defaultMetadata`.
 *   - Fields whose value is `undefined` are skipped.
 *   - Booleans format as `True`/`False` (matching Clone Hero convention).
 *   - `extraIniFields` are appended after the known fields, in insertion
 *     order.
 */
export function writeIniFile(metadata: IniMetadata): string {
	const lines: string[] = ['[song]']

	const keys = Object.keys(defaultMetadata) as (keyof typeof defaultMetadata)[]
	for (const key of keys) {
		const value = metadata[key]
		if (value === undefined) continue
		lines.push(`${key} = ${formatValue(value)}`)
	}

	if (metadata.extraIniFields) {
		for (const [key, value] of Object.entries(metadata.extraIniFields)) {
			lines.push(`${key} = ${value}`)
		}
	}

	return lines.join('\r\n') + '\r\n'
}

function formatValue(value: string | number | boolean): string {
	if (typeof value === 'boolean') return value ? 'True' : 'False'
	return String(value)
}
