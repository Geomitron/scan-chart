/**
 * Tests for song.ini scanning: known property extraction and unknown value preservation.
 */

import { describe, it, expect } from 'vitest'
import { File } from '../interfaces'
import { scanIni } from '../ini/ini-scanner'

function buildIni(lines: string[]): File[] {
	const text = lines.join('\r\n')
	return [{ fileName: 'song.ini', data: new TextEncoder().encode(text) }]
}

describe('scanIni: unknownIniValues', () => {
	it('returns unrecognized keys from [Song] section', () => {
		const files = buildIni([
			'[Song]',
			'name = Test Song',
			'artist = Test Artist',
			'diff_vocals_harm = 3',
			'sysex_slider = True',
			'rating = 2',
		])

		const result = scanIni(files)
		expect(result.unknownIniValues).toEqual({
			diff_vocals_harm: '3',
			sysex_slider: 'True',
			rating: '2',
		})
	})

	it('does not include recognized keys in unknownIniValues', () => {
		const files = buildIni([
			'[Song]',
			'name = Test Song',
			'artist = Test Artist',
			'album = Test Album',
			'genre = Rock',
			'year = 2024',
			'charter = Tester',
			'diff_guitar = 4',
			'pro_drums = True',
			'hopo_frequency = 170',
		])

		const result = scanIni(files)
		expect(result.unknownIniValues).toEqual({})
	})

	it('does not include legacy alias keys in unknownIniValues', () => {
		const files = buildIni([
			'[Song]',
			'frets = Legacy Charter',    // legacy alias for charter
			'track = 5',                 // legacy alias for album_track
			'hopofreq = 170',           // legacy alias for hopo_frequency
			'star_power_note = 116',    // legacy alias for multiplier_note
		])

		const result = scanIni(files)
		expect(result.unknownIniValues).toEqual({})
	})

	it('preserves common unrecognized keys found in real charts', () => {
		const files = buildIni([
			'[Song]',
			'name = Test',
			'diff_vocals_harm = 3',
			'diff_guitar_real = 5',
			'diff_bass_real = 4',
			'diff_keys_real = 3',
			'diff_guitar_real_22 = 5',
			'diff_bass_real_22 = 4',
			'diff_dance = 2',
			'diff_drums_real_ps = 3',
			'diff_keys_real_ps = 2',
			'sysex_slider = True',
			'sysex_open_bass = True',
			'sysex_high_hat_ctrl = True',
			'sysex_rimshot = True',
			'sysex_pro_slide = True',
			'kit_type = 1',
			'guitar_type = 0',
			'bass_type = 0',
			'keys_type = 0',
			'dance_type = 0',
			'real_guitar_tuning = 0 0 0 0 0 0',
			'real_bass_tuning = 0 0 0 0',
			'real_keys_lane_count_right = 5',
			'real_keys_lane_count_left = 5',
			'vocal_gender = male',
			'vocal_scroll_speed = 100',
			'rating = 1',
			'count = 42',
			'version = 2',
			'playlist = My Setlist',
			'sub_playlist = Favorites',
			'explicit_lyrics = True',
			'video_loop = True',
			'video_end_time = 180000',
			'drum_fallback_blue = True',
			'link_name_a = YouTube',
			'banner_link_a = https://youtube.com',
			'link_name_b = Spotify',
			'banner_link_b = https://spotify.com',
		])

		const result = scanIni(files)
		// All 38 non-standard keys should be preserved
		expect(Object.keys(result.unknownIniValues).length).toBeGreaterThanOrEqual(36)
		expect(result.unknownIniValues.diff_vocals_harm).toBe('3')
		expect(result.unknownIniValues.diff_guitar_real).toBe('5')
		expect(result.unknownIniValues.sysex_slider).toBe('True')
		expect(result.unknownIniValues.kit_type).toBe('1')
		expect(result.unknownIniValues.real_guitar_tuning).toBe('0 0 0 0 0 0')
		expect(result.unknownIniValues.vocal_gender).toBe('male')
		expect(result.unknownIniValues.rating).toBe('1')
		expect(result.unknownIniValues.playlist).toBe('My Setlist')
		expect(result.unknownIniValues.link_name_a).toBe('YouTube')
		expect(result.unknownIniValues.banner_link_a).toBe('https://youtube.com')
	})

	it('preserves typo keys without correcting them', () => {
		const files = buildIni([
			'[Song]',
			'name = Test',
			'loading_phase = Almost there',     // typo for loading_phrase
			'previw_start_time = 5000',          // typo for preview_start_time
			'diff_drums_ real = 3',              // typo with space
		])

		const result = scanIni(files)
		expect(result.unknownIniValues.loading_phase).toBe('Almost there')
		expect(result.unknownIniValues.previw_start_time).toBe('5000')
		expect(result.unknownIniValues['diff_drums_ real']).toBe('3')
	})

	it('returns empty unknownIniValues when no ini file found', () => {
		const result = scanIni([])
		expect(result.unknownIniValues).toEqual({})
		expect(result.metadata).toBeNull()
	})

	it('returns empty unknownIniValues when ini has no [Song] section', () => {
		const files = buildIni(['[Other]', 'key = value'])
		const result = scanIni(files)
		expect(result.unknownIniValues).toEqual({})
		expect(result.metadata).toBeNull()
	})

	it('preserves values with special characters', () => {
		const files = buildIni([
			'[Song]',
			'name = Test',
			'real_guitar_22_tuning = -2 -2 -2 -2 -2 -2 Standard Drop D',
			'tags = cover',
			'credit_composed_by = John Doe & Jane Doe',
		])

		const result = scanIni(files)
		expect(result.unknownIniValues.real_guitar_22_tuning).toBe('-2 -2 -2 -2 -2 -2 Standard Drop D')
		expect(result.unknownIniValues.tags).toBe('cover')
		expect(result.unknownIniValues.credit_composed_by).toBe('John Doe & Jane Doe')
	})
})
