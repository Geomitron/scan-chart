import { writeMidi } from '@geomitron/midi-file'
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

	it('refuses a delta time longer than 4 bytes in every profile, and reads one of 4 bytes', () => {
		// The last green note ends at tick 301, so the next note's delta time is `delta`: 2^28 takes 5 bytes.
		const withDelta = (delta: number) => guitarMidi([...greens, ...note(301 + delta, 96)])
		for (const parse of Object.values(parsers)) {
			expect(() => parse(withDelta(0x10000000), 'mid')).toThrow('a delta time is longer than 4 bytes')
			expect(() => parse(withDelta(0x0fffffff), 'mid')).not.toThrow()
		}
	})

	it('refuses a time signature whose exponent is 8 or more in every profile, and reads one of 7 (R211)', () => {
		/** A guitar chart whose conductor track has a 4/4 time signature at 480 with the exponent `exponent`. */
		const withExponent = (exponent: number) => {
			const data = new Uint8Array(writeMidi({
				header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
				tracks: [
					[{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 }, { deltaTime: 480, type: 'timeSignature', numerator: 4, denominator: 4, metronome: 24, thirtyseconds: 8 }, { deltaTime: 0, type: 'endOfTrack' }],
					[{ deltaTime: 0, type: 'trackName', text: 'PART GUITAR' }, { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 }, { deltaTime: 10, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 }, { deltaTime: 0, type: 'endOfTrack' }],
				],
			}))
			const at = data.findIndex((byte, index) => byte === 0xff && data[index + 1] === 0x58)
			data[at + 4] = exponent
			return data
		}
		for (const parse of Object.values(parsers)) {
			for (const exponent of [8, 31, 32, 40]) {
				expect(() => parse(withExponent(exponent), 'mid'), String(exponent)).toThrow(`Invalid .mid file: the time signature at tick 480 has the exponent ${exponent}, which is 8 or more.`)
			}
			expect(parse(withExponent(7), 'mid').timeSignatures).toEqual([{ tick: 0, numerator: 4, denominator: 4, msTime: 0, msLength: 0 }, { tick: 480, numerator: 4, denominator: 128, msTime: 500, msLength: 0 }])
		}
	})

	it('checks only the time signatures a profile reads: one after the end of track only in the frozen profile (R211, C20: R16)', () => {
		const data = new Uint8Array(writeMidi({
			header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
			tracks: [
				[
					{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 },
					{ deltaTime: 0, type: 'endOfTrack' },
					{ deltaTime: 480, type: 'timeSignature', numerator: 4, denominator: 4, metronome: 24, thirtyseconds: 8 },
				],
				[{ deltaTime: 0, type: 'trackName', text: 'PART GUITAR' }, { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 }, { deltaTime: 10, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 }, { deltaTime: 0, type: 'endOfTrack' }],
			],
		}))
		data[data.findIndex((byte, index) => byte === 0xff && data[index + 1] === 0x58) + 4] = 8
		for (const parse of [parsers.scanner, parsers.canonical]) expect(parse(data, 'mid').timeSignatures).toEqual([{ tick: 0, numerator: 4, denominator: 4, msTime: 0, msLength: 0 }])
		expect(() => parsers.legacy(data, 'mid')).toThrow('Invalid .mid file: the time signature at tick 480 has the exponent 8, which is 8 or more.')
	})

	it('refuses a file cut short inside an event in every profile, and reads one cut between two events up to the cut (Q1 B)', () => {
		const data = guitarMidi(greens)
		// The last track ends with a note-off at 310 and the end of track, 00 FF 2F 00.
		for (const cut of [1, 2, 3, 5, 6]) {
			for (const parse of Object.values(parsers)) expect(() => parse(data.subarray(0, data.length - cut), 'mid'), String(cut)).toThrow('the file ends inside an event')
		}
		for (const parse of Object.values(parsers)) {
			expect(() => parse(data.subarray(0, data.length - 4), 'mid')).not.toThrow()
			expect(tapTicks(data.subarray(0, data.length - 4), parse)).toEqual([])
			// Cut before the last note-off, the note at 300 has no end, and is left out.
			expect(parse(data.subarray(0, data.length - 8), 'mid').trackData[0].noteEventGroups.map(group => group[0].tick)).toEqual([0, 100, 200])
		}
	})

	it('refuses a 5- or 6-fret tap or open SysEx event whose value byte is not 00 or 01, in every profile (R65)', () => {
		const event = (tick: number, phrase: number, value: number, ...rest: number[]): TimedMidiEvent =>
			({ tick, event: { type: 'sysEx', data: new Uint8Array([0x50, 0x53, 0, 0, 3, phrase, value, ...rest]) } as TimedMidiEvent['event'] })
		for (const trackName of ['PART GUITAR', 'PART GUITAR GHL']) {
			const tap = guitarMidi([...greens, event(100, 4, 2, 0xf7)], trackName)
			for (const parse of Object.values(parsers)) expect(() => parse(tap, 'mid')).toThrow("Invalid .mid file: The tap SysEx event at tick 100 has the value 02, which isn't 00 or 01.")
			const open = guitarMidi([...greens, event(100, 1, 0x7f, 0xf7)], trackName)
			for (const parse of Object.values(parsers)) expect(() => parse(open, 'mid')).toThrow('The open SysEx event at tick 100 has the value 7F')
		}
		// Clone Hero reads only an 8-byte event, ignores one in a drums track, and one of another type.
		for (const data of [
			guitarMidi([...greens, event(100, 4, 2)]),
			guitarMidi([...greens, event(100, 4, 2, 0, 0xf7)]),
			guitarMidi([...greens, event(100, 4, 2, 0xf7)], 'PART DRUMS'),
			guitarMidi([...greens, event(100, 3, 2, 0xf7)]),
		]) {
			for (const parse of Object.values(parsers)) expect(() => parse(data, 'mid')).not.toThrow()
		}
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
