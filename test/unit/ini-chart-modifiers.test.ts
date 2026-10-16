import { MidiData, writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { frozenLegacy6142, songBundle20251010 } from 'src/chart/identity/public'
import { parseChartAndIni } from 'src/chart/parse-chart-and-ini'
import { parseChartFile } from 'src/chart/parse-chart-file'
import { defaultIniChartModifiers } from 'src/chart/types'
import { drumTypes } from 'src/types'
import { scanIni } from 'src/ini/scan-ini'

import { midi as midiFile } from './helpers/chart-files'

function modifiers(lines: readonly string[]) {
	const result = scanIni([{ fileName: 'song.ini', data: new TextEncoder().encode(['[song]', ...lines].join('\n')) }])
	if (result.metadata === null) throw new Error('Expected a [song] section')
	return { metadata: result.metadata, issues: result.metadataIssues.map(issue => issue.description) }
}

const integer = (key: string, value: string) => modifiers([`${key} = ${value}`]).metadata

describe('song.ini chart modifiers, read as Clone Hero reads them', () => {
	it.each([
		['170', 170],
		['+170', 170],
		['-5', -5],
		['007', 7],
		['-0', 0],
		['170\0', 170],
		['170 \0\0', 170],
		['2147483647', 2147483647],
		['-2147483648', -2147483648],
	])('parses %j like int.TryParse', (value, expected) => {
		expect(integer('chord_snap_threshold', value).chord_snap_threshold).toBe(expected)
	})

	it.each(['170.5', '170.0', '1e3', '0x10', '12abc', '- 5', '2147483648', '-2147483649', '\ufeff170', '170\0x', 'abc'])(
		'uses the default for %j, which int.TryParse rejects, and reports it',
		value => {
			const result = modifiers([`sustain_cutoff_threshold = ${value}`, `multiplier_note = ${value}`])
			expect(result.metadata).toMatchObject({ sustain_cutoff_threshold: -1, multiplier_note: 0 })
			expect(result.issues).toContain(`The "sustain_cutoff_threshold" value in "song.ini" is "${value}", which is not an integer.`)
		},
	)

	it('clamps hopo_frequency to 0 through 65535', () => {
		expect(integer('hopo_frequency', '-5').hopo_frequency).toBe(0)
		expect(integer('hopo_frequency', '70000').hopo_frequency).toBe(65535)
		expect(integer('hopo_frequency', '170.5').hopo_frequency).toBe(0)
	})

	it('trims whitespace in song.ini before parsing, with the .NET set', () => {
		expect(integer('hopo_frequency', '\u0085170\u00a0').hopo_frequency).toBe(170)
	})

	it.each([
		['2', true],
		['-1', true],
		['1', true],
		['0', false],
		['True', true],
		['FALSE', false],
		['yes', false],
		['1.0', false],
		['on', false],
	])('reads the boolean %j like IniFile.TryGetBool', (value, expected) => {
		expect(modifiers([`pro_drums = ${value}`, `five_lane_drums = ${value}`, `eighthnote_hopo = ${value}`]).metadata).toMatchObject({
			pro_drums: expected,
			five_lane_drums: expected,
			eighthnote_hopo: expected,
		})
	})
})

describe('pro_drum and star_power_note, the older names of pro_drums and multiplier_note', () => {
	const read = (lines: readonly string[]) => modifiers(lines).metadata

	it('reads an older name only when its tag isn\'t in the file, whatever the tag\'s value', () => {
		expect(read(['pro_drum = True', 'star_power_note = 116'])).toMatchObject({ pro_drums: true, multiplier_note: 116 })
		for (const value of ['', '0', '-1', 'False', 'yes']) {
			expect(read([`pro_drums = ${value}`.trim(), 'pro_drum = True']).pro_drums).toBe(value === '-1')
			expect(read([`multiplier_note = ${value}`.trim(), 'star_power_note = 116']).multiplier_note).toBe(0)
		}
		// The tag wins wherever its line is, and an older name's own line only counts without it.
		expect(read(['star_power_note = 103', 'multiplier_note = 116', 'pro_drum = False', 'pro_drums = True'])).toMatchObject({ multiplier_note: 116, pro_drums: true })
	})

	it('reads an older name as its tag would be read: in any letter case, its last line, and its value as Clone Hero reads the tag\'s', () => {
		expect(read(['PRO_DRUM = TRUE', 'Star_Power_Note = 103'])).toMatchObject({ pro_drums: true, multiplier_note: 103 })
		expect(read(['star_power_note = 116', 'star_power_note = 103', 'pro_drum = 1', 'pro_drum = 0'])).toMatchObject({ multiplier_note: 103, pro_drums: false })
		expect(read(['pro_drum = -1', 'star_power_note = +116'])).toMatchObject({ pro_drums: true, multiplier_note: 116 })
		for (const value of ['', 'yes', '1.0']) expect(read([`pro_drum = ${value}`.trim()]).pro_drums).toBe(false)
	})

	it('reports an older name\'s value that isn\'t a value of its tag, naming the line read', () => {
		const valueIssues = (lines: readonly string[]) => modifiers(lines).issues.filter(issue => issue.includes(' value in '))
		expect(read(['star_power_note = 103.0']).multiplier_note).toBe(0)
		expect(valueIssues(['star_power_note = 103.0'])).toEqual(['The "star_power_note" value in "song.ini" is "103.0", which is not an integer.'])
		expect(valueIssues(['star_power_note = 50'])).toEqual(['The "star_power_note" value in "song.ini" is "50", which is not a valid value.'])
		expect(valueIssues(['multiplier_note = 50', 'star_power_note = 116'])).toEqual(['The "multiplier_note" value in "song.ini" is "50", which is not a valid value.'])
	})

	it('reads neither for the frozen legacy hashes, as Clone Hero 1.1.0.6142 didn\'t', () => {
		const songIni = (...lines: string[]) => new TextEncoder().encode(['[song]', ...lines, ''].join('\r\n'))
		expect(frozenLegacy6142.readModifiers(songIni('pro_drum = True', 'star_power_note = 103'))).toEqual(defaultIniChartModifiers)
		expect(frozenLegacy6142.readModifiers(songIni('pro_drums = True', 'multiplier_note = 103', 'hopo_frequency = 170', 'name = Song')))
			.toEqual({ ...defaultIniChartModifiers, pro_drums: true, multiplier_note: 103, hopo_frequency: 170 })
		expect(frozenLegacy6142.readModifiers(null)).toEqual(defaultIniChartModifiers)
	})

	it.each([
		// In a .mid file, pro drums read yellow and blue as cymbals without a tom marker.
		['pro_drum', midiFile({ 'PART DRUMS': [97, 98, 99].map((noteNumber, index) => ({ tick: index * 480, noteNumber })) }), 'pro_drum = True', 'pro_drums = True'],
		// multiplier_note = 103 reads a phrase on note 103 as star power, which is otherwise a solo.
		['star_power_note', midiFile({ 'PART GUITAR': [...[0, 480, 960].map(tick => ({ tick, noteNumber: 96 })), { tick: 0, noteNumber: 103, length: 1200 }] }),
			'star_power_note = 103', 'multiplier_note = 103'],
	])('reads %s for the canonical hashes only', (_, chart, older, newer) => {
		const hashes = (line: string) => {
			const songIni = new TextEncoder().encode(`[song]\r\n${line}\r\n`)
			const parsed = parseChartAndIni([{ fileName: 'notes.mid', data: chart }, { fileName: 'song.ini', data: songIni }]).parsedChart!
			const outcome = songBundle20251010.calculate({
				source: { format: 'mid', bytes: chart }, modifiers: parsed.iniChartModifiers, legacyModifiers: frozenLegacy6142.readModifiers(songIni),
				legacyMetadata: parsed.songHashMetadata, canonicalMetadata: parsed.songHashMetadata,
			})
			if (outcome.kind !== 'accepted') throw new Error('Expected the bundle')
			return { legacy: outcome.frozenLegacy6142.tracks[0].identity.trackHash.value, canonical: outcome.canonical20260801.tracks[0].identity.trackHash.value }
		}
		const [withOlder, withNewer, withNeither] = [hashes(older), hashes(newer), hashes('name = Song')]
		expect(withOlder.canonical).toBe(withNewer.canonical)
		expect(withOlder.canonical).not.toBe(withNeither.canonical)
		expect(withOlder.legacy).toBe(withNeither.legacy)
		expect(withNewer.legacy).not.toBe(withNeither.legacy)
	})
})

describe('chart modifier values in the parser', () => {
	const midi = (noteLength: number) => new Uint8Array(writeMidi({
		header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
		tracks: [
			[{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 }, { deltaTime: 0, type: 'endOfTrack' }],
			[
				{ deltaTime: 0, type: 'trackName', text: 'PART GUITAR' },
				{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },
				{ deltaTime: noteLength, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
				{ deltaTime: 0, type: 'endOfTrack' },
			],
		] satisfies MidiData['tracks'],
	}))
	const sustain = (threshold: number) =>
		parseChartFile(midi(100), 'mid', { sustain_cutoff_threshold: threshold }).trackData[0].noteEventGroups[0][0].length

	it('uses the default MIDI sustain cutoff for any negative threshold', () => {
		expect(sustain(-1)).toBe(0)
		expect(sustain(-5)).toBe(0)
		expect(sustain(0)).toBe(100)
		expect(sustain(99)).toBe(100)
		expect(sustain(100)).toBe(0)
	})

	it('uses the default HOPO threshold for a hopo_frequency that is not positive', () => {
		const chart = new TextEncoder().encode(['[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = B 120000', '}',
			'[ExpertSingle]', '{', '  0 = N 0 0', '  60 = N 1 0', '}'].join('\r\n'))
		const flags = (hopo_frequency: number) => parseChartFile(chart, 'chart', { hopo_frequency }).trackData[0].noteEventGroups[1][0].flags
		expect(flags(-5)).toBe(flags(0))
		expect(flags(10)).not.toBe(flags(0))
	})

	it('makes pro drums from a song.ini value of 2', () => {
		const files = [
			{ fileName: 'notes.chart', data: new TextEncoder().encode(['[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = B 120000', '}',
				'[ExpertDrums]', '{', '  0 = N 2 0', '}'].join('\r\n')) },
			{ fileName: 'song.ini', data: new TextEncoder().encode('[song]\npro_drums = 2\n') },
		]
		expect(parseChartAndIni(files).parsedChart?.drumType).toBe(drumTypes.fourLanePro)
	})
})
