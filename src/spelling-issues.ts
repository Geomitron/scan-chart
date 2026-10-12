import { chartNormalizations } from './chart/chart-normalize'
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
		const reported = new Set<string>()
		for (const section of tokens.sections) {
			// Clone Hero's readers of track sections, [SyncTrack] and [Events] each refuse a tick lower than the line before
			// it (TrackParser, ChartReader.Sync, ChartReader.Events). Lines of one tick may come in any order.
			const track = chartSectionTrack(section.name)
			if (reported.has(section.name) || (track === null && section.name !== 'SyncTrack' && section.name !== 'Events')) continue
			let lastTick = 0
			for (const line of chartSectionLines(tokens, section)) {
				const tick = /^(\d+)\s*=/.exec(line.text)
				if (tick === null) continue
				if (Number(tick[1]) < lastTick) {
					add('unsortedChartLines', track ?? { instrument: null, difficulty: null })
					reported.add(section.name)
					break
				}
				lastTick = Number(tick[1])
			}
		}
		for (const { kind, section } of chartNormalizations(tokens)) {
			const track = (section === null ? null : chartSectionTrack(section)) ?? { instrument: null, difficulty: null }
			if (kind === 'quotedTrackEvents') add('quotedChartTrackEvent', track)
			else if (kind === 'duplicateLines' && styleNotes) add('duplicateChartLine', track)
		}
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
