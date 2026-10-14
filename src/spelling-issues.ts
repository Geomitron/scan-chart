import { chartSectionLines, chartSectionTrack } from './chart/chart-file-parser'
import { midiTrackInstrument } from './chart/midi-file-parser'
import { midiNormalizations } from './chart/midi-normalize'
import type { MidiTokens } from './chart/midi-tokens'
import type { ChartSource } from './chart/parse-chart-file'
import { iniNormalizations } from './ini/ini-normalize'
import type { IniTokens } from './ini/parse-ini'
import type { Issue } from './issues'

/**
 * Nonstandard spellings of a chart file or song.ini (r4 Q6). Compatibility issues are spellings another program may
 * read differently; style notes are spellings every reader reads alike, reported only when asked for. Saving an edited
 * song rewrites each in the standard spelling where that changes no hash the edits didn't (E7).
 */
export type SpellingIssueType =
	| 'unsortedChartLines'
	| 'quotedChartTrackEvent'
	| 'multipleMidiTrackNames'
	| 'overlappingMidiNotes'
	| 'duplicateIniKey'
	| 'duplicateChartLine'

/** Each message says what Clone Hero does (StrikeCore's readers, which HashScanTool shares). */
export const spellingIssueMessages: { readonly [code in SpellingIssueType]: string } = {
	unsortedChartLines: 'The lines of this section aren\'t in tick order, so Clone Hero can\'t load the chart.',
	quotedChartTrackEvent: 'This section has a track event in quotes, such as E "solo", which Clone Hero doesn\'t recognize.',
	multipleMidiTrackNames: 'This track has more than one name at tick 0. Clone Hero uses the last; other programs may use the first.',
	overlappingMidiNotes: 'A note on this track starts again on its pitch before it ends. Clone Hero ends the latest one first; other programs may end the earliest, so sustains can differ.',
	duplicateIniKey: '"song.ini" sets a key more than once. Clone Hero uses the last value; other programs may use the first.',
	duplicateChartLine: 'This section has the same line more than once. Clone Hero reads it once.',
}

/** The nonstandard spellings of a chart file, one issue per section or track; style notes only when `styleNotes`. */
export function chartSpellingIssues(source: ChartSource, styleNotes: boolean): Issue[] {
	const issues: Issue[] = []
	const add = (code: SpellingIssueType, track: { instrument: Issue['instrument']; difficulty: Issue['difficulty'] }) => {
		issues.push({ scope: 'chart', code, instrument: track.instrument, difficulty: track.difficulty, tick: null, msTime: null, message: spellingIssueMessages[code] })
	}
	if (source.format === 'chart') {
		const { tokens } = source
		const unsorted = new Set<string>()
		const respelled: [SpellingIssueType, string][] = []
		// The normalizations read the first section of each name, which a reader uses.
		const firstOfName = new Map<string, (typeof tokens.sections)[number]>()
		for (const section of tokens.sections) if (!firstOfName.has(section.name)) firstOfName.set(section.name, section)
		for (const section of tokens.sections) {
			const track = chartSectionTrack(section.name)
			// Clone Hero's readers of track sections, [SyncTrack] and [Events] each refuse a tick lower than the line before
			// it (TrackParser, ChartReader.Sync, ChartReader.Events). Lines of one tick may come in any order.
			const ordered = track !== null || section.name === 'SyncTrack' || section.name === 'Events'
			const isRead = firstOfName.get(section.name) === section
			const checkOrder = ordered && !unsorted.has(section.name)
			if (!isRead && !checkOrder) continue
			const scanned = scanSectionLines(tokens.text, section.bodyStart, section.bodyEnd, checkOrder, isRead && track !== null)
			if (scanned.unsorted) unsorted.add(section.name)
			if (scanned.quoted) respelled.push(['quotedChartTrackEvent', section.name])
			// Only where a reader reads the lines, so it's true that it reads a repeated one once.
			if (isRead && styleNotes && ordered) {
				const lines = chartSectionLines(tokens, section).map(line => line.text).filter(text => text !== '')
				if (new Set(lines).size !== lines.length) respelled.push(['duplicateChartLine', section.name])
			}
		}
		const trackOf = (name: string) => chartSectionTrack(name) ?? { instrument: null, difficulty: null }
		for (const name of unsorted) add('unsortedChartLines', trackOf(name))
		for (const [code, name] of respelled) add(code, trackOf(name))
		return issues
	}
	if (source.tokens === null) return issues
	for (const { kind, section } of midiNormalizations(source.tokens)) {
		if (kind === 'trackNames') add('multipleMidiTrackNames', { instrument: midiTrackInstrument(section), difficulty: null })
	}
	for (const trackName of tracksWithOverlappingNotes(source.tokens)) {
		add('overlappingMidiNotes', { instrument: midiTrackInstrument(trackName), difficulty: null })
	}
	return issues
}

/**
 * Whether a section's tick lines go backwards, and whether it has a quoted track event (a line that is, trimmed,
 * `<tick> = E "<text>"`), read a character at a time: every line of every chart is scanned on every analysis.
 */
function scanSectionLines(text: string, start: number, end: number, checkOrder: boolean, checkQuoted: boolean) {
	let unsorted = false, quoted = false, lastTick = 0
	const isBlank = (code: number) => code === 32 || code === 9 || code === 13
	for (let position = start; position < end && ((checkOrder && !unsorted) || (checkQuoted && !quoted));) {
		const lineFeed = text.indexOf('\n', position)
		const lineEnd = lineFeed === -1 || lineFeed > end ? end : lineFeed
		let index = position
		while (index < lineEnd && isBlank(text.charCodeAt(index))) index++
		const digitsStart = index
		let tick = 0
		while (index < lineEnd && text.charCodeAt(index) >= 48 && text.charCodeAt(index) <= 57) tick = tick * 10 + text.charCodeAt(index++) - 48
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
	return { unsorted, quoted }
}

/** The nonstandard spellings of the song.ini Clone Hero reads; none for another `.ini` file, which it doesn't read. */
export function songIniSpellingIssues(ini: { readonly fileName: string; readonly tokens: IniTokens } | null): Issue[] {
	return ini === null || ini.fileName.toLowerCase() !== 'song.ini' ? [] : iniSpellingIssues(ini.tokens)
}

function iniSpellingIssues(tokens: IniTokens): Issue[] {
	if (tokens.text === null) return []
	return iniNormalizations(tokens).flatMap(({ kind }) => kind === 'duplicateKeys'
		? [{ scope: 'metadata' as const, code: 'duplicateIniKey' as const, instrument: null, difficulty: null, tick: null, msTime: null, message: spellingIssueMessages.duplicateIniKey }]
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
			const key = event.channel * 128 + event.noteNumber
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
