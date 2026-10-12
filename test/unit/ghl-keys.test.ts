import { MidiData, writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { writeChartFile } from 'src/chart/chart-writer'
import { writeMidiFile } from 'src/chart/midi-writer'
import { parseChartAndIni } from 'src/chart/parse-chart-and-ini'
import { parseChartFile } from 'src/chart/parse-chart-file'
import { scanIni } from 'src/ini/scan-ini'
import { getInstrumentType, instrumentTypes } from 'src/types'

function chart(): Uint8Array {
	return new TextEncoder().encode([
		'[Song]',
		'{',
		'  Resolution = 192',
		'}',
		'[SyncTrack]',
		'{',
		'  0 = B 120000',
		'}',
		'[Events]',
		'{',
		'}',
		'[ExpertGHLKeys]',
		'{',
		'  0 = N 0 0',
		'}',
	].join('\r\n'))
}

function midi(): Uint8Array {
	const conductor: MidiData['tracks'][number] = [
		{ deltaTime: 0, type: 'trackName', text: '' },
		{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 },
		{ deltaTime: 0, type: 'endOfTrack' },
	]
	const keys: MidiData['tracks'][number] = [
		{ deltaTime: 0, type: 'trackName', text: 'PART KEYS GHL' },
		{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 94, velocity: 100 },
		{ deltaTime: 120, type: 'noteOff', channel: 0, noteNumber: 94, velocity: 0 },
		{ deltaTime: 0, type: 'endOfTrack' },
	]
	return new Uint8Array(writeMidi({
		header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
		tracks: [conductor, keys],
	}))
}

describe('GHL keys', () => {
	it('parses the .chart section as six-fret keys', () => {
		const parsed = parseChartFile(chart(), 'chart')
		expect(parsed.trackData.map(track => [track.instrument, track.difficulty])).toEqual([
			['keysghl', 'expert'],
		])
		expect(getInstrumentType('keysghl')).toBe(instrumentTypes.sixFret)
	})

	it('parses the MIDI track as six-fret keys', () => {
		const parsed = parseChartFile(midi(), 'mid')
		expect(parsed.trackData.map(track => [track.instrument, track.difficulty])).toEqual([
			['keysghl', 'expert'],
		])
	})

	it('is written by both writers and read back', () => {
		for (const [fileName, data] of [['notes.chart', chart()], ['notes.mid', midi()]] as const) {
			const parsed = parseChartAndIni([{ fileName, data }]).parsedChart!
			const asChart = parseChartFile(new TextEncoder().encode(writeChartFile(parsed)), 'chart')
			const asMidi = parseChartFile(writeMidiFile(parsed), 'mid')
			for (const written of [asChart, asMidi]) {
				expect(written.trackData.map(track => [track.instrument, track.difficulty, track.noteEventGroups.length]), fileName)
					.toEqual([['keysghl', 'expert', 1]])
			}
		}
	})

	it('parses diff_keys_ghl as known metadata', () => {
		const parsed = scanIni([{
			fileName: 'song.ini',
			data: new TextEncoder().encode('[Song]\r\ndiff_keys_ghl = 5\r\n'),
		}])
		expect(parsed.metadata?.diff_keys_ghl).toBe(5)
		expect(parsed.unknownIniValues).toEqual({})
	})
})
