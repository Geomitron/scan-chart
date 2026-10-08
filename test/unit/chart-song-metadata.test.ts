import { describe, expect, it } from 'vitest'

import { canonical20260801 } from 'src/chart/identity/public'
import { SongHashMetadata } from 'src/chart/identity/song-hash-20251010'
import { canonicalChartDurationMs } from 'src/chart/identity/duration-types'
import { parseNotesFromChart, readChartSongMetadata } from 'src/chart/chart-file-parser'
import { parseChartAndIni } from 'src/chart/parse-chart-and-ini'
import { File } from 'src/types'

function chart(songLines: readonly string[], firstSection = 'Song'): Uint8Array {
	const song = ['[Song]', '{', '  Resolution = 192', ...songLines.map(line => `  ${line}`), '}']
	const sync = ['[SyncTrack]', '{', '  0 = B 120000', '}']
	const body = [...(firstSection === 'Song' ? [...song, ...sync] : [...sync, ...song]), '[ExpertSingle]', '{', '  0 = N 0 0', '}']
	return new TextEncoder().encode(body.join('\r\n'))
}

function chartMetadata(songLines: readonly string[]) {
	return readChartSongMetadata(chart(songLines))
}

function folder(songLines: readonly string[], ini?: { fileName: string; text: string }): File[] {
	const files: File[] = [{ fileName: 'notes.chart', data: chart(songLines) }]
	if (ini) files.push({ fileName: ini.fileName, data: new TextEncoder().encode(ini.text) })
	return files
}

function songHashMetadata(files: File[]): SongHashMetadata {
	const parsed = parseChartAndIni(files).parsedChart
	if (!parsed) throw new Error('Expected the chart to parse')
	return parsed.songHashMetadata
}

const blankMetadata: SongHashMetadata = { name: null, artist: null, album: null, genre: null, year: null, charter: null, icon: null }

function canonicalMetadata(metadata: Partial<SongHashMetadata>) {
	return canonical20260801.calculateSongIdentity({
		metadata: { ...blankMetadata, ...metadata },
		durationMs: canonicalChartDurationMs(0n),
		members: [],
	}).metadata
}

describe('.chart [Song] metadata read as Clone Hero reads it', () => {
	it('removes a leading ", " from Year only when it is present', () => {
		expect(chartMetadata(['Year = "2004"']).year).toBe('2004')
		expect(chartMetadata(['Year = ", 2004"']).year).toBe('2004')
		expect(chartMetadata(['Year = ",2004"']).year).toBe(',2004')
		expect(chartMetadata(['Year = ",  2004"']).year).toBe(' 2004')
		expect(chartMetadata(['Year = ", "']).year).toBe(',')
	})

	it('trims after removing the outer quotes, and keeps inner quotes', () => {
		expect(chartMetadata(['Artist = "BEMANI Sound Team "']).artist).toBe('BEMANI Sound Team')
		expect(chartMetadata(['Name = "Say "Hi""']).name).toBe('Say "Hi"')
		expect(chartMetadata(['Album = "Unclosed']).album).toBe('Unclosed')
		expect(chartMetadata(['Genre = Unquoted"']).genre).toBe('Unquoted')
		expect(chartMetadata(['Charter="Geo"']).charter).toBe('Geo')
		expect(chartMetadata(['Name = "Name\u0085"']).name).toBe('Name')
	})

	it('matches keys exactly and keeps the first nonblank value', () => {
		expect(chartMetadata(['name = "lower"', 'Name = "First"', 'Name = "Second"']).name).toBe('First')
		expect(chartMetadata(['Artist = ""', 'Artist = "Later"']).artist).toBe('Later')
	})

	it('stops reading at a TEMPO TRACK or midi_export name', () => {
		expect(chartMetadata(['Artist = "Before"', 'Name = "TEMPO TRACK"', 'Charter = "After"'])).toEqual({ artist: 'Before' })
		expect(chartMetadata(['Name = "Kept"', 'Name = "midi_export"', 'Album = "After"'])).toEqual({ name: 'Kept' })
	})

	it('reads only the first section of the file', () => {
		expect(readChartSongMetadata(chart(['Name = "Late"'], 'SyncTrack')).name).toBeUndefined()
	})

	it('decodes text that is not UTF-8 as ISO-8859-1', () => {
		const prefix = new TextEncoder().encode('[Song]\r\n{\r\n  Resolution = 192\r\n  Name = "Caf')
		const suffix = new TextEncoder().encode('"\r\n}\r\n[SyncTrack]\r\n{\r\n  0 = B 120000\r\n}\r\n')
		expect(readChartSongMetadata(Uint8Array.from([...prefix, 0xe9, ...suffix])).name).toBe('Caf\u00e9')
	})
})

describe('.chart [Song] metadata in the scanner', () => {
	it('removes a leading ", " from Year only when it is present', () => {
		expect(parseNotesFromChart(chart(['Year = "2004"'])).metadata.year).toBe('2004')
		expect(parseNotesFromChart(chart(['Year = ", 2004"'])).metadata.year).toBe('2004')
	})

	it('keeps [Song] values that the Clone Hero reader skips, for round-trip writers', () => {
		expect(parseNotesFromChart(chart(['Name = "Late"'], 'SyncTrack')).metadata.name).toBe('Late')
		expect(parseNotesFromChart(chart(['Name = "TEMPO TRACK"', 'Artist = "After"'])).metadata).toMatchObject({
			name: 'TEMPO TRACK',
			artist: 'After',
		})
	})
})

describe('SongHash metadata source precedence', () => {
	it('uses only song.ini values when song.ini has a [song] section', () => {
		expect(songHashMetadata(folder(['Name = "Chart Name"', 'Artist = "Chart Artist"'], {
			fileName: 'song.ini',
			text: '[song]\nartist = Ini Artist\n',
		}))).toMatchObject({ name: 'Unknown Name', artist: 'Ini Artist' })
	})

	it('uses .chart values when song.ini is empty or missing its [song] section', () => {
		const expected = { name: 'Chart Name', artist: 'BEMANI Sound Team', year: 'Unknown Year' }
		expect(songHashMetadata(folder(['Name = "Chart Name"', 'Artist = "BEMANI Sound Team "'], { fileName: 'song.ini', text: '' })))
			.toMatchObject(expected)
		expect(songHashMetadata(folder(['Name = "Chart Name"', 'Artist = "BEMANI Sound Team "'], { fileName: 'song.ini', text: '[other]\n' })))
			.toMatchObject(expected)
	})

	it('reads song.ini in any letter case, but no other .ini file', () => {
		expect(songHashMetadata(folder(['Name = "Chart Name"'], { fileName: 'Song.INI', text: '[song]\nname = Ini Name\n' })).name)
			.toBe('Ini Name')
		const other = folder(['Name = "Chart Name"'], { fileName: 'other.ini', text: '[song]\nname = Ini Name\n' })
		expect(songHashMetadata(other).name).toBe('Chart Name')
		expect(parseChartAndIni(other).parsedChart?.metadata.name).toBe('Ini Name')
	})

	it('falls back from charter to frets only when the charter key is absent', () => {
		expect(songHashMetadata(folder([], { fileName: 'song.ini', text: '[song]\nfrets = Frets\n' })).charter).toBe('Frets')
		expect(songHashMetadata(folder([], { fileName: 'song.ini', text: '[song]\ncharter =\nfrets = Frets\n' })).charter)
			.toBe('Unknown Charter')
		expect(songHashMetadata(folder([], { fileName: 'song.ini', text: '[song]\ncharter = 0\nfrets = Frets\n' })).charter).toBe('0')
	})

	it('keeps raw values for the canonical writer and lowercases the icon', () => {
		expect(songHashMetadata(folder([], { fileName: 'song.ini', text: '[song]\nname = <b>0</b>\nicon = MyIcon\n' }))).toMatchObject({
			name: '<b>0</b>',
			icon: 'myicon',
		})
	})
})

describe('canonical SongHash metadata resolution', () => {
	it('treats null, "0", and "-1" as unset and strips style tags afterwards', () => {
		expect(canonicalMetadata({ name: '0', artist: '-1', album: '<b>0</b>', genre: ' <i>Rock</i> ', year: null })).toMatchObject({
			name: 'Unknown Name',
			artist: 'Unknown Artist',
			album: '0',
			genre: 'Rock',
			year: 'Unknown Year',
			charter: 'Unknown Charter',
			icon: '',
		})
	})

	it('lowercases the icon and clears it when it equals the charter', () => {
		expect(canonicalMetadata({ charter: '<color=#fff>Geo</color>', icon: 'GEO' }).icon).toBe('')
		expect(canonicalMetadata({ charter: 'Geo', icon: 'Other' }).icon).toBe('other')
		expect(canonicalMetadata({ charter: 'Geo', icon: '-1' }).icon).toBe('')
	})

	it('gives a .chart-only folder the SongHash of the equivalent song.ini', () => {
		const songHash = (files: File[]) => {
			const parsed = parseChartAndIni(files).parsedChart!
			const source = canonical20260801.parseSource({ source: { format: 'chart', bytes: parsed.chartBytes }, modifiers: parsed.iniChartModifiers })
			if (source.kind !== 'accepted') throw new Error('Expected canonical parse')
			return canonical20260801.calculateSongIdentity({
				metadata: parsed.songHashMetadata,
				durationMs: source.chart.duration.durationMs,
				members: source.chart.tracks.map(track => ({
					instrument: track.key.instrument,
					difficulty: track.key.difficulty,
					digest: canonical20260801.calculateTrackIdentity(track).digest,
				})),
			}).songHash.value
		}
		const chartOnly = folder(['Name = "<b>Bold</b> Name "', 'Year = ", 2004"', 'Charter = "0"', 'Artist = " Artist"'])
		const withIni = [
			...folder([]),
			{ fileName: 'song.ini', data: new TextEncoder().encode('[song]\nname = Bold Name\nyear = 2004\nartist = Artist\n') },
		].filter((file, index, files) => files.findIndex(other => other.fileName === file.fileName) === index)
		expect(songHash(chartOnly)).toBe(songHash(withIni))
	})
})
