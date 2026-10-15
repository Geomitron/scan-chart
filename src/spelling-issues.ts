import { chartEventSection, ChartFileTokens, chartSectionLines, chartSectionTrack, ChartSectionToken } from './chart/chart-file-parser'
import { ChartEventSection, ChartLineSpelling, chartSectionSpellings, chartSongSpellings } from './chart/chart-line-spelling'
import { midiTrackInstrument, repeatedMidiInstruments } from './chart/midi-file-parser'
import { midiPitchKey } from './chart/midi-note-numbers'
import { midiNormalizations } from './chart/midi-normalize'
import type { MidiTokens } from './chart/midi-tokens'
import type { ChartSource } from './chart/parse-chart-file'
import { iniNormalizations } from './ini/ini-normalize'
import type { IniTokens } from './ini/parse-ini'
import { Issue, issueSeverities } from './issues'

/**
 * Nonstandard spellings of a chart file or song.ini (r4 Q6). Compatibility issues are spellings another program may
 * read differently; style notes are spellings every reader reads alike, reported only when asked for. Saving an edited
 * song rewrites each in the standard spelling where that changes no hash the edits didn't (E7).
 */
export type SpellingIssueType =
	| 'unsortedChartLines'
	| 'quotedChartTrackEvent'
	| 'multipleMidiTrackNames'
	| 'multipleMidiTracks'
	| 'overlappingMidiNotes'
	| 'duplicateIniKey'
	| 'duplicateChartLine'
	| 'nonstandardChartLine'
	| 'unreadableChartLine'
	| 'nonstandardChartSections'

/**
 * Each message says what Clone Hero does (StrikeCore's readers, which HashScanTool shares). The issues about
 * nonstandard lines and sections each get a message naming the line or section; these are their general forms.
 */
export const spellingIssueMessages: { readonly [code in SpellingIssueType]: string } = {
	unsortedChartLines: 'The lines of this section aren\'t in tick order, so Clone Hero can\'t load the chart.',
	quotedChartTrackEvent: 'This section has a track event in quotes, such as E "solo", which Clone Hero doesn\'t recognize.',
	multipleMidiTrackNames: 'This track has more than one name at tick 0. Clone Hero uses the last; other programs may use the first.',
	multipleMidiTracks: 'This chart has more than one track for this instrument. Clone Hero reads only the first; other programs may read another.',
	overlappingMidiNotes: 'A note on this track starts again on its pitch before it ends. Clone Hero ends the latest one first; other programs may end the earliest, so sustains can differ.',
	duplicateIniKey: '"song.ini" sets a key more than once. Clone Hero uses the last value; other programs may use the first.',
	duplicateChartLine: 'This section has the same line more than once. Clone Hero reads it once.',
	nonstandardChartLine: 'A line in this section isn\'t written the standard way. scan-chart reads what it probably means, and saving an edit writes it that way.',
	unreadableChartLine: 'A line in this section can\'t be read, so scan-chart ignores it. Saving an edit removes it.',
	nonstandardChartSections: 'The chart\'s [Song] and [SyncTrack] sections aren\'t written the standard way. Saving an edit fixes them.',
}

/** The nonstandard spellings of a chart file, one issue per section or track; style notes only when `styleNotes`. */
export function chartSpellingIssues(source: ChartSource, styleNotes: boolean): Issue[] {
	const issues: Issue[] = []
	const add = (code: SpellingIssueType, track: { instrument: Issue['instrument']; difficulty: Issue['difficulty'] }, message = spellingIssueMessages[code]) => {
		issues.push({ scope: 'chart', code, severity: issueSeverities[code], instrument: track.instrument, difficulty: track.difficulty, tick: null, msTime: null, file: null, message })
	}
	if (source.format === 'chart') {
		const { tokens } = source
		const unsorted = new Set<string>()
		const respelled: [SpellingIssueType, string, string?][] = []
		// The normalizations read the first section of each name, which a reader uses.
		const firstOfName = new Map<string, (typeof tokens.sections)[number]>()
		for (const section of tokens.sections) if (!firstOfName.has(section.name)) firstOfName.set(section.name, section)
		for (const section of tokens.sections) {
			const track = chartSectionTrack(section.name)
			const eventSection = chartEventSection(section.name)
			// Clone Hero's readers of track sections, [SyncTrack] and [Events] each refuse a tick lower than the line before
			// it (TrackParser, ChartReader.Sync, ChartReader.Events). Lines of one tick may come in any order.
			const ordered = eventSection !== null
			const isRead = firstOfName.get(section.name) === section
			const checkOrder = ordered && !unsorted.has(section.name)
			if (isRead && section.name === 'Song') respelled.push(...lineIssues(tokens, section, chartSongSpellings))
			if (!isRead && !checkOrder) continue
			const scanned = scanSectionLines(tokens.text, section.bodyStart, section.bodyEnd, checkOrder, isRead && track !== null, isRead ? eventSection : null)
			if (scanned.unsorted) unsorted.add(section.name)
			if (scanned.quoted) respelled.push(['quotedChartTrackEvent', section.name])
			if (scanned.nonstandard) respelled.push(...lineIssues(tokens, section, texts => chartSectionSpellings(texts, eventSection!)))
			// Only where a reader reads the lines, so it's true that it reads a repeated one once.
			if (isRead && styleNotes && ordered) {
				const lines = chartSectionLines(tokens, section).map(line => line.text).filter(text => text !== '')
				if (new Set(lines).size !== lines.length) respelled.push(['duplicateChartLine', section.name])
			}
		}
		const trackOf = (name: string) => chartSectionTrack(name) ?? { instrument: null, difficulty: null }
		for (const name of unsorted) add('unsortedChartLines', trackOf(name))
		for (const [code, name, message] of respelled) add(code, trackOf(name), message)
		const sections = sectionsMessage(tokens)
		if (sections !== null) add('nonstandardChartSections', { instrument: null, difficulty: null }, sections)
		return issues
	}
	if (source.tokens === null) return issues
	for (const { kind, section } of midiNormalizations(source.tokens)) {
		if (kind === 'trackNames') add('multipleMidiTrackNames', { instrument: midiTrackInstrument(section), difficulty: null })
	}
	for (const instrument of repeatedMidiInstruments(source.tokens)) add('multipleMidiTracks', { instrument, difficulty: null })
	for (const trackName of tracksWithOverlappingNotes(source.tokens)) {
		add('overlappingMidiNotes', { instrument: midiTrackInstrument(trackName), difficulty: null })
	}
	return issues
}

/**
 * The issues of a section's lines in nonstandard spellings: one for the lines scan-chart respells, one for those it
 * reads as the games do, and one for those it can't read, each naming the first such line.
 */
function lineIssues(
	tokens: ChartFileTokens,
	section: ChartSectionToken,
	spellingsOf: (texts: readonly string[]) => (ChartLineSpelling | null)[],
): [SpellingIssueType, string, string][] {
	const texts = chartSectionLines(tokens, section).map(line => line.text)
	// Text before the section's `}`, on its line, is read as a line too.
	const spellings = spellingsOf(texts.slice(1))
	const found = { respelled: [] as [string, string][], asWritten: [] as string[], unreadable: [] as string[] }
	spellings.forEach((spelling, index) => {
		const written = texts[index + 1]
		if (spelling?.kind === 'respelled') found.respelled.push([written, spelling.line])
		else if (spelling?.kind === 'asWritten') found.asWritten.push(written)
		else if (spelling?.kind === 'unreadable') found.unreadable.push(written)
	})
	const quote = (line: string) => `"${line.length > 80 ? `${line.slice(0, 77)}...` : line}"`
	// The words for one line or several, naming the first.
	const words = (written: readonly string[]) => written.length === 1
		? { lines: `The line ${quote(written[0])}`, isNot: 'isn\'t', it: 'it', its: 'it', means: 'means', that: 'it' }
		: { lines: `${written.length.toLocaleString('en-US')} lines, such as ${quote(written[0])},`, isNot: 'aren\'t', it: 'them', its: 'they', means: 'mean', that: 'that one' }
	const issues: [SpellingIssueType, string, string][] = []
	if (found.respelled.length > 0) {
		const w = words(found.respelled.map(([written]) => written))
		issues.push(['nonstandardChartLine', section.name, `${w.lines} ${w.isNot} written the standard way. scan-chart reads ${w.that} as ${quote(found.respelled[0][1])}, and saving an edit writes ${w.it} that way.`])
	}
	if (found.asWritten.length > 0) {
		const w = words(found.asWritten)
		issues.push(['nonstandardChartLine', section.name, `${w.lines} ${w.isNot} written the standard way, and Clone Hero doesn't read what ${w.its} probably ${w.means}. scan-chart reads ${w.it} as Clone Hero does, and saving leaves ${w.it} as written, to be fixed by hand.`])
	}
	if (found.unreadable.length > 0) {
		const w = words(found.unreadable)
		issues.push(['unreadableChartLine', section.name, `${w.lines} can't be read, so scan-chart ignores ${w.it}. Saving an edit removes ${w.it}: fix ${w.it} first to keep what ${w.its} meant.`])
	}
	return issues
}

/** What's nonstandard about a file's `[Song]` and `[SyncTrack]` sections, or `null` when nothing is. */
function sectionsMessage(tokens: ChartFileTokens): string | null {
	const names = tokens.sections.map(section => section.name)
	const song = tokens.sections.find(section => section.name === 'Song')
	if (song === undefined) {
		return 'The chart has no [Song] section. scan-chart reads its resolution as 192, as Clone Hero does, and saving an edit adds the section.'
	}
	const problems: string[] = []
	if (!chartSectionLines(tokens, song).some(line => /^Resolution[ \t]*=/.test(line.text))) {
		problems.push('The [Song] section has no Resolution. scan-chart reads it as 192, and saving an edit adds it.')
	}
	if (names[0] !== 'Song' || (names.includes('SyncTrack') && names[1] !== 'SyncTrack')) {
		problems.push('[Song] and [SyncTrack] aren\'t the first two sections, which YARG needs. Saving an edit moves them.')
	}
	return problems.length === 0 ? null : problems.join(' ')
}

/**
 * The standard lines of each event section, from the tick on, with the line's end: a line that isn't one is read by
 * its spelling (chart-line-spelling.ts). Matched where a line starts in the file's text, without slicing it.
 */
const standardLineAt: { readonly [section in ChartEventSection]: RegExp } = {
	sync: /\d+ = (?:B \d+|TS \d+(?: \d+)?)[ \t\r]*(?:\n|$)/y,
	events: /\d+ = E "[^\r\n]*"[ \t\r]*(?:\n|$)/y,
	track: /\d+ = (?:[NS] \d+ \d+|E [^ \t\r\n][^\r\n]*?)[ \t\r]*(?:\n|$)/y,
}

/**
 * Whether a section's tick lines go backwards, whether it has a quoted track event (a line that is, trimmed,
 * `<tick> = E "<text>"`), and, given its kind as `spelling`, whether a line may be in a nonstandard spelling, read a
 * character at a time: every line of every chart is scanned on every analysis. A line `standardLineAt` doesn't match
 * may still be standard, such as an anchor in `[SyncTrack]`; `lineIssues` decides.
 */
function scanSectionLines(text: string, start: number, end: number, checkOrder: boolean, checkQuoted: boolean, spelling: ChartEventSection | null) {
	let unsorted = false, quoted = false, nonstandard = false, lastTick = 0
	const standard = spelling === null ? null : standardLineAt[spelling]
	const isBlank = (code: number) => code === 32 || code === 9 || code === 13
	for (let position = start; position < end && ((checkOrder && !unsorted) || (checkQuoted && !quoted) || (standard !== null && !nonstandard));) {
		const lineFeed = text.indexOf('\n', position)
		const lineEnd = lineFeed === -1 || lineFeed > end ? end : lineFeed
		let index = position
		while (index < lineEnd && isBlank(text.charCodeAt(index))) index++
		const digitsStart = index
		let tick = 0
		while (index < lineEnd && text.charCodeAt(index) >= 48 && text.charCodeAt(index) <= 57) tick = tick * 10 + text.charCodeAt(index++) - 48
		// Most lines are notes, checked here a character at a time; any other nonblank line by its pattern.
		if (standard !== null && !nonstandard && digitsStart < lineEnd && !(index > digitsStart && spelling === 'track' && isStandardNoteLine(text, index, lineEnd))) {
			standard.lastIndex = digitsStart
			nonstandard = !standard.test(text)
		}
		if (index > digitsStart) {
			let equals = index
			while (equals < lineEnd && isBlank(text.charCodeAt(equals))) equals++
			if (text.charCodeAt(equals) === 61) {
				if (checkOrder && !unsorted) {
					if (tick < lastTick) unsorted = true
					else lastTick = tick
				}
				if (checkQuoted && !quoted && text.startsWith(' = E "', index)) {
					quoted = /^\d+ = E ".*"$/.test(text.slice(digitsStart, lineEnd).replace(/[ \t\r]+$/, ''))
				}
			}
		}
		position = lineEnd + 1
	}
	return { unsorted, quoted, nonstandard }
}

/**
 * Whether the line from `at`, just after its tick, to `lineEnd` is ` = N <value> <length>` or the same with `S`, with
 * only spaces, tabs and a carriage return after it: `standardLineAt.track`'s note lines, without a pattern match.
 */
function isStandardNoteLine(text: string, at: number, lineEnd: number): boolean {
	if (text.charCodeAt(at) !== 32 || text.charCodeAt(at + 1) !== 61 || text.charCodeAt(at + 2) !== 32) return false
	const type = text.charCodeAt(at + 3)
	if ((type !== 78 && type !== 83) || text.charCodeAt(at + 4) !== 32) return false
	let index = at + 5
	for (let value = 0; value < 2; value++) {
		if (value === 1) {
			if (text.charCodeAt(index) !== 32) return false
			index++
		}
		const digits = index
		while (index < lineEnd && text.charCodeAt(index) >= 48 && text.charCodeAt(index) <= 57) index++
		if (index === digits) return false
	}
	for (; index < lineEnd; index++) {
		const code = text.charCodeAt(index)
		if (code !== 32 && code !== 9 && code !== 13) return false
	}
	return true
}

/** The nonstandard spellings of the song.ini Clone Hero reads; none for another `.ini` file, which it doesn't read. */
export function songIniSpellingIssues(ini: { readonly fileName: string; readonly tokens: IniTokens } | null): Issue[] {
	return ini === null || ini.fileName.toLowerCase() !== 'song.ini' ? [] : iniSpellingIssues(ini.tokens, ini.fileName)
}

function iniSpellingIssues(tokens: IniTokens, file: string): Issue[] {
	if (tokens.text === null) return []
	return iniNormalizations(tokens).flatMap(({ kind }): Issue[] => kind === 'duplicateKeys'
		? [{
			scope: 'metadata', code: 'duplicateIniKey', severity: issueSeverities.duplicateIniKey, instrument: null, difficulty: null, tick: null, msTime: null,
			file, message: spellingIssueMessages.duplicateIniKey,
		}]
		: [])
}

/** The names of the tracks where a note starts again on its pitch and channel before it has ended. */
function tracksWithOverlappingNotes(tokens: MidiTokens): string[] {
	const names: string[] = []
	for (const chunk of tokens.chunks) {
		if (chunk.kind !== 'track') continue
		const sounding = new Map<number, number>()
		let name = ''
		let overlaps = false
		for (const { tick, event } of chunk.events) {
			if (tick === 0 && event.type === 'trackName') name = event.text
			if (event.type !== 'noteOn' && event.type !== 'noteOff') continue
			const key = midiPitchKey(event)
			const count = sounding.get(key) ?? 0
			if (event.type === 'noteOn' && event.velocity > 0) {
				if (count > 0) overlaps = true
				sounding.set(key, count + 1)
			} else if (count > 0) {
				sounding.set(key, count - 1)
			}
		}
		if (overlaps) names.push(name)
	}
	return names
}
