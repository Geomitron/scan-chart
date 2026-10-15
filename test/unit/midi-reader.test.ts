import { describe, expect, it } from 'vitest'

import { parseChartFile, parseChartFileCanonicalIdentity, parseChartFileFrozenLegacyIdentity } from 'src/chart/parse-chart-file'
import { noteFlags } from 'src/chart/types'

import { midiFile, midiNote, phaseShiftSysEx as sysEx, type TimedMidiEvent } from './helpers/midi-files'

/** A `.mid` file with one instrument track, PART GUITAR unless named otherwise. */
const guitarMidi = (events: readonly TimedMidiEvent[], trackName = 'PART GUITAR') => midiFile([{ name: trackName, events }])
const note = (tick: number, noteNumber: number, channel = 0) => midiNote(tick, noteNumber, 1, channel)
const greens = [0, 100, 200, 300].flatMap(tick => note(tick, 96))
const parsers = { scanner: parseChartFile, canonical: parseChartFileCanonicalIdentity, legacy: parseChartFileFrozenLegacyIdentity }
const tapTicks = (data: Uint8Array, parse: (data: Uint8Array, format: 'mid') => ReturnType<typeof parseChartFile>) =>
	parse(data, 'mid').trackData.find(track => track.difficulty === 'expert')!.noteEventGroups.filter(group => group[0].flags & noteFlags.tap).map(group => group[0].tick)

describe('the .mid reader pairs a SysEx phrase as Clone Hero does', () => {
	it('ends an all-difficulty tap only with an all-difficulty end, not with an Expert one', () => {
		const data = guitarMidi([...greens, sysEx(0, 0xff, 4, true), sysEx(100, 3, 4, false), sysEx(400, 0xff, 4, false)])
		for (const parse of Object.values(parsers)) expect(tapTicks(data, parse)).toEqual([0, 100, 200, 300])
	})

	it('never pairs a tap note 104 with a tap SysEx, even on channel 1', () => {
		const data = guitarMidi([...greens, ...note(0, 104, 1).slice(0, 1), sysEx(100, 3, 4, false), { tick: 400, event: note(0, 104, 1)[1].event }])
		for (const parse of Object.values(parsers)) expect(tapTicks(data, parse)).toEqual([0, 100, 200, 300])
	})
})

describe('the .mid reader refuses what Clone Hero refuses', () => {
	it('refuses a tempo of 0, which is an infinite BPM, in every profile', () => {
		const data = midiFile([{ name: 'PART GUITAR', events: greens }], { tempos: [{ tick: 0, microsecondsPerBeat: 500000 }, { tick: 480, microsecondsPerBeat: 0 }] })
		for (const parse of Object.values(parsers)) expect(() => parse(data, 'mid')).toThrow('Tempo at tick 480 was zero')
	})

	it('refuses a 5- or 6-fret tap or open SysEx phrase whose difficulty byte is not 0 to 3 or 255', () => {
		for (const trackName of ['PART GUITAR', 'PART GUITAR GHL']) {
			const data = guitarMidi([...greens, sysEx(100, 5, 4, true), sysEx(300, 5, 4, false)], trackName)
			for (const parse of Object.values(parsers)) expect(() => parse(data, 'mid')).toThrow('has difficulty 5')
		}
	})

	it('refuses a Phase Shift SysEx event numbered past Clone Hero\'s 100 SysEx stacks (phrase × 5 + difficulty), on any track', () => {
		const drums = (phrase: number, difficulty: number) => guitarMidi([...note(0, 97), sysEx(0, difficulty, phrase, true)], 'PART DRUMS')
		for (const parse of Object.values(parsers)) {
			expect(() => parse(drums(19, 5), 'mid')).toThrow('has phrase 19 and difficulty 5')
			expect(() => parse(drums(20, 0xff), 'mid')).toThrow('has phrase 20 and difficulty 255')
			expect(() => parse(guitarMidi([...greens, sysEx(100, 200, 4, true)]), 'mid')).toThrow('has phrase 4 and difficulty 200')
			expect(parse(drums(19, 4), 'mid').trackData).toHaveLength(1)
		}
	})

	it('still reads a file where such a SysEx event has no end, or is on a drum track, which Clone Hero loads', () => {
		const unpaired = guitarMidi([...greens, sysEx(100, 5, 4, true)])
		for (const parse of Object.values(parsers)) expect(tapTicks(unpaired, parse)).toEqual([])
		const drums = guitarMidi([...[0, 100].flatMap(tick => note(tick, 97)), sysEx(0, 5, 4, true), sysEx(200, 5, 4, false)], 'PART DRUMS')
		for (const parse of Object.values(parsers)) expect(parse(drums, 'mid').trackData.map(track => track.difficulty)).toContain('expert')
	})
})
