import { MidiData, writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { canonical20260801 } from 'src/chart/identity/public'
import { parseChartFile } from 'src/chart/parse-chart-file'
import { noteFlags } from 'src/chart/types'
import { defaultMetadata } from 'src/ini/metadata'

function chart(sections: Record<string, readonly string[]>): Uint8Array {
	const lines: string[] = []
	for (const [name, values] of Object.entries(sections)) {
		lines.push(`[${name}]`, '{', ...values.map(value => `  ${value}`), '}')
	}
	return new TextEncoder().encode(`${lines.join('\r\n')}\r\n`)
}

type MidiEvent = MidiData['tracks'][number][number]

function midiTrack(name: string, events: readonly { tick: number; event: MidiEvent }[]): MidiData['tracks'][number] {
	const ordered = events.map((entry, sourceOrder) => ({ ...entry, sourceOrder }))
		.sort((left, right) => left.tick - right.tick || left.sourceOrder - right.sourceOrder)
	const result: MidiData['tracks'][number] = [{ deltaTime: 0, type: 'trackName', text: name }]
	let previousTick = 0
	for (const entry of ordered) {
		result.push({ ...entry.event, deltaTime: entry.tick - previousTick } as MidiEvent)
		previousTick = entry.tick
	}
	result.push({ deltaTime: 0, type: 'endOfTrack' })
	return result
}

function midiSource(): Uint8Array {
	const conductor: MidiData['tracks'][number] = [
		{ deltaTime: 0, type: 'trackName', text: '' },
		{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500001 },
		{ deltaTime: 0, type: 'timeSignature', numerator: 4, denominator: 4, metronome: 24, thirtyseconds: 8 },
		{ deltaTime: 0, type: 'endOfTrack' },
	]
	const events = midiTrack('EVENTS', [])
	const guitarEvents: { tick: number; event: MidiEvent }[] = [
		{ tick: 100, event: { deltaTime: 0, type: 'sysEx', data: [0x50, 0x53, 0, 0, 3, 4, 1, 0xf7] } },
		{ tick: 200, event: { deltaTime: 0, type: 'sysEx', data: [0x50, 0x53, 0, 0, 3, 4, 0, 0xf7] } },
		{ tick: 100, event: { deltaTime: 0, type: 'text', text: '[ld_range_shift 3 1 5]' } },
		{ tick: 100, event: { deltaTime: 0, type: 'text', text: '[ld_range_shift 3 3 3]' } },
		{ tick: 300, event: { deltaTime: 0, type: 'text', text: '[ld_range_shift 3 3 3]' } },
		{ tick: 350, event: { deltaTime: 0, type: 'text', text: '[ld_range_shift 3 3 0]' } },
	]
	for (const tick of [0, 100, 150, 200, 250]) {
		guitarEvents.push(
			{ tick, event: { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 } },
			{ tick: tick + 1, event: { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 } },
		)
	}
	const guitar = midiTrack('PART GUITAR', guitarEvents)
	return new Uint8Array(writeMidi({
		header: { format: 1, numTracks: 3, ticksPerBeat: 480 },
		tracks: [conductor, events, guitar],
	}))
}

function containsBytes(haystack: Uint8Array, needle: readonly number[]): boolean {
	return haystack.some((_, start) => needle.every((value, index) => haystack[start + index] === value))
}

describe('canonical source identity', () => {
	it('parses .chart range shifts, defaults, precedence, and exact tempo bytes', () => {
		const source = chart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120001', '0 = TS 4'],
			Events: [],
			EasySingle: ['0 = N 0 0', '100 = E "ld_range_shift 0 1"'],
			MediumSingle: ['0 = N 0 0', '100 = E "ld_range_shift 1 2"'],
			HardSingle: ['0 = N 0 0', '100 = E "ld_range_shift 2 1"'],
			ExpertSingle: [
				'0 = N 0 0',
				'100 = E "ld_range_shift 3 1 5"',
				'100 = E "ld_range_shift 3 3 3"',
				'200 = E "ld_range_shift 3 3 3"',
				'250 = E "ld_range_shift 3 3 0"',
				'300 = E "ld_range_shift 2 1 3"',
			],
			ExpertDrums: ['0 = N 1 0', '100 = E "ld_range_shift 3 1 5"'],
		})
		const parsed = canonical20260801.parseSource({
			source: { format: 'chart', bytes: source },
			modifiers: defaultMetadata,
		})

		expect(parsed.kind).toBe('accepted')
		if (parsed.kind !== 'accepted') return
		const ranges = Object.fromEntries(parsed.chart.tracks
			.filter(track => track.key.instrument === 'guitar')
			.map(track => [track.key.difficulty, track.semantics.rangeShifts]))
		expect(ranges).toEqual({
			expert: [
				{ tick: 100n, position: 3, size: 3 },
				{ tick: 200n, position: 3, size: 3 },
			],
			hard: [{ tick: 100n, position: 1, size: 5 }],
			medium: [{ tick: 100n, position: 2, size: 4 }],
			easy: [{ tick: 100n, position: 1, size: 3 }],
		})
		expect(parsed.notices.map(notice => notice.code)).toEqual([
			'rangeShiftOutOfBounds',
			'rangeShiftDifficultyMismatch',
			'rangeShiftInstrumentInapplicable',
		])

		const expert = parsed.chart.tracks.find(track => track.key.instrument === 'guitar' && track.key.difficulty === 'expert')!
		const identity = canonical20260801.calculateTrackIdentity(expert)
		expect(containsBytes(identity.projection.bytes, [0xf2, 0xd2, 0x4d, 0x62, 0x10, 0x00, 0x5e, 0x40])).toBe(true)
	})

	it('keeps a MIDI tap active at its end and routes MIDI range shifts', () => {
		const source = midiSource()
		const legacy = parseChartFile(source, 'mid')
		const parsed = canonical20260801.parseSource({
			source: { format: 'mid', bytes: source },
			modifiers: defaultMetadata,
		})

		expect(parsed.kind).toBe('accepted')
		if (parsed.kind !== 'accepted') return
		const canonical = parsed.chart.tracks.find(track => track.key.instrument === 'guitar' && track.key.difficulty === 'expert')!
		const canonicalFlags = Object.fromEntries(canonical.semantics.notes.map(note => [Number(note.tick), note.flags]))
		const legacyTrack = legacy.trackData.find(track => track.instrument === 'guitar' && track.difficulty === 'expert')!
		const legacyFlags = Object.fromEntries(legacyTrack.noteEventGroups.flat().map(note => [note.tick, note.flags]))

		expect(canonicalFlags[100] & noteFlags.tap).toBe(noteFlags.tap)
		expect(canonicalFlags[150] & noteFlags.tap).toBe(noteFlags.tap)
		expect(canonicalFlags[200] & noteFlags.tap).toBe(noteFlags.tap)
		expect(canonicalFlags[250] & noteFlags.tap).toBe(0)
		expect(legacyFlags[200] & noteFlags.tap).toBe(0)
		expect(canonical.semantics.rangeShifts).toEqual([
			{ tick: 100n, position: 3, size: 3 },
			{ tick: 300n, position: 3, size: 3 },
		])
		expect(parsed.notices.map(notice => notice.code)).toEqual(['rangeShiftOutOfBounds'])

		const identity = canonical20260801.calculateTrackIdentity(canonical)
		expect(containsBytes(identity.projection.bytes, [0x46, 0x7a, 0x5e, 0x11, 0xfc, 0xff, 0x5d, 0x40])).toBe(true)
	})

	it('uses exclusive star-power and solo ends and inclusive flex and freestyle ends', () => {
		const source = chart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
			ExpertDrums: [
				'0 = S 2 100', '100 = N 1 0',
				'200 = S 2 100', '299 = N 1 0',
				'400 = E "solo"', '500 = E "soloend"', '501 = N 1 0',
				'600 = E "solo"', '700 = E "soloend"', '700 = N 1 0',
				'800 = S 65 100', '900 = N 1 0',
				'1000 = S 66 100', '1101 = N 1 0',
				'1200 = S 64 100', '1300 = N 1 0',
				'1400 = S 64 100', '1501 = N 1 0',
			],
		})
		const parsed = canonical20260801.parseSource({
			source: { format: 'chart', bytes: source },
			modifiers: defaultMetadata,
		})

		expect(parsed.kind).toBe('accepted')
		if (parsed.kind !== 'accepted') return
		const track = parsed.chart.tracks.find(candidate =>
			candidate.key.instrument === 'drums' && candidate.key.difficulty === 'expert')!
		expect(track.semantics.starPower).toEqual([{ tick: 200n, length: 100n }])
		expect(track.semantics.solos).toEqual([{ tick: 600n, length: 101n }])
		expect(track.semantics.flexLanes).toEqual([{ tick: 800n, length: 100n, isDouble: false }])
		expect(track.semantics.drumFreestyle).toEqual([{ tick: 1200n, length: 100n, isCoda: false }])
	})

	it('retains range-shift source events for downstream round-trip writers', () => {
		const chartText = 'ld_range_shift 3 2 4'
		const parsedChart = parseChartFile(chart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000'],
			Events: [],
			ExpertSingle: ['0 = N 0 0', `100 = E "${chartText}"`],
		}), 'chart')
		const chartTrack = parsedChart.trackData.find(track => track.instrument === 'guitar' && track.difficulty === 'expert')!
		expect(chartTrack.textEvents.some(event => event.text === chartText)).toBe(true)

		const parsedMidi = parseChartFile(midiSource(), 'mid')
		const midiTrack = parsedMidi.trackData.find(track => track.instrument === 'guitar' && track.difficulty === 'expert')!
		expect(midiTrack.textEvents.some(event => event.text === '[ld_range_shift 3 1 5]')).toBe(true)
	})
})
