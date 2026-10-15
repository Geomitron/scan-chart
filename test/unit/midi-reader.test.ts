import { MidiData, writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { parseChartFile, parseChartFileCanonicalIdentity, parseChartFileFrozenLegacyIdentity } from 'src/chart/parse-chart-file'
import { noteFlags } from 'src/chart/types'

type MidiEvent = MidiData['tracks'][number][number]

/** A `.mid` file at 480 ticks per beat: a tempo track with `tempo` microseconds per beat, and a PART GUITAR track. */
function guitarMidi(events: readonly { tick: number; event: MidiEvent }[], tempos: readonly { tick: number; microsecondsPerBeat: number }[] = [{ tick: 0, microsecondsPerBeat: 500000 }]): Uint8Array {
	const track = (name: string, entries: readonly { tick: number; event: MidiEvent }[]) => {
		const ordered = entries.map((entry, order) => ({ ...entry, order })).sort((a, b) => a.tick - b.tick || a.order - b.order)
		let previousTick = 0
		const result: MidiEvent[] = [{ deltaTime: 0, type: 'trackName', text: name }]
		for (const { tick, event } of ordered) {
			result.push({ ...event, deltaTime: tick - previousTick } as MidiEvent)
			previousTick = tick
		}
		result.push({ deltaTime: 0, type: 'endOfTrack' })
		return result
	}
	const conductor = track('TEMPO TRACK', tempos.map(({ tick, microsecondsPerBeat }) => ({ tick, event: { deltaTime: 0, type: 'setTempo', microsecondsPerBeat } })))
	return new Uint8Array(writeMidi({ header: { format: 1, numTracks: 2, ticksPerBeat: 480 }, tracks: [conductor, track('PART GUITAR', events)] }))
}

const note = (tick: number, noteNumber: number, channel = 0) => [
	{ tick, event: { deltaTime: 0, type: 'noteOn', channel, noteNumber, velocity: 100 } as MidiEvent },
	{ tick: tick + 1, event: { deltaTime: 0, type: 'noteOff', channel, noteNumber, velocity: 0 } as MidiEvent },
]
const sysEx = (tick: number, difficulty: number, phrase: number, isStart: boolean) =>
	({ tick, event: { deltaTime: 0, type: 'sysEx', data: [0x50, 0x53, 0, 0, difficulty, phrase, isStart ? 1 : 0, 0xf7] } as MidiEvent })
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
