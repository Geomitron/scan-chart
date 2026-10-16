/**
 * Tests for song.ini scanning: known property extraction and unknown value preservation.
 */

import { describe, it, expect } from 'vitest'
import { File } from 'src/types'
import { scanIni } from 'src/ini/scan-ini'

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
		expect(result.unknownIniValues).toEqual({ sysex_slider: 'True' })
		expect(result.metadata).toMatchObject({ diff_vocals_harm: 3, rating: 2 })
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
		])

		const result = scanIni(files)
		expect(result.unknownIniValues).toEqual({})
	})

	it('preserves hopofreq without reading it, as Clone Hero ignores it', () => {
		const result = scanIni(buildIni(['[Song]', 'hopofreq = 170']))
		expect(result.metadata).toMatchObject({ hopo_frequency: 0 })
		expect(result.unknownIniValues).toEqual({ hopofreq: '170' })
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
		// Every key but name, the three Clone Hero reads, playlist, sub_playlist and explicit_lyrics, and the eleven YARG reads
		// as metadata, is preserved
		expect(Object.keys(result.unknownIniValues)).toHaveLength(24)
		expect(result.metadata).toMatchObject({
			playlist: 'My Setlist', sub_playlist: 'Favorites', explicit_lyrics: true, diff_vocals_harm: 3, diff_guitar_real: 5, diff_bass_real: 4, diff_keys_real: 3,
			diff_guitar_real_22: 5, diff_bass_real_22: 4, vocal_gender: 'male', vocal_scroll_speed: 100, rating: 1, video_loop: true, video_end_time: 180000,
		})
		expect(result.unknownIniValues.diff_dance).toBe('2')
		expect(result.unknownIniValues.sysex_slider).toBe('True')
		expect(result.unknownIniValues.kit_type).toBe('1')
		expect(result.unknownIniValues.real_guitar_tuning).toBe('0 0 0 0 0 0')
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

	it('reads charter and album_track whenever they\'re in the file, and frets and track only when they aren\'t', () => {
		const read = (lines: string[]) => scanIni(buildIni(['[Song]', ...lines])).metadata!
		expect(read(['charter =', 'frets = Someone']).charter).toBe('Unknown Charter')
		expect(read(['charter = 0', 'frets = Someone']).charter).toBe('0')
		expect(read(['charter = -1', 'frets = Someone']).charter).toBe('-1')
		expect(read(['frets = Someone']).charter).toBe('Someone')
		expect(read(['frets = 0']).charter).toBe('0')
		for (const albumTrack of ['', '-1', 'abc']) expect(read([`album_track = ${albumTrack}`, 'track = 3']).album_track).toBe(16000)
		expect(read(['track = 3']).album_track).toBe(3)
		expect(read(['track = -1']).album_track).toBe(16000)
	})

	it('reads text 0 and -1 as text, and a blank number or -1 as not set', () => {
		const { metadata, metadataIssues } = scanIni(buildIni(['[Song]', 'name = 0', 'artist = -1', 'album =', 'diff_guitar =', 'diff_bass = -1', 'delay = -1', 'playlist_track = -1']))
		expect(metadata).toMatchObject({ name: '0', artist: '-1', album: 'Unknown Album', diff_guitar: -1, diff_bass: -1, delay: 0, playlist_track: 16000 })
		expect(metadataIssues.map(issue => issue.description).filter(description => /"(name|artist|album)"/.test(description)))
			.toEqual(['Metadata is missing the "album" property.'])
	})

	it('reads playlist and sub_playlist as written, and explicit_lyrics as true or false', () => {
		const read = (lines: string[]) => scanIni(buildIni(['[Song]', ...lines])).metadata!
		expect(read(['playlist = My <b>Setlist</b>', 'sub_playlist = Favorites', 'explicit_lyrics = True']))
			.toMatchObject({ playlist: 'My Setlist', sub_playlist: 'Favorites', explicit_lyrics: true })
		expect(read(['playlist =', 'explicit_lyrics = maybe'])).toMatchObject({ playlist: '', sub_playlist: '', explicit_lyrics: false })
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
		expect(result.metadata).toMatchObject({ tags: 'cover', credit_composed_by: 'John Doe & Jane Doe' })
	})
})

describe('scanIni: the keys only YARG reads', () => {
	const read = (lines: string[]) => scanIni(buildIni(['[Song]', ...lines])).metadata!

	it('reads each with YARG\'s type, and its default when it isn\'t set', () => {
		expect(read(['name = Song'])).toMatchObject({
			preview: null, video_end_time: -1, video_loop: false, background: '', rating: 0, tags: '', diff_vocals_harm: -1, diff_elite_drums: -1,
			date_released: '', credit_album_art_designed_by: '', charter_audio: '', link_youtube: '', vocal_gender: '', vocal_scroll_speed: null,
			clean_vocals: false, tuning_offset_cents: 0,
		})
		expect(read(['video = bg.webm', 'cover = art.png', 'date_released = 2004-05', 'charter_drums = <b>Me</b>', 'clean_vocals = 1', 'tuning_offset_cents = -15']))
			.toMatchObject({ video: 'bg.webm', cover: 'art.png', date_released: '2004-05', charter_drums: 'Me', clean_vocals: true, tuning_offset_cents: -15 })
	})

	it('reads preview as YARG does: a whole number, then after spaces or "=" another, or -1', () => {
		expect(read(['preview = 30000 60000']).preview).toEqual({ start: 30000, end: 60000 })
		expect(read(['preview = 30000=60000']).preview).toEqual({ start: 30000, end: 60000 })
		expect(read(['preview = 30000']).preview).toEqual({ start: 30000, end: -1 })
		expect(read(['preview = 30000abc 60000']).preview).toEqual({ start: 30000, end: -1 })
		for (const value of ['', 'soon', '-']) expect(read([`preview = ${value}`.trim()]).preview).toBeNull()
	})

	it('reads vocal_scroll_speed as other numbers are read, as not set when it\'s blank, -1 or not a number', () => {
		expect(read(['vocal_scroll_speed = 80']).vocal_scroll_speed).toBe(80)
		for (const value of ['', '-1', 'fast']) expect(read([`vocal_scroll_speed = ${value}`.trim()]).vocal_scroll_speed).toBeNull()
		const { metadata, metadataIssues } = scanIni(buildIni(['[Song]', 'vocal_scroll_speed = 80.5', 'rating = 2.5']))
		expect(metadata).toMatchObject({ vocal_scroll_speed: 81, rating: 3 })
		expect(metadataIssues.map(issue => issue.description).filter(description => description.includes('integer'))).toEqual([
			'The "rating" value in "song.ini" is "2.5", which is not an integer.',
			'The "vocal_scroll_speed" value in "song.ini" is "80.5", which is not an integer.',
		])
	})
})
