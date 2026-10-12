import { describe, expect, it } from 'vitest'

import { authoredSongEvents, chartAuthoredTracks } from 'src/chart/authored-view'
import { tokenizeChartFile } from 'src/chart/chart-file-parser'
import { parseChartTokens } from 'src/chart/chart-reparse'
import { parseChartSource } from 'src/chart/parse-chart-file'
import { parseRules } from 'src/chart/parse-rules'
import { eventTypes } from 'src/chart/raw-types'
import { editSong, parseSong, SongDocument } from 'src/song-document'
import { drumTypes } from 'src/types'

const rules = parseRules.canonical20260801
const chartText = (sections: Record<string, readonly string[]>) => {
	const lines = ['[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = TS 4', '  0 = B 120000', '}', '[Events]', '{', '}']
	for (const [name, body] of Object.entries(sections)) lines.push(`[${name}]`, '{', ...body.map(line => `  ${line}`), '}')
	return lines.join('\r\n') + '\r\n'
}
const tokensOf = (song: SongDocument) => song.chart?.format === 'chart' ? song.chart.tokens : null!
const parse = (song: SongDocument) => parseChartTokens(tokensOf(song), {}, rules)
const fullParse = (song: SongDocument) => parseChartSource({ format: 'chart', tokens: tokensOf(song) }, {}, rules)
const trackOf = (parsed: ReturnType<typeof parse>, instrument: string, difficulty: string) =>
	parsed.trackData.find(track => track.instrument === instrument && track.difficulty === difficulty)

/** Lengthens the first event of the named section. */
function lengthenFirst(song: SongDocument, sectionName: string) {
	const track = chartAuthoredTracks(tokensOf(song)).find(candidate => candidate.sectionName === sectionName)!
	return editSong(song, batch => batch.setLength(track.events[0], track.events[0].length + 96))
}

describe('reparsing an edited .chart', () => {
	const song = parseSong([{ fileName: 'notes.chart', data: new TextEncoder().encode(chartText({
		ExpertSingle: ['0 = N 0 0', '192 = N 1 0', '384 = N 2 0'],
		HardSingle: ['0 = N 0 0', '192 = N 1 0'],
		ExpertDrums: ['0 = N 0 0', '0 = N 2 0', '192 = N 3 0'],
		HardDrums: ['0 = N 2 0', '192 = N 3 0'],
	})) }])

	it('reuses the tracks of every section the edit didn\'t change, and equals a full parse', () => {
		const before = parse(song)
		const edited = lengthenFirst(song, 'ExpertSingle')
		const after = parse(edited)
		expect(after).toEqual(fullParse(edited))
		expect(trackOf(after, 'guitar', 'hard')).toBe(trackOf(before, 'guitar', 'hard'))
		expect(trackOf(after, 'drums', 'expert')).toBe(trackOf(before, 'drums', 'expert'))
		expect(trackOf(after, 'guitar', 'expert')).not.toBe(trackOf(before, 'guitar', 'expert'))
		expect(trackOf(after, 'guitar', 'expert')!.noteEventGroups[0][0].length).toBe(96)
	})

	it('resolves every track again after a tempo edit', () => {
		const before = parse(song)
		const tempo = authoredSongEvents(song.chart as { format: 'chart'; tokens: ReturnType<typeof tokensOf> }).tempos[0]
		const edited = editSong(song, batch => batch.setTempo(tempo, 150))
		const after = parse(edited)
		expect(after).toEqual(fullParse(edited))
		for (const track of after.trackData) expect(track).not.toBe(trackOf(before, track.instrument, track.difficulty))
	})

	it('resolves the other drum tracks again when an edit changes the drum type', () => {
		const before = parse(song)
		expect(before.drumType).toBe(drumTypes.fourLane) // no cymbal markers yet
		const expertDrums = tokensOf(song).sections.findIndex(section => section.name === 'ExpertDrums')
		const edited = editSong(song, batch => batch.addToChartSection(expertDrums, 0, eventTypes.yellowCymbalMarker, 0))
		const after = parse(edited)
		expect(after).toEqual(fullParse(edited))
		expect(after.drumType).not.toBe(before.drumType)
		expect(trackOf(after, 'drums', 'hard')).not.toBe(trackOf(before, 'drums', 'hard'))
		expect(trackOf(after, 'guitar', 'hard')).toBe(trackOf(before, 'guitar', 'hard'))
	})

	it('reuses the authored tracks of unchanged sections, equal to reading the edited file afresh', () => {
		const before = chartAuthoredTracks(tokensOf(song))
		const edited = lengthenFirst(song, 'ExpertSingle')
		const after = chartAuthoredTracks(tokensOf(edited))
		expect(after).toEqual(chartAuthoredTracks(tokenizeChartFile(tokensOf(edited).bytes)))
		const named = (tracks: typeof before, name: string) => tracks.find(track => track.sectionName === name)
		expect(named(after, 'HardSingle')).toBe(named(before, 'HardSingle'))
		expect(named(after, 'ExpertSingle')).not.toBe(named(before, 'ExpertSingle'))
	})

	it('gives back the same result for the same tokens, and parses again with other settings', () => {
		expect(parse(song)).toBe(parse(song))
		const withThreshold = parseChartTokens(tokensOf(song), { sustain_cutoff_threshold: 50 }, rules)
		expect(withThreshold).toEqual(parseChartSource({ format: 'chart', tokens: tokensOf(song) }, { sustain_cutoff_threshold: 50 }, rules))
		expect(withThreshold).not.toBe(parse(song))
	})
})
