import { MidiData, writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { parseChartAndIni } from 'src/chart/parse-chart-and-ini'
import { parseChartFile } from 'src/chart/parse-chart-file'
import { drumTypes } from 'src/types'
import { scanIni } from 'src/ini/scan-ini'

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
