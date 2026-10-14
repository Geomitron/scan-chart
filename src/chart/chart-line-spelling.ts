/**
 * The sections whose lines are events, read a line at a time: `[SyncTrack]`, `[Events]` and the instrument sections.
 * `[Song]`, whose lines are named entries, has its own reading (`chartSongLineSpelling`).
 */
export type ChartEventSection = 'sync' | 'events' | 'track'

/**
 * How scan-chart reads a line that isn't in the standard spelling (`docs/chart/syntax.mdx`). The standard stays strict
 * and the games don't need to read more; scan-chart reads what such a line probably means and saves it the standard way
 * (`scan-chart-nonstandard-reading.docx`, agreed 14 October 2026).
 *
 * - `respelled`: what the line probably means, in the standard spelling. scan-chart reads it as that line, and saving
 *   an edited song writes that line. Every form respelled is one Clone Hero refuses, or reads the same way.
 * - `continued`: the rest of a text that runs on from the line before, which `respelled` already holds. Saving removes it.
 * - `asWritten`: a line the games load but don't read as it probably means. scan-chart reads it as they do, and saving
 *   leaves it, for the charter to fix (Q2).
 * - `unreadable`: a line with no probable meaning. scan-chart ignores it, and saving an edited song removes it (Q3).
 */
export type ChartLineSpelling =
	| { readonly kind: 'respelled'; readonly line: string }
	| { readonly kind: 'continued' }
	| { readonly kind: 'asWritten' }
	| { readonly kind: 'unreadable' }

const unreadable: ChartLineSpelling = { kind: 'unreadable' }
const asWritten: ChartLineSpelling = { kind: 'asWritten' }
const continued: ChartLineSpelling = { kind: 'continued' }

/** The number of values each known type takes, by section. An `N` or `S` without its length is read with length 0. */
const valueCounts: { readonly [section in ChartEventSection]: { readonly [type: string]: readonly number[] } } = {
	sync: { B: [1], TS: [1, 2], A: [1] },
	events: {},
	track: { N: [1, 2], S: [1, 2] },
}

/**
 * The common standard lines, by section, which need no spelling: anything else goes through `spellLine`. Classification
 * matches an instrument section's lines with its own patterns instead (`parseTrackLine`), which fall back to it.
 */
const standardLines: { readonly [section in ChartEventSection]: RegExp } = {
	sync: /^\d+ = (?:B \d+|TS \d+(?: \d+)?)$/,
	events: /^\d+ = E "[^\r\n]*"$/,
	track: /^\d+ = (?:[NS] \d+ \d+|E [^ \t\r\n][^\r\n]*)$/,
}

/**
 * A tick, a type, and the rest: an `=` with any spaces or tabs around it, or only a space or tab where it's missing.
 * Spaces and tabs may also separate the type from the rest.
 */
const looseLine = /^([0-9.]+)[ \t]*(?:=[ \t]*|[ \t])([A-Z]{1,2})(?:[ \t]+([^\n]*))?$/

/**
 * How scan-chart reads `text`, one trimmed line of an event section, or `null` when it's already standard. A text that
 * runs onto the next line is respelled by `chartSectionSpellings`, which sees both lines.
 */
export function chartLineSpelling(text: string, section: ChartEventSection): ChartLineSpelling | null {
	return spellLine(text, section).spelling
}

/**
 * How scan-chart reads each line of a section, in order: `null` for a standard or blank line. `texts` are the section's
 * trimmed lines, blank ones as `''`. In `[Events]`, a text that runs onto the next line is respelled whole on its first
 * line, and the next nonblank line, which holds the rest, is `continued`.
 */
export function chartSectionSpellings(texts: readonly string[], section: ChartEventSection): (ChartLineSpelling | null)[] {
	const spellings: (ChartLineSpelling | null)[] = new Array(texts.length).fill(null)
	for (let index = 0; index < texts.length; index++) {
		const text = texts[index]
		if (text === '' || spellings[index] !== null || standardLines[section].test(text)) continue
		const { spelling, openText } = spellLine(text, section)
		spellings[index] = spelling
		if (openText === undefined) continue
		let next = index + 1
		while (next < texts.length && texts[next] === '') next++
		const rest = texts[next]
		if (rest === undefined || !rest.endsWith('"') || looseLine.test(rest) || /^[0-9.]+[ \t]*=/.test(rest)) continue
		const joined = withoutEndReturns(openText + rest.slice(0, -1))
		if (/[\r"]/.test(joined) || joined === '') continue
		spellings[index] = { kind: 'respelled', line: `${tickOf(text)} = E "${joined}"` }
		spellings[next] = continued
	}
	return spellings
}

/**
 * `lines` as classification reads them, by section: each respelled line replaced, and each continued line left out.
 * Gives back `lines` itself when they're all standard, which is nearly always.
 */
export function readableChartLines(lines: string[], section: 'sync' | 'events' | 'song'): string[] {
	if (section !== 'song' && lines.every(line => standardLines[section].test(line))) return lines
	const spellings = section === 'song' ? chartSongSpellings(lines) : chartSectionSpellings(lines, section)
	if (spellings.every(spelling => spelling === null)) return lines
	const out: string[] = []
	lines.forEach((line, index) => {
		const spelling = spellings[index]
		if (spelling?.kind === 'respelled') out.push(spelling.line)
		else if (spelling?.kind !== 'continued') out.push(line)
	})
	return out
}

/** The tick a respelled line keeps: its digits as written, or a decimal rounded to the nearest whole number. */
function readNumber(text: string): string | null {
	if (/^\d+$/.test(text)) return text
	if (!/^(?:\d+\.\d*|\.\d+)$/.test(text)) return null
	const rounded = Math.round(Number(text))
	return Number.isSafeInteger(rounded) ? String(rounded) : null
}

function tickOf(text: string): string {
	return readNumber(/^[0-9.]+/.exec(text)![0])!
}

const withoutEndReturns = (text: string) => text.replace(/^\r+|\r+$/g, '')

/**
 * The spelling of one line, and, for an `[Events]` text whose opening quote has no closing one, the text after the
 * quote, so `chartSectionSpellings` can look for the rest on the next line.
 */
function spellLine(text: string, section: ChartEventSection): { spelling: ChartLineSpelling | null; openText?: string } {
	const match = looseLine.exec(text)
	if (match === null) return { spelling: unreadable }
	const tick = readNumber(match[1])
	if (tick === null) return { spelling: unreadable }
	const type = match[2]
	const rest = match[3] ?? ''
	let value: string
	if (type === 'E' && section === 'events') {
		if (rest === '') return { spelling: unreadable }
		if (!rest.startsWith('"')) {
			// Unquoted, which Clone Hero refuses: it looks for an opening quote. YARG reads the text.
			const unquoted = rest.endsWith('"') ? rest.slice(0, -1) : rest
			if (unquoted === '' || /[\r"]/.test(unquoted)) return { spelling: unreadable }
			value = `E "${unquoted}"`
		} else if (rest.length >= 2 && rest.endsWith('"')) {
			// A carriage return before the closing quote, which Clone Hero trims away (it trims the text).
			const inner = withoutEndReturns(rest.slice(1, -1))
			if (inner.includes('\r')) return { spelling: asWritten }
			value = `E "${inner}"`
		} else {
			// No closing quote. Clone Hero reads an empty event: its search for the closing quote gives 0 when there's
			// none (ChartReader.Events.cs:93). Unless the text runs onto the next line, it's read as Clone Hero reads it.
			return { spelling: asWritten, openText: rest.slice(1) }
		}
	} else if (type === 'E' && section === 'track') {
		// The text as written, quotes and all: the quotedTrackEvents normalization removes quotes.
		if (rest === '') return { spelling: unreadable }
		if (rest.includes('\r')) return { spelling: asWritten }
		value = `E ${rest}`
	} else {
		const values = rest === '' ? [] : rest.split(/[ \t]+/)
		const counts = valueCounts[section][type]
		if (counts === undefined) {
			// A type the section doesn't know: only its spacing is respelled. Readers ignore it in an instrument section.
			value = [type, ...values].join(' ')
		} else {
			const numbers = values.map(readNumber)
			if (numbers.some(number => number === null) || !counts.includes(numbers.length)) return { spelling: unreadable }
			if ((type === 'N' || type === 'S') && numbers.length === 1) numbers.push('0')
			value = [type, ...numbers].join(' ')
		}
	}
	const line = `${tick} = ${value}`
	return { spelling: line === text ? null : { kind: 'respelled', line } }
}

/** The `[Song]` keys whose values are numbers. */
const songNumberKeys = new Set(['Resolution', 'Offset', 'Difficulty', 'PreviewStart', 'PreviewEnd'])

/**
 * How scan-chart reads `text`, one trimmed line of `[Song]`, or `null` when it reads it as written. Only number keys
 * and lines a reader can't use are classified:
 * - a number key with other spacing, such as `Resolution=480`: `respelled` as `Resolution = 480`;
 * - a number key whose value isn't a number: `asWritten` for a decimal comma, such as `Offset = 0,1`, which Clone Hero
 *   reads as no value (`float.TryParse` with the invariant culture, SongEntry.cs:696), and `unreadable` otherwise;
 * - a line that isn't `key = value`, which every reader skips: `unreadable`.
 */
export function chartSongLineSpelling(text: string): ChartLineSpelling | null {
	const separator = text.indexOf('=')
	if (separator === -1) return unreadable
	const key = text.slice(0, separator).replace(/[ \t]+$/, '')
	if (!songNumberKeys.has(key)) return null
	const written = text.slice(separator + 1).replace(/^[ \t]+/, '')
	const value = written.replace(/^"(.*)"$/, '$1')
	if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
		const line = `${key} = ${written}`
		return line === text ? null : { kind: 'respelled', line }
	}
	return /^[+-]?\d+,\d+$/.test(value) ? asWritten : unreadable
}

/**
 * How scan-chart reads each line of `[Song]`, in order: `null` for a line read as written. A quoted text that runs onto
 * the next line, such as `Genre = "Rock` followed by a line holding only `"`, is respelled on one line, and the next
 * line is `continued`. Every reader already reads the value without the line break.
 */
export function chartSongSpellings(texts: readonly string[]): (ChartLineSpelling | null)[] {
	const spellings: (ChartLineSpelling | null)[] = new Array(texts.length).fill(null)
	for (let index = 0; index < texts.length; index++) {
		const text = texts[index]
		if (text === '' || spellings[index] !== null) continue
		const open = /^([^=]+?) = "([^"]*)$/.exec(text)
		if (open !== null) {
			let next = index + 1
			while (next < texts.length && texts[next] === '') next++
			const rest = texts[next]
			if (rest !== undefined && rest.endsWith('"') && !rest.includes('=') && !rest.slice(0, -1).includes('"')) {
				spellings[index] = { kind: 'respelled', line: `${open[1]} = "${open[2]}${rest.slice(0, -1)}"` }
				spellings[next] = continued
				continue
			}
		}
		spellings[index] = chartSongLineSpelling(text)
	}
	return spellings
}
