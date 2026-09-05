import { describe, expect, expectTypeOf, it } from 'vitest'

import {
	calculateCanonicalChartDuration,
	calculateCanonicalTrackDuration,
	calculateParsedTrackDuration,
} from 'src/chart/chart-duration'
import type { CanonicalTrackSemantics } from 'src/chart/identity/btrack-20260801'
import { parseChartFile } from 'src/chart/parse-chart-file'
import { noteTypes } from 'src/chart/types'
import { parseHistoricalDuration } from '../../tools/ch-identity/duration'

function chart(
	sections: readonly string[],
	tempos: readonly string[] = ['0 = B 120000'],
	resolution = 192,
) {
	return parseChartFile(new TextEncoder().encode([
		'[Song]', '{', `  Resolution = ${resolution}`, '}',
		'[SyncTrack]', '{', ...tempos.map(tempo => `  ${tempo}`), '}',
		'[Events]', '{', '}',
		...sections,
	].join('\r\n')), 'chart')
}

describe('canonical chart duration', () => {
	it('uses the latest regular-note end across every instrument and difficulty', () => {
		const parsed = chart([
			'[ExpertSingle]', '{', '  0 = N 0 192', '}',
			'[EasyDoubleBass]', '{', '  384 = N 0 192', '}',
		])
		expect(calculateCanonicalChartDuration(parsed)).toEqual({
			definition: 'strikecore-all-track-last-note-plus-one-beat-v1',
			durationMs: 2000n,
			contentLastTick: 576n,
			endTick: 768n,
			resolution: 192n,
			songSpeed: 1,
		})
	})

	it('uses tempo changes that occur during the added final beat', () => {
		const parsed = chart(
			['[ExpertSingle]', '{', '  0 = N 0 192', '}'],
			['0 = B 120000', '288 = B 60000'],
		)
		expect(calculateCanonicalChartDuration(parsed).durationMs).toBe(1250n)
	})

	it('matches the StrikeCore bit-increment boundary before the final ceiling', () => {
		const parsed = chart([], ['0 = B 25000'], 3)
		expect(calculateCanonicalChartDuration(parsed).durationMs).toBe(2401n)
	})

	it('returns one beat for an empty chart and remains fixed at song speed 1', () => {
		const empty = chart([])
		const fractional = chart([], ['0 = B 123000'])
		const higherResolution = chart([], ['0 = B 120000'], 480)
		expect(calculateCanonicalChartDuration(empty).durationMs).toBe(500n)
		expect(calculateCanonicalChartDuration(fractional).durationMs).toBe(488n)
		expect(calculateCanonicalChartDuration(higherResolution)).toMatchObject({
			durationMs: 500n,
			endTick: 480n,
			resolution: 480n,
			songSpeed: 1,
		})
	})

	it('does not use vocal collections or chart events', () => {
		const parsed = chart([])
		parsed.endEvents.push({ tick: 9999, msTime: 0, msLength: 0 })
		parsed.vocalTracks.parts.test = {
			notePhrases: [{
				tick: 10_000,
				msTime: 0,
				length: 192,
				msLength: 0,
				isPercussion: false,
				notes: [],
				lyrics: [],
			}],
			staticLyricPhrases: [],
			starPowerSections: [],
			rangeShifts: [],
			lyricShifts: [],
			textEvents: [],
		}
		expect(calculateCanonicalChartDuration(parsed).durationMs).toBe(500n)
	})
})

describe('track duration', () => {
	it('uses only the selected Track while retaining the complete tempo map', () => {
		const parsed = chart(
			[
				'[ExpertSingle]', '{', '  0 = N 0 192', '}',
				'[EasyDoubleBass]', '{', '  768 = N 0 192', '}',
			],
			['0 = B 120000', '96 = B 60000'],
		)
		expect(calculateParsedTrackDuration(parsed, 'guitar', 'expert')).toEqual({
			definition: 'strikecore-selected-track-last-note-v1',
			durationMs: 750n,
			lastNoteEndTick: 192n,
			resolution: 192n,
			songSpeed: 1,
			minimumDurationMs: 1,
		})
		expect(calculateCanonicalChartDuration(parsed).durationMs).toBe(5750n)
	})

	it('does not add the Song duration final beat', () => {
		const parsed = chart(['[ExpertSingle]', '{', '  0 = N 0 192', '}'])
		expect(calculateParsedTrackDuration(parsed, 'guitar', 'expert').durationMs).toBe(500n)
		expect(calculateCanonicalChartDuration(parsed).durationMs).toBe(1000n)
	})

	it('fixes stored reference durations at normal speed instead of accepting gameplay speed', () => {
		expectTypeOf(calculateCanonicalChartDuration).parameters.toEqualTypeOf<[
			ReturnType<typeof chart>,
		]>()
		expectTypeOf(calculateCanonicalTrackDuration).parameters.toEqualTypeOf<[
			CanonicalTrackSemantics,
		]>()
		const parsed = chart(['[ExpertSingle]', '{', '  0 = N 0 192', '}'])
		expect(calculateCanonicalChartDuration(parsed).songSpeed).toBe(1)
		expect(calculateParsedTrackDuration(parsed, 'guitar', 'expert').songSpeed).toBe(1)
	})

	it('uses a one-millisecond minimum for an empty selected Track', () => {
		const parsed = chart(['[ExpertSingle]', '{', '  0 = S 2 192', '}'])
		expect(calculateParsedTrackDuration(parsed, 'guitar', 'expert')).toMatchObject({
			durationMs: 1n,
			lastNoteEndTick: 0n,
			minimumDurationMs: 1,
		})
	})

	it('derives the same evidence directly from canonical BTrack semantics', () => {
		const semantics: CanonicalTrackSemantics = {
			resolution: 192,
			tempos: [
				{ tick: 0n, beatsPerMinute: 120 },
				{ tick: 96n, beatsPerMinute: 60 },
			],
			timeSignatures: [],
			starPower: [],
			solos: [],
			flexLanes: [],
			drumFreestyle: [],
			rangeShifts: [],
			notes: [{ tick: 0n, length: 192n, type: noteTypes.green, flags: 0 }],
		}
		expect(calculateCanonicalTrackDuration(semantics)).toEqual({
			definition: 'strikecore-selected-track-last-note-v1',
			durationMs: 750n,
			lastNoteEndTick: 192n,
			resolution: 192n,
			songSpeed: 1,
			minimumDurationMs: 1,
		})
	})
})

describe('historical duration', () => {
	it('accepts only a nonzero signed-int32 song_length', () => {
		expect(parseHistoricalDuration('[Song]\nsong_length = 1234')).toEqual({
			kind: 'available',
			source: 'song.ini:song_length',
			durationMs: 1234n,
		})
		expect(parseHistoricalDuration('[song]\nsong_length = -2')).toMatchObject({ kind: 'available', durationMs: -2n })
		expect(parseHistoricalDuration('[Song]\nsong_length = 0')).toEqual({
			kind: 'unavailable',
			reason: 'zeroSongLength',
		})
		expect(parseHistoricalDuration('[Song]\nsong_length = 12.5')).toEqual({
			kind: 'unavailable',
			reason: 'invalidSongLength',
		})
		expect(parseHistoricalDuration('[Song]\nsong_length = 2147483648')).toEqual({
			kind: 'unavailable',
			reason: 'invalidSongLength',
		})
		expect(parseHistoricalDuration(null)).toEqual({
			kind: 'unavailable',
			reason: 'missingSongLength',
		})
	})
})
