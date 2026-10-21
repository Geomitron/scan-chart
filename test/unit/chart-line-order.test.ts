import { describe, expect, it } from 'vitest'

import { parseChartFile, parseChartFileCanonicalIdentity, parseChartFileFrozenLegacyIdentity } from 'src/chart/parse-chart-file'

/** A `.chart` file with `events` in [Events], `sync` in [SyncTrack], and drum fills at ticks 100 and 600. */
const chart = (events: readonly string[], sync: readonly string[] = ['0 = TS 4', '0 = B 120000']) => new TextEncoder().encode([
	'[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', ...sync.map(line => `  ${line}`), '}',
	'[Events]', '{', ...events.map(line => `  ${line}`), '}',
	'[ExpertDrums]', '{', '  0 = N 0 0', '  100 = S 64 50', '  100 = N 1 0', '  600 = S 64 50', '  600 = N 1 0', '  1000 = N 1 0', '}',
].join('\r\n') + '\r\n')

describe('.chart lines written out of tick order', () => {
	it('are read in tick order, keeping the file\'s order at one tick, except in the frozen legacy profile', () => {
		const data = chart([
			'500 = E "coda"', '100 = E "coda"', '900 = E "end"', '800 = E "end"',
			'400 = E "section B"', '200 = E "section A"', '200 = E "section A2"',
			'700 = E "phrase_start"', '300 = E "phrase_start"', '300 = E "lyric Hel-"', '700 = E "lyric lo"', '750 = E "phrase_end"', '350 = E "phrase_end"',
		], ['0 = TS 4', '0 = B 120000', '768 = B 180000', '384 = B 60000'])
		for (const parse of [parseChartFile, parseChartFileCanonicalIdentity]) {
			const parsed = parse(data, 'chart')
			expect(parsed.trackData[0].drumFreestyleSections.map(fill => [fill.tick, fill.isCoda])).toEqual([[100, true], [600, true]])
			expect(parsed.endEvents.map(end => end.tick)).toEqual([800, 900])
			// A tick holds one section, so the later of the two at tick 200 in the file stays.
			expect(parsed.sections.map(section => [section.tick, section.name])).toEqual([[200, 'A2'], [400, 'B']])
			expect(parsed.tempos.map(tempo => [tempo.tick, tempo.beatsPerMinute])).toEqual([[0, 120], [384, 60], [768, 180]])
			expect(parsed.vocalTracks.parts.vocals!.notePhrases.map(phrase => [phrase.tick, phrase.lyrics.map(lyric => lyric.text)])).toEqual([[300, ['Hel-']], [700, ['lo']]])
		}
		const legacy = parseChartFileFrozenLegacyIdentity(data, 'chart')
		expect(legacy.trackData[0].drumFreestyleSections.map(fill => [fill.tick, fill.isCoda])).toEqual([[100, false], [600, true]])
		expect(legacy.tempos.map(tempo => tempo.tick)).toEqual([0, 768, 384])
	})
})
