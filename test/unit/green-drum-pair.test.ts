import { parseMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { parseChartFile, parseChartFileCanonicalIdentity, parseChartFileFrozenLegacyIdentity } from 'src/chart/parse-chart-file'
import { noteFlags, noteTypes } from 'src/chart/types'
import { calculateCompetitiveHashes } from 'src/competitive'
import { fixIssues } from 'src/fix-issues'
import { scanSongFolder } from 'src/scan-song-folder'
import { parseSong, parseSongFiles } from 'src/song-document'
import type { SongFile } from 'src/song-files'

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

describe('a 5-lane green note on the tick of a green note in a pro drums chart', () => {
	it('is read as the green note alone and recorded, except in the frozen legacy profile, which moves it to a blue tom', () => {
		const data = drumsChart(['768 = N 4 0', '768 = N 5 0', '960 = N 4 0', '960 = N 68 0', '960 = N 5 0'])
		for (const parse of [parsers.scanner, parsers.canonical]) {
			expect(notesAt(parse, data, 'chart', 768)).toEqual(['greenDrum tom'])
			expect(notesAt(parse, data, 'chart', 960)).toEqual(['greenDrum cymbal'])
			expect(pairsOf(parse, data, 'chart')).toEqual(['expert 768', 'expert 960'])
		}
		expect(notesAt(parsers.legacy, data, 'chart', 768)).toEqual(['blueDrum tom', 'greenDrum tom'])
		expect(notesAt(parsers.legacy, data, 'chart', 960)).toEqual(['blueDrum tom', 'greenDrum cymbal'])
		expect(pairsOf(parsers.legacy, data, 'chart')).toEqual([])
	})

	it('reads the same in a .mid file, whether a tom marker covers the green note or not', () => {
		const data = midi({ 'PART DRUMS': [
			{ tick: 0, noteNumber: 98 }, { tick: 0, noteNumber: 110 },
			{ tick: 960, noteNumber: 100 }, { tick: 960, noteNumber: 101 }, { tick: 960, noteNumber: 112 },
			{ tick: 1920, noteNumber: 100 }, { tick: 1920, noteNumber: 101 },
		] })
		for (const parse of [parsers.scanner, parsers.canonical]) {
			expect(notesAt(parse, data, 'mid', 960)).toEqual(['greenDrum tom'])
			expect(notesAt(parse, data, 'mid', 1920)).toEqual(['greenDrum cymbal'])
			expect(pairsOf(parse, data, 'mid')).toEqual(['expert 960', 'expert 1920'])
		}
		expect(notesAt(parsers.legacy, data, 'mid', 960)).toEqual(['blueDrum tom', 'greenDrum tom'])
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

	it('is reported, and gives the chart no hashes', async () => {
		const files = folder(drumsChart(['768 = N 4 0', '768 = N 5 0']))
		const hashes = calculateCompetitiveHashes(parseSongFiles(files))
		expect(hashes.accepted).toBe(false)
		if (!hashes.accepted) expect(hashes.reason).toContain('at tick 768')
		const scanned = await scanSongFolder(files, { competitiveHashes: true })
		expect(scanned.issues.filter(issue => issue.code === 'greenDrumPair').map(({ difficulty, tick, severity }) => ({ difficulty, tick, severity })))
			.toEqual([{ difficulty: 'expert', tick: 768, severity: 'error' }])
		expect(scanned.issues.map(issue => issue.code)).toContain('badChartIdentity')
	})
})

describe('fixIssues on greenDrumPair', () => {
	const fix = async (files: SongFile[]) => fixIssues(await parseSong(files), { codes: ['greenDrumPair'], changeHashes: true })
	const drumLines = (text: string | null) => text!.split('[ExpertDrums]')[1].split('}')[0].split('\r\n').map(line => line.trim()).filter(Boolean)

	it('turns a .chart 5-lane green into a blue tom, removing a blue cymbal marker on its tick, or removes it beside a blue note', async () => {
		const { song, report } = await fix(folder(drumsChart(['768 = N 4 0', '768 = N 5 0', '768 = N 67 0', '960 = N 4 0', '960 = N 5 0', '960 = N 3 0'])))
		expect(drumLines(chartText(song))).toEqual(['{', '0 = N 2 0', '0 = N 66 0', '768 = N 4 0', '768 = N 3 0', '960 = N 4 0', '960 = N 3 0'])
		expect(report.fixed.map(entry => entry.description)).toEqual([
			'Turned the expert drums 5-lane green note on the green note\'s tick into a blue tom at tick 768.',
			'Removed the expert drums 5-lane green note on the green note\'s tick at tick 960, where a blue note on the tick keeps it from being a blue tom.',
		])
		expect(calculateCompetitiveHashes(song).accepted).toBe(true)
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
			'Turned the expert drums 5-lane green note on the green note\'s tick into a blue tom at tick 960.',
			'Removed the expert drums 5-lane green note on the green note\'s tick at tick 1920, where a blue note on the tick keeps it from being a blue tom.',
			'Turned the hard drums 5-lane green note on the green note\'s tick into a blue tom at tick 960.',
		])
	})
})
