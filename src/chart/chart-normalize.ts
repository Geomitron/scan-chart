import { bomLength, codeUnitBytes, encodeChartText } from './chart-encoding'
import { chartTextRoundTrips, spliceChartText } from './chart-edit'
import { ChartFileTokens, chartSectionLines, chartSectionTrack, tokenizeChartFile } from './chart-file-parser'

/**
 * A kind of nonstandard `.chart` spelling. The standard is what the `.chart` encoder writes and nearly every library
 * file already uses: CRLF line endings, two-space indentation, no blank lines in a section, lines in tick order, no
 * repeated lines or sections, and bare text events in instrument sections.
 */
export type ChartNormalizationKind = 'lineEndings' | 'spacing' | 'order' | 'duplicateLines' | 'quotedTrackEvents' | 'repeatedSections'

/** One normalization: a nonstandard spelling in one place, rewritten into the standard one. */
export interface ChartNormalization {
	readonly kind: ChartNormalizationKind
	/** The section it rewrites, the last of that name (the one Clone Hero reads), or `null` for the whole file. */
	readonly section: string | null
	/** Rewrites the file as it is now. Returns `tokens` unchanged when there's nothing left to rewrite. */
	readonly apply: (tokens: ChartFileTokens) => ChartFileTokens
}

type Splice = { start: number; end: number; text: string }

/**
 * Every normalization a `.chart` file needs. A normalization keeps the meaning, but some change what an older reader
 * saw, and so a hash: saving decides where each applies (E7). Content is never normalized: values, redundant markers
 * and unrecognized lines stay as written, and the byte-order mark and encoding are kept. A malformed file gets none.
 */
export function chartNormalizations(tokens: ChartFileTokens): ChartNormalization[] {
	if (tokens.structureError !== null) return []
	const normalizations: ChartNormalization[] = []
	const add = (kind: ChartNormalizationKind, section: string | null, splices: (tokens: ChartFileTokens) => Splice[]) => {
		if (splices(tokens).length === 0) return
		normalizations.push({
			kind,
			section,
			apply: current => {
				const found = splices(current)
				return found.length === 0 ? current : spliceChartText(current, found)
			},
		})
	}

	if (lineFeedsWithoutReturn(tokens).length > 0) {
		normalizations.push({ kind: 'lineEndings', section: null, apply: withCarriageReturns })
	}
	const copiesOfName = new Map<string, number>()
	for (const section of tokens.sections) copiesOfName.set(section.name, (copiesOfName.get(section.name) ?? 0) + 1)
	for (const name of copiesOfName.keys()) {
		add('spacing', name, current => sectionSplices(current, name, spacing))
		add('order', name, current => sectionSplices(current, name, lines => order(lines, name)))
		add('duplicateLines', name, current => sectionSplices(current, name, withoutDuplicates))
		if (chartSectionTrack(name) !== null) add('quotedTrackEvents', name, current => sectionSplices(current, name, unquoted))
	}
	// Last, because removing sections moves the others.
	for (const [name, copies] of copiesOfName) {
		if (copies > 1) add('repeatedSections', name, current => repeatedSectionSplices(current, name))
	}
	return normalizations
}

/**
 * The byte offsets of the line feeds with no carriage return before them. A line feed is never part of a multi-byte
 * UTF-8 character, and in UTF-16 it is its own code unit, so the bytes can be read directly, valid or not.
 */
function lineFeedsWithoutReturn(tokens: ChartFileTokens): number[] {
	const { bytes, encoding } = tokens
	const offsets: number[] = []
	const unit = codeUnitBytes(encoding)
	const [lineFeed, carriageReturn] = [encodeChartText('\n', encoding), encodeChartText('\r', encoding)]
	const isAt = (at: number, code: Uint8Array) => code.every((byte, k) => bytes[at + k] === byte)
	// Code units start after the byte order mark, so a line feed's bytes can't be mistaken for part of another unit.
	for (let i = bomLength(bytes, encoding); i + unit <= bytes.length; i += unit) {
		if (isAt(i, lineFeed) && !(i - unit >= 0 && isAt(i - unit, carriageReturn))) offsets.push(i)
	}
	return offsets
}

/** A carriage return before each bare line feed, inserted into the bytes. */
function withCarriageReturns(tokens: ChartFileTokens): ChartFileTokens {
	const offsets = lineFeedsWithoutReturn(tokens)
	if (offsets.length === 0) return tokens
	const carriageReturn = encodeChartText('\r', tokens.encoding)
	const bytes = new Uint8Array(tokens.bytes.length + offsets.length * carriageReturn.length)
	let from = 0, to = 0
	for (const offset of offsets) {
		bytes.set(tokens.bytes.subarray(from, offset), to)
		to += offset - from
		bytes.set(carriageReturn, to)
		to += carriageReturn.length
		from = offset
	}
	bytes.set(tokens.bytes.subarray(from), to)
	return tokenizeChartFile(bytes)
}

/**
 * The splice that rewrites the content lines of the first section named `name`, or none when `rewrite` keeps them.
 * Each line is given as written, without its line feed; a carriage return stays at its end.
 */
function sectionSplices(tokens: ChartFileTokens, name: string, rewrite: (lines: string[]) => string[]): Splice[] {
	const index = tokens.sections.findIndex(section => section.name === name)
	const lines = chartSectionLines(tokens, tokens.sections[index])
	if (lines.length < 3) return [] // No content lines between the brace lines
	// A section with bytes that aren't valid in the file's encoding is left as written: its decoded text can't be
	// written back without changing them.
	if (!chartTextRoundTrips(tokens, lines[1].start, lines[lines.length - 1].start)) return []
	const content = lines.slice(1, -1).map(line => tokens.text.slice(line.start, line.end))
	const rewritten = rewrite(content)
	if (rewritten.length === content.length && rewritten.every((line, i) => line === content[i])) return []
	return [{ start: lines[1].start, end: lines[lines.length - 1].start, text: rewritten.map(line => `${line}\n`).join('') }]
}

const trimmed = (line: string) => line.replace(/^[ \t\r]+|[ \t\r]+$/g, '')
const lineEnding = (line: string) => line.endsWith('\r') ? '\r' : ''

/** Two-space indentation, no trailing spaces, and no blank lines. */
function spacing(lines: string[]): string[] {
	return lines.filter(line => trimmed(line) !== '').map(line => `  ${trimmed(line)}${lineEnding(line)}`)
}

/**
 * Lines in tick order. At one tick, an instrument section has notes, then phrases, then text events, and
 * `[SyncTrack]` has time signatures, then tempos, as the encoder writes them; otherwise lines keep their order. A
 * section with a line that has no tick is left as it is. Blank lines keep their places.
 */
function order(lines: string[], name: string): string[] {
	const isTrack = chartSectionTrack(name) !== null
	const rank = (kind: string) => isTrack ? ({ N: 0, S: 1, E: 2 } as Record<string, number>)[kind] ?? 3
		: name === 'SyncTrack' ? ({ TS: 0, B: 1 } as Record<string, number>)[kind] ?? 2
		: 0
	const keyed: { line: string; tick: number; rank: number; index: number }[] = []
	const slots: number[] = []
	for (const [index, line] of lines.entries()) {
		if (trimmed(line) === '') continue
		const match = /^(\d+) = (\S+)/.exec(trimmed(line))
		if (match === null) return lines
		keyed.push({ line, tick: Number(match[1]), rank: rank(match[2]), index })
		slots.push(index)
	}
	keyed.sort((a, b) => a.tick - b.tick || a.rank - b.rank || a.index - b.index)
	const ordered = [...lines]
	slots.forEach((slot, i) => { ordered[slot] = keyed[i].line })
	return ordered
}

/** The first of identical lines. */
function withoutDuplicates(lines: string[]): string[] {
	const seen = new Set<string>()
	return lines.filter(line => {
		const text = trimmed(line)
		if (text === '') return true
		if (seen.has(text)) return false
		seen.add(text)
		return true
	})
}

/** A text event in an instrument section written bare, `E solo`, rather than quoted, `E "solo"`. */
function unquoted(lines: string[]): string[] {
	return lines.map(line => {
		const match = /^(\s*\d+ = E )"(.*)"([ \t\r]*)$/.exec(line)
		return match ? `${match[1]}${match[2]}${match[3]}` : line
	})
}

/**
 * Removes every section named `name` but the first, which is the one a reader uses. A body written without a header of
 * its own takes the name of the section before it, so a copy is removed from its header or, without one, from the line
 * after the section before it.
 */
function repeatedSectionSplices(tokens: ChartFileTokens, name: string): Splice[] {
	const lineStartAfter = (at: number) => {
		const lineFeed = tokens.text.indexOf('\n', at)
		return lineFeed === -1 ? tokens.text.length : lineFeed + 1
	}
	const indices = tokens.sections.flatMap((section, index) => section.name === name ? [index] : [])
	return indices.slice(1).map(index => {
		const section = tokens.sections[index]
		const header = tokens.text.lastIndexOf(`[${name}]`, section.bodyStart)
		const start = Math.max(tokens.text.lastIndexOf('\n', header) + 1, lineStartAfter(tokens.sections[index - 1].bodyEnd))
		return { start, end: lineStartAfter(section.bodyEnd), text: '' }
	})
}
