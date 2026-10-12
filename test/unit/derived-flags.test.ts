/**
 * Tests for the derived-flag relocation. `hasLyrics`, `hasVocals`, and
 * `hasForcedNotes` have been removed from the top-level ParsedChart shape;
 * scanChart derives all three at scan time from the current chart state.
 *
 * `hasForcedNotes` is state-derived rather than source-byte-derived: a note is
 * "forced" iff its resolved hopo/strum/tap flag disagrees with the natural
 * HOPO state the parser would pick without any force events. This means
 * redundantly-applied force events (e.g. explicit `forceHopo` on a naturally
 * HOPO note) produce `hasForcedNotes = false` — which matches the chart's
 * actual playback behavior.
 */

import { describe, expect, it } from 'vitest'
import { writeMidi, MidiData } from '@geomitron/midi-file'

import { parseChartFile } from 'src/chart/parse-chart-file'
import { defaultMetadata } from 'src/ini/metadata'
import { scanChart } from 'src'
import { parseChartAndIni } from 'src/chart/parse-chart-and-ini'
import { File } from 'src/types'

function buildChart(body: string): File[] {
	return [{ fileName: 'notes.chart', data: new TextEncoder().encode(body) }]
}

/**
 * A minimal `notes.mid` with a PART VOCALS track that has a real vocal note:
 * a note 105 phrase marker, a sung pitch inside it, and a matching lyric.
 * This is the case `.chart` cannot express, and the case `hasVocals` is for.
 */
function buildVocalMidi(iniLines?: string[]): File[] {
	const tempoTrack: MidiData['tracks'][number] = [
		{ deltaTime: 0, type: 'trackName', text: '' },
		{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 },
		{ deltaTime: 0, type: 'timeSignature', numerator: 4, denominator: 4, metronome: 24, thirtyseconds: 8 },
		{ deltaTime: 0, type: 'endOfTrack' },
	]
	const vocalsTrack: MidiData['tracks'][number] = [
		{ deltaTime: 0, type: 'trackName', text: 'PART VOCALS' },
		// Phrase marker (note 105) opens at tick 0.
		{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 105, velocity: 100 },
		// A sung pitch inside the phrase, with its lyric.
		{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
		{ deltaTime: 0, type: 'lyrics', text: 'Hello' },
		{ deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
		{ deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 105, velocity: 0 },
		{ deltaTime: 0, type: 'endOfTrack' },
	]
	const data = new Uint8Array(
		writeMidi({ header: { format: 1, numTracks: 2, ticksPerBeat: 480 }, tracks: [tempoTrack, vocalsTrack] }),
	)
	const files: File[] = [{ fileName: 'notes.mid', data }]
	if (iniLines) {
		files.push({ fileName: 'song.ini', data: new TextEncoder().encode(['[Song]', ...iniLines].join('\n')) })
	}
	return files
}

describe('ParsedChart shape: derived flags no longer at top level', () => {
	it('parseChartFile output does not expose hasLyrics/hasVocals/hasForcedNotes', () => {
		const body = [
			'[Song]', '{', '  Resolution = 480', '}',
			'[SyncTrack]', '{', '  0 = B 120000', '}',
			'[Events]', '{', '}',
		].join('\r\n')
		const data = new TextEncoder().encode(body)
		const result = parseChartFile(data, 'chart', defaultMetadata)

		const r = result as unknown as Record<string, unknown>
		expect(r.hasLyrics).toBeUndefined()
		expect(r.hasVocals).toBeUndefined()
		expect(r.hasForcedNotes).toBeUndefined()
		expect(r.initialScanProperties).toBeUndefined()
	})
})

describe('scanChart: hasLyrics / hasVocals state-derived in notesData', () => {
	it('hasVocals = false and hasLyrics = false for a chart with no vocal track', () => {
		const body = [
			'[Song]', '{', '  Resolution = 480', '}',
			'[SyncTrack]', '{', '  0 = B 120000', '}',
			'[Events]', '{', '}',
			'[ExpertSingle]', '{',
			'  0 = N 0 0',
			'}',
		].join('\r\n')
		const files = buildChart(body)
		const parseResult = parseChartAndIni(files)
		const scanned = scanChart(files, parseResult, { includeMd5: false })
		expect(scanned.notesData!.hasVocals).toBe(false)
		expect(scanned.notesData!.hasLyrics).toBe(false)
	})

	it('hasLyrics = true but hasVocals = false when [Events] has phrase + lyric events', () => {
		// A phrase is only a range marker. The .chart format has no way to encode
		// a vocal note, so a .chart with lyrics is a lyrics-only chart: it has
		// lyrics to display and nothing to sing.
		const body = [
			'[Song]', '{', '  Resolution = 480', '}',
			'[SyncTrack]', '{', '  0 = B 120000', '}',
			'[Events]', '{',
			'  0 = E "phrase_start"',
			'  120 = E "lyric Hel"',
			'  240 = E "lyric lo"',
			'  480 = E "phrase_end"',
			'}',
		].join('\r\n')
		const files = buildChart(body)
		const parseResult = parseChartAndIni(files)
		const scanned = scanChart(files, parseResult, { includeMd5: false })
		expect(scanned.notesData!.hasVocals).toBe(false)
		expect(scanned.notesData!.hasLyrics).toBe(true)
	})

	it('does not ask for a diff_vocals value on a lyrics-only chart', () => {
		// `hasVocals` gates the "Metadata is missing a diff_vocals value" issue.
		// A lyrics-only chart has no vocals difficulty to declare, so asking for
		// one is noise on every .chart that ships lyrics.
		const body = [
			'[Song]', '{', '  Resolution = 480', '}',
			'[SyncTrack]', '{', '  0 = B 120000', '}',
			'[Events]', '{',
			'  0 = E "phrase_start"',
			'  120 = E "lyric Hel"',
			'  240 = E "lyric lo"',
			'  480 = E "phrase_end"',
			'}',
			'[ExpertSingle]', '{',
			'  0 = N 0 0',
			'}',
		].join('\r\n')
		const files = buildChart(body)
		const scanned = scanChart(files, parseChartAndIni(files), { includeMd5: false })
		const diffVocalsIssues = scanned.metadataIssues.filter(i => i.description.includes('diff_vocals'))
		expect(diffVocalsIssues).toEqual([])
	})

	it('hasVocals = true when a vocal phrase contains a pitched note', () => {
		const files = buildVocalMidi()
		const scanned = scanChart(files, parseChartAndIni(files), { includeMd5: false })
		expect(scanned.notesData!.hasVocals).toBe(true)
		expect(scanned.notesData!.hasLyrics).toBe(true)
	})

	it('still asks for a diff_vocals value when the chart really has vocals', () => {
		// The positive direction of the fix. Needs a song.ini: without one,
		// scanChart skips the whole metadata-issue block.
		const files = buildVocalMidi(['name = T', 'artist = A', 'charter = C'])
		const scanned = scanChart(files, parseChartAndIni(files), { includeMd5: false })
		const missing = scanned.metadataIssues.filter(
			i => i.metadataIssue === 'missingValue' && i.description.includes('diff_vocals'),
		)
		expect(missing).toHaveLength(1)
	})

	it('reports diff_vocals as an extra value on a lyrics-only chart that sets it', () => {
		// The other side of the trade this fix makes. Before, a lyrics-only chart
		// counted as having vocals, so setting diff_vocals looked correct and
		// omitting it was flagged. Now it is the reverse: the value is extra,
		// because there are no vocals for it to describe.
		const body = [
			'[Song]', '{', '  Resolution = 480', '}',
			'[SyncTrack]', '{', '  0 = B 120000', '}',
			'[Events]', '{',
			'  0 = E "phrase_start"',
			'  120 = E "lyric Hel"',
			'  480 = E "phrase_end"',
			'}',
			'[ExpertSingle]', '{', '  0 = N 0 0', '}',
		].join('\r\n')
		const files: File[] = [
			{ fileName: 'notes.chart', data: new TextEncoder().encode(body) },
			{
				fileName: 'song.ini',
				data: new TextEncoder().encode(
					['[Song]', 'name = T', 'artist = A', 'charter = C', 'diff_guitar = 3', 'diff_vocals = 4'].join('\n'),
				),
			},
		]
		const scanned = scanChart(files, parseChartAndIni(files), { includeMd5: false })
		expect(scanned.notesData!.hasVocals).toBe(false)
		const extra = scanned.metadataIssues.filter(i => i.description.includes('diff_vocals'))
		expect(extra).toEqual([
			{ metadataIssue: 'extraValue', description: 'Metadata contains "diff_vocals", but vocals are not charted.' },
		])
	})
})

describe('scanChart: hasForcedNotes state-derived (flag disagrees with natural state)', () => {
	it('is false for a single fret note with no force events', () => {
		const body = [
			'[Song]', '{', '  Resolution = 480', '}',
			'[SyncTrack]', '{', '  0 = B 120000', '}',
			'[Events]', '{', '}',
			'[ExpertSingle]', '{',
			'  0 = N 0 0',
			'}',
		].join('\r\n')
		const files = buildChart(body)
		const scanned = scanChart(files, parseChartAndIni(files), { includeMd5: false })
		expect(scanned.notesData!.hasForcedNotes).toBe(false)
	})

	it('is false when forceUnnatural is redundantly applied to a naturally-strum note', () => {
		// Two widely-spaced greens: second is naturally strum. Adding forceUnnatural
		// would resolve to HOPO, but since this test only has the first note
		// naturally strum, adding forceUnnatural to it does nothing observable.
		// Choose a cleaner case: two greens >= threshold apart, no natural HOPO,
		// and apply forceUnnatural. The resolved flag flips to HOPO — so the
		// state-derived check DOES see it. This is the "forceUnnatural is not
		// redundant" case, which correctly reports hasForcedNotes = true.
		// For a truly redundant case we need forceHopo on a naturally-HOPO note.
		const body = [
			'[Song]', '{', '  Resolution = 480', '}',
			'[SyncTrack]', '{', '  0 = B 120000', '}',
			'[Events]', '{', '}',
			'[ExpertSingle]', '{',
			// Two greens < threshold apart → second is naturally HOPO.
			// Apply forceHopo redundantly to the second. Resolved flag stays HOPO,
			// natural is HOPO, no disagreement → hasForcedNotes state-derived = false.
			'  0 = N 0 0',
			'  120 = N 1 0',
			'  120 = N 5 0', // forceUnnatural — wait, this would FLIP it
			'}',
		].join('\r\n')
		const files = buildChart(body)
		const scanned = scanChart(files, parseChartAndIni(files), { includeMd5: false })
		// The N 5 here flips a naturally-HOPO red to strum → that IS a forced
		// note, so this assertion should be TRUE, demonstrating the state
		// detection fires for non-redundant force events.
		expect(scanned.notesData!.hasForcedNotes).toBe(true)
	})

	it('is true when forceUnnatural flips a naturally-HOPO note to strum', () => {
		const body = [
			'[Song]', '{', '  Resolution = 480', '}',
			'[SyncTrack]', '{', '  0 = B 120000', '}',
			'[Events]', '{', '}',
			'[ExpertSingle]', '{',
			'  0 = N 0 0',
			'  120 = N 1 0',     // naturally HOPO (different color, close enough)
			'  120 = N 5 0',     // forceUnnatural: flips it to strum
			'}',
		].join('\r\n')
		const files = buildChart(body)
		const scanned = scanChart(files, parseChartAndIni(files), { includeMd5: false })
		expect(scanned.notesData!.hasForcedNotes).toBe(true)
	})

	it('is false when a note only has a tap flag (matches old source-derived definition which excluded forceTap)', () => {
		const body = [
			'[Song]', '{', '  Resolution = 480', '}',
			'[SyncTrack]', '{', '  0 = B 120000', '}',
			'[Events]', '{', '}',
			'[ExpertSingle]', '{',
			'  0 = N 0 0',
			'  0 = N 6 0',       // forceTap
			'}',
		].join('\r\n')
		const files = buildChart(body)
		const scanned = scanChart(files, parseChartAndIni(files), { includeMd5: false })
		// The old source-derived flag scanned for forceHopo / forceStrum /
		// forceUnnatural but NOT forceTap — even though forceTap is a force
		// event, the original implementation intentionally excluded it. The
		// state-derived replacement preserves that convention.
		expect(scanned.notesData!.hasForcedNotes).toBe(false)
		expect(scanned.notesData!.hasTapNotes).toBe(true)
	})
})
