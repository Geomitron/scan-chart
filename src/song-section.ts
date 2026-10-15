import { ChartLineEdit, chartTextRoundTrips, editChartLines } from './chart/chart-edit'
import { ChartFileTokens, chartSectionLines, ChartLineToken, isChartSongReaderStop, readChartSongLine } from './chart/chart-file-parser'
import { secondsToMs } from './ini/chart-song-entries'
import { setSongIniValue } from './ini/ini-edit'
import { tagRank } from './ini/metadata'
import { IniTokens, parseIniTokens } from './ini/parse-ini'
import type { SongDocument } from './song-document'

type Unit = 'text' | 'year' | 'number' | 'seconds'

/**
 * The `.chart` `[Song]` keys with a song.ini counterpart (GuitarGame_ChartFormats: the `.chart` Format Overview and
 * song.ini's Standard Tags). `unset` holds the numbers that mean "not set" to games; a song.ini `delay` of 0 or
 * `preview_start_time` of -1 makes them read `[Song]`'s Offset or PreviewStart instead.
 */
const pairs: readonly { readonly chartKey: string; readonly iniKey: string; readonly unit: Unit; readonly unset?: readonly number[] }[] = [
	{ chartKey: 'Name', iniKey: 'name', unit: 'text' },
	{ chartKey: 'Artist', iniKey: 'artist', unit: 'text' },
	{ chartKey: 'Album', iniKey: 'album', unit: 'text' },
	{ chartKey: 'Genre', iniKey: 'genre', unit: 'text' },
	{ chartKey: 'Year', iniKey: 'year', unit: 'year' },
	{ chartKey: 'Charter', iniKey: 'charter', unit: 'text' },
	{ chartKey: 'Difficulty', iniKey: 'diff_band', unit: 'number', unset: [-1] },
	{ chartKey: 'Length', iniKey: 'song_length', unit: 'seconds', unset: [0] },
	{ chartKey: 'Offset', iniKey: 'delay', unit: 'seconds', unset: [0] },
	{ chartKey: 'PreviewStart', iniKey: 'preview_start_time', unit: 'seconds', unset: [-1] },
	// Moonscraper writes PreviewEnd = 0 when there's no preview end (see previewEndMs).
	{ chartKey: 'PreviewEnd', iniKey: 'preview_end_time', unit: 'seconds', unset: [-1, 0] },
]

/** `[Song]` keys games read when song.ini doesn't set their counterpart, so they're copied rather than removed. */
const fallbackKeys = new Set(['Offset', 'PreviewStart', 'PreviewEnd'])

/**
 * Makes a `.chart` `[Song]` section agree with the song.ini Clone Hero reads (Geo, 2026-10-12). `[Song]` is legacy,
 * so for each key of `pairs`:
 *
 * 1. a value both set differently: `[Song]` takes song.ini's;
 * 2. a key only song.ini sets: added to `[Song]`;
 * 3. a key only `[Song]` sets: Offset, PreviewStart and PreviewEnd are copied into song.ini, because games read them
 *    when song.ini doesn't set `delay`, `preview_start_time` or `preview_end_time`; the rest are removed from `[Song]`,
 *    which games ignore when there's a song.ini.
 *
 * Values agree when Clone Hero reads them the same: a time compares as the milliseconds it rounds to, and a Year
 * without its leading `, `. An edited line keeps its quoting and its Year style, and each key is left on one line.
 * Returns `null` when nothing disagrees, or the song has no song.ini or no `.chart` `[Song]` section to compare.
 */
export function songSectionAgreement(song: SongDocument): SongDocument | null {
	const { chart, ini } = song
	if (chart?.format !== 'chart' || ini === null || ini.fileName.toLowerCase() !== 'song.ini' || ini.tokens.text === null) return null
	const iniSong = parseIniTokens(ini.tokens).iniObject.song
	const tokens = chart.tokens
	const section = tokens.sections[0]
	// Clone Hero reads the file's first block as [Song], and only text that's written back exactly can be edited.
	if (iniSong === undefined || section?.name !== 'Song' || tokens.text.indexOf('{') + 1 !== section.bodyStart) return null
	if (!roundTrips(tokens, section.bodyStart, lineStartAfter(tokens.text, section.bodyEnd))) return null
	const lines = chartSectionLines(tokens, section)
	const entries = lines.map(line => readChartSongLine(line.text))
	if (entries.some(entry => entry !== null && isChartSongReaderStop(entry))) return null

	const edits: ChartLineEdit[] = []
	let iniTokens: IniTokens | null = ini.tokens
	for (const pair of pairs) {
		const keyLines = lines.flatMap((line, index) => entries[index]?.key === pair.chartKey ? [index] : [])
		// Clone Hero reads the first nonblank value.
		const readLine = keyLines.find(index => entries[index]!.value !== '')
		const chartValue = readLine === undefined ? null : entries[readLine]!.value
		const chartSet = chartValue !== null && isSet(pair, chartValue, 'chart')
		const iniValue = iniSong[pair.iniKey] ?? ''
		const iniSet = iniValue !== '' && isSet(pair, iniValue, 'ini')

		if (iniSet && !(chartSet && agree(pair, chartValue!, iniValue))) {
			// Rules 1 and 2: [Song] takes song.ini's value, on the line Clone Hero reads, or the key's first line.
			const target = readLine ?? keyLines[0]
			const text = target === undefined ? newLineText(pair, iniValue) : editedLineText(pair, lines[target], iniValue)
			if (text === null) continue
			edits.push(target === undefined
				? { kind: 'insert', section: 0, beforeLine: lines.length - 1, text }
				: { kind: 'replace', section: 0, line: target, text })
			for (const index of keyLines) if (index !== target) edits.push({ kind: 'delete', section: 0, line: index })
		} else if (!iniSet && chartSet) {
			// Rule 3.
			if (fallbackKeys.has(pair.chartKey)) {
				const copied: IniTokens | null = iniTokens === null ? null : copyIntoIni(iniTokens, pair.iniKey, String(secondsToMs(chartValue!)))
				if (copied !== null) iniTokens = copied
			} else {
				for (const index of keyLines) edits.push({ kind: 'delete', section: 0, line: index })
			}
		}
	}
	if (edits.length === 0 && iniTokens === ini.tokens) return null
	return {
		...song,
		chart: edits.length === 0 ? chart : { ...chart, tokens: editChartLines(tokens, edits) },
		ini: iniTokens === ini.tokens ? ini : { ...ini, tokens: iniTokens! },
	}
}

function isSet(pair: (typeof pairs)[number], value: string, side: 'chart' | 'ini'): boolean {
	if (pair.unit === 'text' || pair.unit === 'year') return value !== ''
	const number = side === 'chart' && pair.unit === 'seconds' ? secondsToMs(value) : parseFloat(value)
	return number !== null && Number.isFinite(number) && !(pair.unset ?? []).includes(number)
}

function agree(pair: (typeof pairs)[number], chartValue: string, iniValue: string): boolean {
	switch (pair.unit) {
		case 'text': return chartValue === iniValue
		case 'year': return withoutYearSeparator(chartValue) === iniValue
		case 'number': return parseFloat(chartValue) === parseFloat(iniValue)
		case 'seconds': return secondsToMs(chartValue) === parseFloat(iniValue)
	}
}

/** The line, keeping its key and spacing, with song.ini's value written in its style; `null` if it can't be read back. */
function editedLineText(pair: (typeof pairs)[number], line: ChartLineToken, iniValue: string): string | null {
	const separator = line.text.indexOf('=')
	const after = line.text.slice(separator + 1)
	const spacing = /^[ \t]*/.exec(after)![0]
	const written = after.slice(spacing.length)
	const hasSeparator = pair.unit === 'year' && withoutQuotes(written).startsWith(', ')
	return readableLine(pair, `${line.text.slice(0, separator + 1)}${spacing}`, iniValue, written.startsWith('"'), hasSeparator)
}

/** A new line for the key, written as scan-chart's writer writes `[Song]`: text quoted, and Year with its `, `. */
function newLineText(pair: (typeof pairs)[number], iniValue: string): string | null {
	const textual = pair.unit === 'text' || pair.unit === 'year'
	return readableLine(pair, `${pair.chartKey} = `, iniValue, textual, pair.unit === 'year')
}

/**
 * `prefix` and the value, written quoted or not as preferred, and otherwise the other way, whichever Clone Hero reads
 * back as song.ini's value; `null` if neither is.
 */
function readableLine(pair: (typeof pairs)[number], prefix: string, iniValue: string, quoted: boolean, yearSeparator: boolean): string | null {
	for (const value of chartValues(pair, iniValue, yearSeparator)) {
		for (const quote of quoted ? ['"', ''] : ['', '"']) {
			const text = `${prefix}${quote}${value}${quote}`
			const entry = readChartSongLine(text)
			if (entry !== null && entry.value !== '' && agree(pair, entry.value, iniValue)) return text
		}
	}
	return null
}

/**
 * The ways to write song.ini's value in `[Song]`, preferred first. Clone Hero reads a time as `ceil(seconds * 1000)`
 * in single precision, where -4.095 seconds reads as -4094 ms, so a time also has a value half a millisecond earlier.
 */
function chartValues(pair: (typeof pairs)[number], iniValue: string, yearSeparator: boolean): string[] {
	switch (pair.unit) {
		case 'text': return [iniValue]
		case 'year': return [yearSeparator ? `, ${iniValue}` : iniValue]
		case 'number': return [iniValue]
		case 'seconds': {
			const ms = parseFloat(iniValue)
			return [String(ms / 1000), String((ms - 0.5) / 1000)]
		}
	}
}

/** song.ini with the key set, in its place in the standard order, or `null` if it can't be edited (it isn't UTF-8). */
function copyIntoIni(tokens: IniTokens, key: string, value: string): IniTokens | null {
	try {
		return setSongIniValue(tokens, key, value, other => tagRank(other) > tagRank(key))
	} catch (error) {
		if (error instanceof RangeError) return null
		throw error
	}
}

function withoutYearSeparator(value: string) {
	return value.startsWith(', ') ? value.slice(2) : value
}

function withoutQuotes(value: string) {
	return value.startsWith('"') ? value.slice(1) : value
}

/** Whether the text from `start` to `end` is written back exactly; text decoded from invalid bytes isn't. */
function roundTrips(tokens: ChartFileTokens, start: number, end: number) {
	try {
		return chartTextRoundTrips(tokens, start, end)
	} catch (error) {
		if (error instanceof RangeError) return false
		throw error
	}
}

/** The offset of the start of the line after `offset`'s, or the text's end. */
function lineStartAfter(text: string, offset: number) {
	const lineEnd = text.indexOf('\n', offset)
	return lineEnd === -1 ? text.length : lineEnd + 1
}
