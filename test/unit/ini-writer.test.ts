/**
 * Round-trip tests for writeIniFile.
 *
 * Exercise writeIniFile through parseChartAndIni: build an ini metadata
 * object, write it, pair with a minimal notes.chart, re-parse, and assert
 * parsedChart.metadata matches what we wrote. No assertions about the
 * serialized ini text itself — the parser is the source of truth for
 * observable behavior.
 */

import { describe, expect, it } from 'vitest'

import { parseChartAndIni } from 'src/chart/parse-chart-and-ini'
import { defaultMetadata } from 'src/ini/metadata'
import { writeIniFile } from 'src/ini/ini-writer'

/** Minimal valid notes.chart bytes — enough to parse, empty of content. */
const EMPTY_CHART = new TextEncoder().encode(
	[
		'[Song]',
		'{',
		'  Resolution = 480',
		'}',
		'[SyncTrack]',
		'{',
		'  0 = TS 4',
		'  0 = B 120000',
		'}',
		'[Events]',
		'{',
		'}',
	].join('\r\n'),
)

type IniInput = Parameters<typeof writeIniFile>[0]

function roundTrip(metadata: IniInput) {
	const iniText = writeIniFile(metadata)
	const result = parseChartAndIni([
		{ fileName: 'notes.chart', data: EMPTY_CHART },
		{ fileName: 'song.ini', data: new TextEncoder().encode(iniText) },
	])
	if (!result.parsedChart) throw new Error('round-trip produced no parsedChart')
	return result.parsedChart.metadata
}

describe('writeIniFile round-trip', () => {
	it('empty metadata survives a round trip', () => {
		const out = roundTrip({})
		expect(out.extraIniFields).toBeUndefined()
	})

	it('preserves string fields', () => {
		const input = {
			name: 'Round Trip',
			artist: 'Tester',
			album: 'Test Album',
			genre: 'Rock',
			year: '2023',
			charter: 'Me',
		}
		const out = roundTrip(input)
		for (const key of Object.keys(input) as (keyof typeof input)[]) {
			expect(out[key]).toBe(input[key])
		}
	})

	it('preserves boolean fields with correct type', () => {
		const input = { pro_drums: true, five_lane_drums: false, modchart: false, end_events: true }
		const out = roundTrip(input)
		expect(out.pro_drums).toBe(true)
		expect(out.five_lane_drums).toBe(false)
		expect(out.modchart).toBe(false)
		expect(out.end_events).toBe(true)
	})

	it('preserves numeric fields', () => {
		const input = { diff_drums: 5, diff_guitar: 3, delay: -250, song_length: 180000, hopo_frequency: 170 }
		const out = roundTrip(input)
		expect(out.diff_drums).toBe(5)
		expect(out.diff_guitar).toBe(3)
		expect(out.delay).toBe(-250)
		expect(out.song_length).toBe(180000)
		expect(out.hopo_frequency).toBe(170)
	})

	it('undefined fields are filled in from defaultMetadata on re-parse', () => {
		// writeIniFile skips undefined fields; the re-parser then fills them in
		// from defaultMetadata. Verify set fields survive and unset fields land
		// on their documented defaults.
		const out = roundTrip({ name: 'Song', artist: undefined, album: 'Album' })
		expect(out.name).toBe('Song')
		expect(out.album).toBe('Album')
		expect(out.artist).toBe(defaultMetadata.artist)
	})

	it('preserves extraIniFields for unknown ini keys', () => {
		const out = roundTrip({
			name: 'N',
			extraIniFields: { link_name_a: 'Site', kit_type: '1' },
		})
		expect(out.name).toBe('N')
		expect(out.extraIniFields).toEqual({ link_name_a: 'Site', kit_type: '1' })
	})

	it('preserves the keys only YARG reads, with their types', () => {
		const input = {
			preview: { start: 30000, end: 60000 }, video_end_time: 90000, video_loop: true, rating: 3, tags: 'cover', diff_vocals_harm: 4,
			covered_by: 'Cover Band', credit_composed_by: 'Composer', charter_guitar: 'Charter A', link_youtube: 'https://youtu.be/x',
			vocal_scroll_speed: 120, clean_vocals: true, tuning_offset_cents: -20,
		}
		const out = roundTrip(input)
		for (const key of Object.keys(input) as (keyof typeof input)[]) expect(out[key]).toEqual(input[key])
		expect(out.extraIniFields).toBeUndefined()
	})

	it('round-trips a full metadata set with mixed types', () => {
		const input = {
			name: 'Round Trip',
			artist: 'Tester',
			album: 'Test Album',
			genre: 'Rock',
			year: '2023',
			charter: 'Me',
			song_length: 180000,
			diff_guitar: 3,
			diff_drums: 5,
			delay: -50,
			hopo_frequency: 170,
			eighthnote_hopo: true,
			multiplier_note: 116,
			playlist: 'My Setlist',
			sub_playlist: 'Favorites',
			modchart: false,
			explicit_lyrics: true,
			rating: 2,
			tags: 'cover',
			pro_drums: true,
			five_lane_drums: false,
			end_events: true,
			extraIniFields: { link_name_a: 'Site', kit_type: '1' },
		}
		const out = roundTrip(input)
		for (const key of Object.keys(input) as (keyof typeof input)[]) {
			if (key === 'extraIniFields') continue
			expect(out[key as keyof typeof defaultMetadata]).toEqual(input[key])
		}
		expect(out.extraIniFields).toEqual(input.extraIniFields)
	})
})

describe('writeIniFile key order', () => {
	it('writes the keys only YARG reads after explicit_lyrics, before the deprecated keys, and leaves out their defaults', () => {
		const text = writeIniFile({
			delay: 50, tuning_offset_cents: 10, charter_guitar: 'A', credit_written_by: 'B', preview: { start: 1000, end: 31000 }, explicit_lyrics: true,
			name: 'Song', rating: 0, video_loop: false, vocal_scroll_speed: null, clean_vocals: false, video_end_time: -1, extraIniFields: { kit_type: '1' },
		})
		expect(text).toBe(['[song]', 'name = Song', 'explicit_lyrics = True', 'preview = 1000 31000', 'credit_written_by = B', 'charter_guitar = A',
			'tuning_offset_cents = 10', 'delay = 50', 'kit_type = 1', ''].join('\r\n'))
	})
})
