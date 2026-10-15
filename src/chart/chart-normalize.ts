import type { Difficulty } from '../types'
import { bomLength, codeUnitBytes, encodeChartText } from './chart-encoding'
import { chartTextRoundTrips, spliceChartText } from './chart-edit'
import {
	ChartFileTokens,
	chartEventSection,
	chartSectionLines,
	chartSectionTrack,
	chartSyncTempo,
	chartSyncTS,
	defaultChartResolution,
	tokenizeChartFile,
} from './chart-file-parser'
import { ChartLineSpelling, chartSectionSpellings, chartSongSpellings } from './chart-line-spelling'
import { chartModifiersWithoutNotes } from './chart-modifiers'
import { chartSectionNoflips, drumMixText } from './disco-flip'

/**
 * A kind of nonstandard `.chart` spelling. The standard is what the `.chart` encoder writes and nearly every library
 * file already uses: CRLF line endings, two-space indentation, no blank lines in a section, lines in tick order, no
 * repeated lines or sections, one tempo marker and one time signature at a tick, bare text events in instrument
 * sections, every line in its standard spelling, and `[Song]` and `[SyncTrack]` as the first two sections, with a
 * `Resolution`. An instrument section also has no modifier without a note (`modifiersWithoutNotes`), and a drums
 * section turns a disco flip off before a `dnoflip` mix event (`noflipDuringFlip`).
 */
export type ChartNormalizationKind =
	| 'lineEndings'
	| 'lineSpelling'
	| 'unreadableLines'
	| 'spacing'
	| 'order'
	| 'duplicateLines'
	| 'repeatedMarkers'
	| 'quotedTrackEvents'
	| 'modifiersWithoutNotes'
	| 'noflipDuringFlip'
	| 'repeatedSections'
	| 'sectionOrder'

/** One normalization: a nonstandard spelling in one place, rewritten into the standard one. */
export interface ChartNormalization {
	readonly kind: ChartNormalizationKind
	/** The section it rewrites, the first of that name (the one a reader uses), or `null` for the whole file. */
	readonly section: string | null
	/** Rewrites the file as it is now. Returns `tokens` unchanged when there's nothing left to rewrite. */
	readonly apply: (tokens: ChartFileTokens) => ChartFileTokens
}

type Splice = { start: number; end: number; text: string }

/**
 * Every normalization a `.chart` file needs. A normalization keeps the meaning, but some change what an older reader
 * saw, and so a hash: saving decides where each applies (E7). Content is otherwise never normalized: values, redundant
 * markers and unrecognized lines stay as written, and the byte-order mark and encoding are kept. The exceptions are a
 * second tempo marker or time signature at a tick, which readers use instead of the first, so the first is removed; a
 * modifier with no note to apply to, which readers ignore, so it's removed; and a `dnoflip` mix event while a `d` flip
 * is on, which Clone Hero 1.1 reads as the flip staying on, so the flip is turned off first. A malformed file gets none.
 *
 * A line in a nonstandard spelling is written the way scan-chart reads it (chart-line-spelling.ts): `lineSpelling`
 * writes the standard spelling, and `unreadableLines` removes a line scan-chart can't read. They come first, so the
 * others see standard lines.
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
		const spellingsOf = sectionSpellings(name)
		if (spellingsOf !== null) {
			add('lineSpelling', name, current => spelledLineSplices(current, name, spellingsOf, respelled))
			add('unreadableLines', name, current => spelledLineSplices(current, name, spellingsOf, readable))
		}
		add('spacing', name, current => sectionSplices(current, name, spacing))
		add('order', name, current => sectionSplices(current, name, lines => order(lines, name)))
		add('duplicateLines', name, current => sectionSplices(current, name, withoutDuplicates))
		if (name === 'SyncTrack') add('repeatedMarkers', name, current => sectionSplices(current, name, withoutEarlierMarkers))
		const track = chartSectionTrack(name)
		if (track !== null) {
			add('quotedTrackEvents', name, current => sectionSplices(current, name, unquoted))
			add('modifiersWithoutNotes', name, current => (chartModifiersWithoutNotes(current).get(name) ?? []).map(({ start, end }) => ({ start, end, text: '' })))
		}
		if (track?.instrument === 'drums') {
			add('noflipDuringFlip', name, current => flipOffSplices(current, name, track.difficulty))
		}
	}
	// Last, because removing and moving sections moves the others.
	for (const [name, copies] of copiesOfName) {
		if (copies > 1) add('repeatedSections', name, current => repeatedSectionSplices(current, name))
	}
	add('sectionOrder', null, sectionOrderSplices)
	return normalizations
}

/** How scan-chart reads each line of the sections named `name`, or `null` for a section readers ignore. */
function sectionSpellings(name: string): ((texts: readonly string[]) => (ChartLineSpelling | null)[]) | null {
	if (name === 'Song') return chartSongSpellings
	const section = chartEventSection(name)
	return section === null ? null : texts => chartSectionSpellings(texts, section)
}

/** A rewrite of lines by their spellings: the spellings it acts on, and each line rewritten, or `null` to remove it. */
interface SpellingRewrite {
	readonly acts: (spelling: ChartLineSpelling) => boolean
	readonly rewrite: (line: string, spelling: ChartLineSpelling | null) => string | null
}

/** Each respelled line in its standard spelling, and each continued line, whose text the line before now holds, removed. */
const respelled: SpellingRewrite = {
	acts: spelling => spelling.kind === 'respelled' || spelling.kind === 'continued',
	rewrite: (line, spelling) => spelling?.kind === 'continued' ? null
		: spelling?.kind === 'respelled' ? `  ${spelling.line}${lineEnding(line)}`
		: line,
}

/** Each line scan-chart can't read removed. */
const readable: SpellingRewrite = {
	acts: spelling => spelling.kind === 'unreadable',
	rewrite: (line, spelling) => spelling?.kind === 'unreadable' ? null : line,
}

/**
 * The splice that rewrites the lines of the first section named `name` by their spellings, or none when `rewrite` keeps
 * them. Text before the section's `}` on its line, such as what's left of a cut-off note line, counts as a line: once
 * rewritten it gets a line of its own, and the `}` stays alone on its line.
 */
function spelledLineSplices(
	tokens: ChartFileTokens,
	name: string,
	spellingsOf: (texts: readonly string[]) => (ChartLineSpelling | null)[],
	{ acts, rewrite }: SpellingRewrite,
): Splice[] {
	const section = tokens.sections[tokens.sections.findIndex(candidate => candidate.name === name)]
	const lines = chartSectionLines(tokens, section)
	if (lines.length < 2) return []
	const last = lines[lines.length - 1]
	const withBraceText = last.text !== ''
	const contentLines = withBraceText ? lines.slice(1) : lines.slice(1, -1)
	if (contentLines.length === 0) return []
	const start = contentLines[0].start
	const end = withBraceText ? section.bodyEnd : last.start
	if (!chartTextRoundTrips(tokens, start, end)) return []
	const spellings = spellingsOf(contentLines.map(line => line.text))
	if (!spellings.some(spelling => spelling !== null && acts(spelling))) return []
	const content = contentLines.map(line => tokens.text.slice(line.start, line.end))
	// The text before the `}` gets the line ending the section's other lines have.
	if (withBraceText && content.slice(0, -1).some(line => line.endsWith('\r'))) content[content.length - 1] += '\r'
	const rewritten = content.flatMap((line, index) => rewrite(line, spellings[index]) ?? [])
	return [{ start, end, text: rewritten.map(line => `${line}\n`).join('') }]
}

/**
 * The splices that put `[Song]` first and `[SyncTrack]` second, adding a `[Song]` section, or a `Resolution` in it,
 * with the resolution a reader uses when the file gives none. None when a section to move holds bytes that aren't
 * valid in the file's encoding.
 */
function sectionOrderSplices(tokens: ChartFileTokens): Splice[] {
	const { text, sections } = tokens
	const newLine = text.includes('\r\n') ? '\r\n' : '\n'
	const lineStartAfter = (at: number) => {
		const lineFeed = text.indexOf('\n', at)
		return lineFeed === -1 ? text.length : lineFeed + 1
	}
	const block = (name: string) => {
		const section = sections.find(candidate => candidate.name === name)
		if (section === undefined) return null
		const header = text.lastIndexOf(`[${name}]`, section.bodyStart)
		return { start: text.lastIndexOf('\n', header) + 1, end: lineStartAfter(section.bodyEnd), section }
	}
	const song = block('Song')
	const syncTrack = block('SyncTrack')
	const splices: Splice[] = []

	let songText: string | null = null
	if (song === null) {
		songText = `[Song]${newLine}{${newLine}  Resolution = ${defaultChartResolution}${newLine}}${newLine}`
	} else if (!chartSectionLines(tokens, song.section).some(line => /^Resolution[ \t]*=/.test(line.text))) {
		const firstLine = lineStartAfter(song.section.bodyStart - 1)
		splices.push({ start: firstLine, end: firstLine, text: `  Resolution = ${defaultChartResolution}${newLine}` })
	}
	const songFirst = song !== null && sections[0] === song.section
	const syncTrackSecond = syncTrack !== null && sections[song === null ? 0 : 1] === syncTrack.section
	if (songText === null && songFirst && (syncTrack === null || syncTrackSecond)) return splices

	// Move both sections to the top: each is cut from where it is, and written first, in order.
	const moved = [song, syncTrack].filter(found => found !== null)
	if (moved.some(found => !chartTextRoundTrips(tokens, found.start, found.end))) return []
	const insertion = (songText ?? '') + moved.map(found => {
		const written = text.slice(found.start, found.end)
		const added = splices.find(splice => splice.start >= found.start && splice.start < found.end)
		const withAdded = added ? written.slice(0, added.start - found.start) + added.text + written.slice(added.start - found.start) : written
		return withAdded.endsWith('\n') ? withAdded : withAdded + newLine
	}).join('')
	const cuts = moved.map(found => ({ start: found.start, end: found.end, text: '' })).sort((a, b) => a.start - b.start)
	return [{ start: 0, end: 0, text: insertion }, ...cuts]
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

/**
 * Of the tempo markers at a tick, the last, and of the time signatures, the last: readers use it (the canonical rules'
 * `lastAtEachTick`), so the others have no effect. Only lines a reader reads as markers count.
 */
function withoutEarlierMarkers(lines: string[]): string[] {
	const markerAt = (line: string) => {
		const text = trimmed(line)
		const tick = (chartSyncTempo.exec(text) ?? chartSyncTS.exec(text))?.[1]
		return tick === undefined ? null : `${tick} ${text.includes(' = B ') ? 'B' : 'TS'}`
	}
	const lastIndex = new Map<string, number>()
	lines.forEach((line, index) => {
		const marker = markerAt(line)
		if (marker !== null) lastIndex.set(marker, index)
	})
	return lines.filter((line, index) => {
		const marker = markerAt(line)
		return marker === null || lastIndex.get(marker) === index
	})
}

/**
 * An event turning the flip off before each `dnoflip` mix event that comes while a `d` flip is on, where a tick is free,
 * as the writers write one (`noflipsDuringFlips`): a line before the first line of a later tick, or before the `}`.
 */
function flipOffSplices(tokens: ChartFileTokens, name: string, difficulty: Difficulty): Splice[] {
	const section = tokens.sections.find(candidate => candidate.name === name)!
	const noflip = tokens.text.indexOf('dnoflip', section.bodyStart)
	if (noflip === -1 || noflip >= section.bodyEnd) return []
	const lines = chartSectionLines(tokens, section)
	return chartSectionNoflips(lines.map(line => line.text), difficulty).flatMap(({ offTick, configuration }) => {
		if (offTick === null) return []
		const before = lines.find(line => Number(/^\d+/.exec(line.text)?.[0] ?? -1) > offTick) ?? lines[lines.length - 1]
		const ending = tokens.text.charCodeAt(before.start - 2) === 13 ? '\r\n' : '\n'
		return [{ start: before.start, end: before.start, text: `  ${offTick} = E ${drumMixText(difficulty, { configuration, flag: '' })}${ending}` }]
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
