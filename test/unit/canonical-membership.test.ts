import { MidiData, writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { canonical20260801, frozenLegacy6142 } from 'src/chart/identity/public'
import { parseChartFile, parseChartFileFrozenLegacyIdentity } from 'src/chart/parse-chart-file'
import { defaultMetadata } from 'src/ini/metadata'

function chart(sections: Record<string, readonly string[]>): Uint8Array {
	const lines: string[] = []
	for (const [name, values] of Object.entries({ Song: ['Resolution = 192'], SyncTrack: ['0 = B 120000'], Events: [], ...sections })) {
		lines.push(`[${name}]`, '{', ...values.map(value => `  ${value}`), '}')
	}
	return new TextEncoder().encode(lines.join('\r\n'))
}

type MidiTrack = MidiData['tracks'][number]

function midiTrack(name: string, notes: readonly { tick: number; noteNumber: number }[]): MidiTrack {
	const timed = notes.flatMap(note => [
		{ tick: note.tick, event: { type: 'noteOn', channel: 0, noteNumber: note.noteNumber, velocity: 100 } as const },
		{ tick: note.tick + 10, event: { type: 'noteOff', channel: 0, noteNumber: note.noteNumber, velocity: 0 } as const },
	]).sort((left, right) => left.tick - right.tick)
	const events: MidiTrack = [{ deltaTime: 0, type: 'trackName', text: name }]
	let previous = 0
	for (const { tick, event } of timed) {
		events.push({ ...event, deltaTime: tick - previous })
		previous = tick
	}
	events.push({ deltaTime: 0, type: 'endOfTrack' })
	return events
}

function midi(tracks: readonly MidiTrack[]): Uint8Array {
	const conductor: MidiTrack = [{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 }, { deltaTime: 0, type: 'endOfTrack' }]
	return new Uint8Array(writeMidi({ header: { format: 1, numTracks: tracks.length + 1, ticksPerBeat: 480 }, tracks: [conductor, ...tracks] }))
}

function canonicalKeys(format: 'chart' | 'mid', bytes: Uint8Array): string[] {
	const parsed = canonical20260801.parseSource({ source: { format, bytes }, modifiers: defaultMetadata })
	if (parsed.kind !== 'accepted') throw new Error(parsed.errors[0].message)
	return parsed.chart.tracks.map(track => `${track.key.instrument}:${track.key.difficulty}`)
}

describe('canonical SongHash membership', () => {
	const noteless = chart({
		ExpertSingle: ['0 = N 0 0'],
		HardSingle: [],
		MediumSingle: ['0 = S 2 192'],
		EasySingle: ['0 = N 5 0', '0 = N 6 0', '0 = E "solo"', '100 = E "soloend"'],
		ExpertDrums: ['0 = N 66 0', '0 = S 64 192'],
		HardDrums: ['0 = N 0 0'],
		EasyDoubleBass: ['100 = E "ld_range_shift 0 1"'],
	})

	it('includes a .chart track only if it has a note after parsing, counting kicks', () => {
		expect(canonicalKeys('chart', noteless).sort()).toEqual(['drums:hard', 'guitar:expert'])
	})

	it('keeps every recognized .chart section in the scanner and the legacy profile', () => {
		const keys = (tracks: readonly { instrument: string; difficulty: string }[]) => tracks.map(track => `${track.instrument}:${track.difficulty}`).sort()
		const expected = ['bass:easy', 'drums:expert', 'drums:hard', 'guitar:easy', 'guitar:expert', 'guitar:hard', 'guitar:medium']
		expect(keys(parseChartFile(noteless, 'chart').trackData)).toEqual(expected)
		expect(keys(parseChartFileFrozenLegacyIdentity(noteless, 'chart').trackData)).toEqual(expected)
		const legacy = frozenLegacy6142.parseSource({ source: { format: 'chart', bytes: noteless }, modifiers: defaultMetadata })
		expect(legacy.kind).toBe('accepted')
	})

	it('excludes MIDI tracks whose difficulties have only markers', () => {
		const bytes = midi([
			midiTrack('PART GUITAR', [{ tick: 0, noteNumber: 96 }]),
			midiTrack('PART BASS', [{ tick: 0, noteNumber: 116 }, { tick: 0, noteNumber: 103 }]),
			midiTrack('PART DRUMS', [{ tick: 0, noteNumber: 110 }, { tick: 480, noteNumber: 72 }]),
		])
		expect(canonicalKeys('mid', bytes)).toEqual(['guitar:expert', 'drums:medium'])
	})
})

describe('MIDI tracks that name the same instrument', () => {
	const firstDrums = midiTrack('PART DRUMS', [{ tick: 0, noteNumber: 97 }])
	const secondDrums = midiTrack('part drum', [{ tick: 1920, noteNumber: 98 }, { tick: 1920, noteNumber: 84 }])

	it('reads only the first track in the canonical profile, including for chart duration', () => {
		const bytes = midi([firstDrums, secondDrums])
		const parsed = canonical20260801.parseSource({ source: { format: 'mid', bytes }, modifiers: defaultMetadata })
		if (parsed.kind !== 'accepted') throw new Error(parsed.errors[0].message)
		expect(parsed.chart.tracks.map(track => `${track.key.instrument}:${track.key.difficulty}`)).toEqual(['drums:expert'])
		expect(parsed.chart.tracks[0].semantics.notes.map(note => note.tick)).toEqual([0n])
		expect(parsed.chart.duration.contentLastTick).toBe(0n)
	})

	it('lets a noteless first track hide a later one, as Clone Hero marks the instrument seen', () => {
		const bytes = midi([midiTrack('PART GUITAR', [{ tick: 0, noteNumber: 116 }]), midiTrack('T1 GEMS', [{ tick: 0, noteNumber: 96 }])])
		expect(canonicalKeys('mid', bytes)).toEqual([])
	})

	it('keeps both tracks in the scanner and hashes the first in the legacy profile', () => {
		const bytes = midi([firstDrums, secondDrums])
		expect(parseChartFile(bytes, 'mid').trackData.map(track => `${track.instrument}:${track.difficulty}`))
			.toEqual(['drums:expert', 'drums:expert', 'drums:hard'])
		const legacy = frozenLegacy6142.parseSource({ source: { format: 'mid', bytes }, modifiers: defaultMetadata })
		const firstOnly = frozenLegacy6142.parseSource({ source: { format: 'mid', bytes: midi([firstDrums]) }, modifiers: defaultMetadata })
		if (legacy.kind !== 'accepted' || firstOnly.kind !== 'accepted') throw new Error('Expected legacy parses')
		const hash = (chart: typeof legacy.chart) =>
			frozenLegacy6142.calculateTrackIdentity({ chart, instrument: 'drums', difficulty: 'expert' }).trackHash.value
		expect(hash(legacy.chart)).toBe(hash(firstOnly.chart))
	})
})
