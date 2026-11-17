import { parseMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { parseChartFile, parseChartFileCanonicalIdentity, parseChartFileFrozenLegacyIdentity } from 'src/chart/parse-chart-file'
import { noteFlags, noteTypes } from 'src/chart/types'
import { calculateCompetitiveHashes } from 'src/competitive'
import { convertChart } from 'src/convert-chart'
import { fixIssues } from 'src/fix-issues'
import { scanSongFolder } from 'src/scan-song-folder'
import { editSong, parseSong, parseSongFiles } from 'src/song-document'
import { saveSong } from 'src/song-save'
import { fileBytes, type SongFile } from 'src/song-files'

import { chartFile, chartText, midi } from './helpers/chart-files'

const parsers = { scanner: parseChartFile, canonical: parseChartFileCanonicalIdentity, legacy: parseChartFileFrozenLegacyIdentity }
type Parse = (typeof parsers)[keyof typeof parsers]

/** A `.chart` file whose drums are Expert's `lines`, made pro by a yellow cymbal at tick 0 unless `pro` is false. */
const drumsChart = (lines: readonly string[], pro = true) =>
	chartFile(['[ExpertDrums]', '{', ...[...pro ? ['0 = N 2 0', '0 = N 66 0'] : ['0 = N 2 0'], ...lines].map(line => `  ${line}`), '}'])
const folder = (chart: Uint8Array, name = 'notes.chart'): SongFile[] =>
	[{ fileName: name, data: chart }, { fileName: 'song.ini', data: new TextEncoder().encode('[song]\r\nname = Song\r\n') }, { fileName: 'song.opus', data: new Uint8Array(1) }]

/** The notes at `tick` of a track, as type and tom or cymbal. */
function notesAt(parse: Parse, data: Uint8Array, format: 'chart' | 'mid', tick: number, difficulty = 'expert') {
	const track = parse(data, format).trackData.find(track => track.instrument === 'drums' && track.difficulty === difficulty)!
	const group = track.noteEventGroups.find(group => group[0].tick === tick) ?? []
	const name = (type: number) => Object.entries(noteTypes).find(([, value]) => value === type)![0]
	return group.map(note => `${name(note.type)} ${note.flags & noteFlags.tom ? 'tom' : note.flags & noteFlags.cymbal ? 'cymbal' : ''}`.trim())
}
const pairsOf = (parse: Parse, data: Uint8Array, format: 'chart' | 'mid') =>
	parse(data, format).trackData.flatMap(track => (track.greenDrumPairs ?? []).map(pair => `${track.difficulty} ${pair.tick}`))

/** The notes at `tick` of a track, as type, tom or cymbal, length, accent or ghost, and disco flip. */
function notesWithLengthAt(parse: Parse, data: Uint8Array, format: 'chart' | 'mid', tick: number, difficulty = 'expert') {
	const track = parse(data, format).trackData.find(track => track.instrument === 'drums' && track.difficulty === difficulty)!
	const group = track.noteEventGroups.find(group => group[0].tick === tick) ?? []
	const name = (type: number) => Object.entries(noteTypes).find(([, value]) => value === type)![0]
	return group.map(note => [name(note.type), note.flags & noteFlags.tom ? 'tom' : 'cymbal', note.length,
		...note.flags & noteFlags.accent ? ['accent'] : [], ...note.flags & noteFlags.ghost ? ['ghost'] : [], ...note.flags & noteFlags.disco ? ['disco'] : []].join(' '))
}

describe('a 5-lane green note on the tick of a green note in a pro drums chart', () => {
	it('is a blue tom with its own length and accent or ghost, whatever the blue markers say, and is recorded', () => {
		// N 38 accents the 5-lane green, and N 67 would make a blue note a cymbal.
		const data = drumsChart(['768 = N 4 0', '768 = N 5 96', '768 = N 38 0', '960 = N 4 0', '960 = N 68 0', '960 = N 5 0', '960 = N 67 0'])
		for (const parse of Object.values(parsers)) {
			expect(notesWithLengthAt(parse, data, 'chart', 768)).toEqual(['blueDrum tom 96 accent', 'greenDrum tom 0'])
			expect(notesWithLengthAt(parse, data, 'chart', 960)).toEqual(['blueDrum tom 0', 'greenDrum cymbal 0'])
			expect(pairsOf(parse, data, 'chart')).toEqual(['expert 768', 'expert 960'])
		}
	})

	it('is dropped where a blue note is on the tick, which keeps its own type, accent or ghost, and length', () => {
		// N 44 makes the 5-lane green a ghost, and N 67 makes the blue note a cymbal.
		const data = drumsChart(['768 = N 3 0', '768 = N 4 0', '768 = N 5 96', '768 = N 44 0', '768 = N 67 0', '960 = N 3 48', '960 = N 4 0', '960 = N 5 0'])
		for (const parse of [parsers.scanner, parsers.canonical]) {
			expect(notesWithLengthAt(parse, data, 'chart', 768)).toEqual(['blueDrum cymbal 0', 'greenDrum tom 0'])
			expect(notesWithLengthAt(parse, data, 'chart', 960)).toEqual(['blueDrum tom 48', 'greenDrum tom 0'])
			expect(pairsOf(parse, data, 'chart')).toEqual(['expert 768', 'expert 960'])
		}
		// Clone Hero 1.1 merges it into the blue note, which takes the 5-lane green's length when that's longer.
		const legacy = drumsChart(['768 = N 3 0', '768 = N 4 0', '768 = N 5 96', '960 = N 3 48', '960 = N 4 0', '960 = N 5 0'])
		expect(notesWithLengthAt(parsers.legacy, legacy, 'chart', 768)).toEqual(['blueDrum tom 96', 'greenDrum tom 0'])
		expect(notesWithLengthAt(parsers.legacy, legacy, 'chart', 960)).toEqual(['blueDrum tom 48', 'greenDrum tom 0'])
	})

	it('reads the same in a .mid file, whether tom markers cover the tick or not', () => {
		const data = midi({ 'PART DRUMS': [
			{ tick: 0, noteNumber: 98 }, { tick: 0, noteNumber: 110 },
			{ tick: 960, noteNumber: 100 }, { tick: 960, noteNumber: 101, length: 240 }, { tick: 960, noteNumber: 112 },
			{ tick: 1920, noteNumber: 100 }, { tick: 1920, noteNumber: 101 },
			{ tick: 2880, noteNumber: 64 }, { tick: 2880, noteNumber: 65 }, { tick: 2880, noteNumber: 63 },
		] })
		for (const parse of [parsers.scanner, parsers.canonical]) {
			expect(notesWithLengthAt(parse, data, 'mid', 960)).toEqual(['blueDrum tom 240', 'greenDrum tom 0'])
			expect(notesWithLengthAt(parse, data, 'mid', 1920)).toEqual(['blueDrum tom 0', 'greenDrum cymbal 0'])
			// With 63 on the tick, 65 is dropped and the blue cymbal stays.
			expect(notesWithLengthAt(parse, data, 'mid', 2880, 'easy')).toEqual(['blueDrum cymbal 0', 'greenDrum cymbal 0'])
			expect(pairsOf(parse, data, 'mid')).toEqual(['expert 960', 'expert 1920', 'easy 2880'])
		}
		expect(notesWithLengthAt(parsers.legacy, data, 'mid', 960)).toEqual(['blueDrum tom 240', 'greenDrum tom 0'])
		expect(notesWithLengthAt(parsers.legacy, data, 'mid', 1920)).toEqual(['blueDrum tom 0', 'greenDrum cymbal 0'])
		expect(notesWithLengthAt(parsers.legacy, data, 'mid', 2880, 'easy')).toEqual(['blueDrum cymbal 0', 'greenDrum cymbal 0'])
	})

	it('stays a blue tom under a disco flip, which swaps only the red and yellow notes', () => {
		const data = drumsChart(['0 = E mix 3 drums0d', '768 = N 1 0', '768 = N 4 0', '768 = N 5 0'])
		for (const parse of Object.values(parsers)) {
			expect(notesWithLengthAt(parse, data, 'chart', 768)).toEqual(['redDrum tom 0 disco', 'blueDrum tom 0', 'greenDrum tom 0'])
		}
	})

	it('takes the blue note\'s own type, accent and ghost with the longer length in the frozen legacy profile, as Clone Hero 1.1 does', () => {
		const notes = (data: Uint8Array, format: 'chart' | 'mid', tick: number) => {
			const track = parsers.legacy(data, format).trackData.find(track => track.instrument === 'drums' && track.difficulty === 'expert')!
			const group = track.noteEventGroups.find(group => group[0].tick === tick)!
			return group.filter(note => note.type === noteTypes.blueDrum).map(note => [note.flags & noteFlags.tom ? 'tom' : 'cymbal', note.length,
				...note.flags & noteFlags.accent ? ['accent'] : [], ...note.flags & noteFlags.ghost ? ['ghost'] : []].join(' '))
		}
		// N 38 accents and N 44 ghosts the 5-lane green, N 36 accents the blue note, and N 67 makes it a cymbal.
		const chart = drumsChart([
			'768 = N 3 0', '768 = N 4 0', '768 = N 5 96', '768 = N 38 0',
			'960 = N 3 0', '960 = N 67 0', '960 = N 4 0', '960 = N 5 96', '960 = N 38 0',
			'1152 = N 3 0', '1152 = N 67 0', '1152 = N 4 0', '1152 = N 5 96', '1152 = N 44 0',
			'1344 = N 3 0', '1344 = N 36 0', '1344 = N 4 0', '1344 = N 5 96',
		])
		expect([768, 960, 1152, 1344].map(tick => notes(chart, 'chart', tick))).toEqual([['tom 96'], ['cymbal 96'], ['cymbal 96'], ['tom 96 accent']])
		// A .mid blue note is a cymbal without a blue tom marker. The yellow tom marker at tick 0 makes the chart pro.
		const mid = midi({ 'PART DRUMS': [{ tick: 0, noteNumber: 98 }, { tick: 0, noteNumber: 110 }, { tick: 960, noteNumber: 99 }, { tick: 960, noteNumber: 100 }, { tick: 960, noteNumber: 101, length: 480 }] })
		expect(notes(mid, 'mid', 960)).toEqual(['cymbal 480'])
	})

	it('leaves a 5-lane chart and a lone 5-lane green in a pro chart as they are', () => {
		const fiveLane = drumsChart(['768 = N 4 0', '768 = N 5 0'], false)
		const lone = drumsChart(['768 = N 5 0'])
		for (const parse of Object.values(parsers)) {
			expect(notesAt(parse, fiveLane, 'chart', 768)).toEqual(['blueDrum tom', 'greenDrum cymbal'])
			expect(notesAt(parse, lone, 'chart', 768)).toEqual(['greenDrum tom'])
			expect(pairsOf(parse, fiveLane, 'chart')).toEqual([])
			expect(pairsOf(parse, lone, 'chart')).toEqual([])
		}
	})

	it('is reported as an error, and the chart has hashes', async () => {
		const files = folder(drumsChart(['768 = N 4 0', '768 = N 5 0']))
		expect(calculateCompetitiveHashes(parseSongFiles(files)).accepted).toBe(true)
		const scanned = await scanSongFolder(files, { competitiveHashes: true })
		expect(scanned.issues.filter(issue => issue.code === 'greenDrumPair').map(({ difficulty, tick, severity }) => ({ difficulty, tick, severity })))
			.toEqual([{ difficulty: 'expert', tick: 768, severity: 'error' }])
		expect(scanned.issues.map(issue => issue.code)).not.toContain('badChartIdentity')
	})

	it('is kept as written by saving, and converted as a scanner reads it', async () => {
		const song = await parseSong(folder(drumsChart(['768 = N 3 0', '768 = N 4 0', '768 = N 5 0', '960 = N 4 0', '960 = N 5 96', '960 = N 38 0'])))
		const saved = saveSong(song, editSong(song, batch => batch.setMetadata('name', 'Other'))).files
		expect(new TextDecoder().decode(fileBytes(saved.find(file => file.fileName === 'notes.chart')!))).toContain('768 = N 5 0')
		const converted = convertChart(song, 'mid').song.chart!
		const bytes = converted.format === 'mid' ? converted.bytes : new Uint8Array()
		// The .mid file keeps the .chart file's 192 ticks per beat.
		expect(notesWithLengthAt(parsers.scanner, bytes, 'mid', 768)).toEqual(['blueDrum tom 0', 'greenDrum tom 0'])
		expect(notesWithLengthAt(parsers.scanner, bytes, 'mid', 960)).toEqual(['blueDrum tom 96 accent', 'greenDrum tom 0'])
		expect(pairsOf(parsers.scanner, bytes, 'mid')).toEqual([])
	})
})

describe('fixIssues on greenDrumPair', () => {
	const fix = async (files: SongFile[]) => fixIssues(await parseSong(files), { codes: ['greenDrumPair'], changeHashes: true })
	const drumLines = (text: string | null) => text!.split('[ExpertDrums]')[1].split('}')[0].split('\r\n').map(line => line.trim()).filter(Boolean)

	it('turns a .chart 5-lane green into a blue tom, removing a blue cymbal marker on its tick, or removes it beside a blue note', async () => {
		const { song, report } = await fix(folder(drumsChart(['768 = N 4 0', '768 = N 5 0', '768 = N 67 0', '960 = N 4 0', '960 = N 5 0', '960 = N 3 0'])))
		expect(drumLines(chartText(song))).toEqual(['{', '0 = N 2 0', '0 = N 66 0', '768 = N 4 0', '768 = N 3 0', '960 = N 4 0', '960 = N 3 0'])
		expect(report.fixed.map(entry => entry.description)).toEqual([
			'Turned the expert drums 5-lane green note that shares a tick with a green note into a blue tom at tick 768.',
			'Removed the expert drums 5-lane green note that shares a tick with a green note at tick 960, where a blue note is already on the tick.',
		])
		expect(calculateCompetitiveHashes(song).accepted).toBe(true)
	})

	it('gives the blue tom the 5-lane green\'s accent or ghost in a .chart file, as a scanner reads it', async () => {
		const { song, report } = await fix(folder(drumsChart(['768 = N 4 0', '768 = N 5 0', '768 = N 38 0', '960 = N 4 0', '960 = N 5 0', '960 = N 44 0', '960 = N 36 0'])))
		expect(drumLines(chartText(song))).toEqual(['{', '0 = N 2 0', '0 = N 66 0', '768 = N 4 0', '768 = N 3 0', '768 = N 36 0', '960 = N 4 0', '960 = N 3 0', '960 = N 42 0'])
		const fixedChart = new TextEncoder().encode(chartText(song)!)
		const flags = (tick: number) => parsers.canonical(fixedChart, 'chart').trackData[0].noteEventGroups
			.find(group => group[0].tick === tick)!.find(note => note.type === noteTypes.blueDrum)!.flags & (noteFlags.tom | noteFlags.accent | noteFlags.ghost)
		expect([flags(768), flags(960)]).toEqual([noteFlags.tom | noteFlags.accent, noteFlags.tom | noteFlags.ghost])
		expect(report.fixed.map(entry => entry.description)).toEqual([
			'Turned the expert drums 5-lane green notes that share a tick with a green note into blue toms at ticks 768, 960.',
		])
	})

	it('turns a .mid 5-lane green into a blue tom under a new tom marker, or removes it where the marker would change another difficulty', async () => {
		const data = midi({ 'PART DRUMS': [
			{ tick: 0, noteNumber: 98 }, { tick: 0, noteNumber: 110 },
			{ tick: 960, noteNumber: 100 }, { tick: 960, noteNumber: 101 }, { tick: 960, noteNumber: 88 }, { tick: 960, noteNumber: 89 },
			{ tick: 1920, noteNumber: 100 }, { tick: 1920, noteNumber: 101 }, { tick: 1920, noteNumber: 87 },
		] })
		const { song, report } = await fix(folder(data, 'notes.mid'))
		const fixed = song.chart!.format === 'mid' ? song.chart!.bytes : new Uint8Array()
		for (const difficulty of ['expert', 'hard']) expect(notesAt(parsers.canonical, fixed, 'mid', 960, difficulty)).toEqual(['blueDrum tom', 'greenDrum cymbal'])
		expect(notesAt(parsers.canonical, fixed, 'mid', 1920)).toEqual(['greenDrum cymbal'])
		expect(notesAt(parsers.canonical, fixed, 'mid', 1920, 'hard')).toEqual(['blueDrum cymbal'])
		expect(pairsOf(parsers.canonical, fixed, 'mid')).toEqual([])
		// The two difficulties' fixes at tick 960 share one tom marker.
		const drums = parseMidi(fixed).tracks.find(track => track.some(event => event.type === 'trackName' && event.text === 'PART DRUMS'))!
		expect(drums.filter(event => event.type === 'noteOn' && event.noteNumber === 111 && event.velocity > 0)).toHaveLength(1)
		expect(report.fixed.map(entry => entry.description)).toEqual([
			'Turned the expert drums 5-lane green note that shares a tick with a green note into a blue tom at tick 960.',
			'Removed the expert drums 5-lane green note that shares a tick with a green note at tick 1920, '
				+ 'where a blue tom marker would turn another difficulty\'s blue cymbal on the tick into a tom.',
			'Turned the hard drums 5-lane green note that shares a tick with a green note into a blue tom at tick 960.',
		])
	})

	it('makes a fix that changes the hashes only with changeHashes, and the .chart fix keeps them', async () => {
		const mid = midi({ 'PART DRUMS': [{ tick: 0, noteNumber: 98 }, { tick: 0, noteNumber: 110 }, { tick: 960, noteNumber: 100 }, { tick: 960, noteNumber: 101 }, { tick: 960, noteNumber: 87 }] })
		const withheld = await fixIssues(await parseSong(folder(mid, 'notes.mid')), { codes: ['greenDrumPair'] })
		expect(withheld.report.fixed).toEqual([])
		expect(withheld.report.skipped.map(entry => entry.reason)).toEqual([
			'Fixing the expert drums 5-lane green note at tick 960 would change the SongHash and a TrackHash: fix it with changeHashes.',
		])
		const chart = await fixIssues(await parseSong(folder(drumsChart(['768 = N 4 0', '768 = N 5 0']))), { codes: ['greenDrumPair'] })
		expect(chart.report.fixed.map(entry => entry.code)).toEqual(['greenDrumPair'])
		expect(chart.report.hashes).toEqual([])
	})
})
