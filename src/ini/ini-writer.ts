import { defaultMetadata } from './metadata'

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
 *   - Fields whose value is `undefined` or `null` are skipped.
 *   - Fields whose value equals the documented default are skipped — the
 *     re-parser fills them back in from `defaultMetadata`, so the
 *     round-trip is lossless and we don't bloat charts with ~20 lines of
 *     "diff_keys = -1" / "modchart = False" defaults that the source
 *     never had.
 *   - Booleans format as `True`/`False` (matching Clone Hero convention), and
 *     `preview` as `<start> <end>`.
 *   - `extraIniFields` are appended after the known fields, in insertion
 *     order.
 */
export function writeIniFile(metadata: IniMetadata): string {
	const lines: string[] = ['[song]']

	const keys = Object.keys(defaultMetadata) as (keyof typeof defaultMetadata)[]
	for (const key of keys) {
		const value = metadata[key]
		if (value === undefined || value === null) continue
		if (value === defaultMetadata[key]) continue
		lines.push(`${key} = ${formatIniValue(value)}`)
	}

	if (metadata.extraIniFields) {
		for (const [key, value] of Object.entries(metadata.extraIniFields)) {
			lines.push(`${key} = ${value}`)
		}
	}

	return lines.join('\r\n') + '\r\n'
}

/** A metadata value as song.ini writes it: a boolean as `True` or `False`, `preview` as `<start> <end>`, and the rest as text. */
export function formatIniValue(value: string | number | boolean | { readonly start: number; readonly end: number }): string {
	if (typeof value === 'boolean') return value ? 'True' : 'False'
	if (typeof value === 'object') return `${value.start} ${value.end}`
	return String(value)
}
