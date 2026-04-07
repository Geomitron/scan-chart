/**
 * Tests for vocalTracks parsing in midi-parser and chart-parser.
 * Covers: PART VOCALS, HARM1/2/3, CopyDownPhrases behavior, track name variants.
 */

import { describe, it, expect } from 'vitest'
import { writeMidi, MidiData } from 'midi-file'
import { parseNotesFromMidi } from '../chart/midi-parser'
import { parseNotesFromChart } from '../chart/chart-parser'
import { defaultIniChartModifiers } from '../chart/note-parsing-interfaces'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMidi(ticksPerBeat: number, tracks: MidiData['tracks']): Uint8Array {
	const data: MidiData = {
		header: { format: 1, numTracks: tracks.length, ticksPerBeat },
		tracks,
	}
	return new Uint8Array(writeMidi(data))
}

function tempoTrack(): MidiData['tracks'][number] {
	return [
		{ deltaTime: 0, type: 'trackName', text: '' },
		{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 },
		{ deltaTime: 0, type: 'timeSignature', numerator: 4, denominator: 4, metronome: 24, thirtyseconds: 8 },
		{ deltaTime: 0, type: 'endOfTrack' },
	]
}

function eventsTrack(): MidiData['tracks'][number] {
	return [
		{ deltaTime: 0, type: 'trackName', text: 'EVENTS' },
		{ deltaTime: 0, type: 'endOfTrack' },
	]
}

type TimedEvent = { absTick: number; event: MidiData['tracks'][number][number] }

/** Build a vocal-type track (PART VOCALS, HARM1, etc.) with lyrics and phrases. */
function vocalTrack(name: string, opts: {
	notes?: { tick: number; pitch: number; length: number }[]
	lyrics?: { tick: number; text: string }[]
	phrases105?: { tick: number; length: number }[]
	phrases106?: { tick: number; length: number }[]
}): MidiData['tracks'][number] {
	const track: MidiData['tracks'][number] = [
		{ deltaTime: 0, type: 'trackName', text: name },
	]

	const timedEvents: TimedEvent[] = []

	for (const n of opts.notes ?? []) {
		timedEvents.push({
			absTick: n.tick,
			event: { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: n.pitch, velocity: 100 },
		})
		timedEvents.push({
			absTick: n.tick + n.length,
			event: { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: n.pitch, velocity: 0 },
		})
	}

	for (const l of opts.lyrics ?? []) {
		timedEvents.push({
			absTick: l.tick,
			event: { deltaTime: 0, type: 'lyrics', text: l.text },
		})
	}

	for (const p of opts.phrases105 ?? []) {
		timedEvents.push({
			absTick: p.tick,
			event: { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 105, velocity: 100 },
		})
		timedEvents.push({
			absTick: p.tick + p.length,
			event: { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 105, velocity: 0 },
		})
	}

	for (const p of opts.phrases106 ?? []) {
		timedEvents.push({
			absTick: p.tick,
			event: { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 106, velocity: 100 },
		})
		timedEvents.push({
			absTick: p.tick + p.length,
			event: { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 106, velocity: 0 },
		})
	}

	timedEvents.sort((a, b) => a.absTick - b.absTick)
	let prevTick = 0
	for (const te of timedEvents) {
		te.event.deltaTime = te.absTick - prevTick
		prevTick = te.absTick
		track.push(te.event)
	}

	track.push({ deltaTime: 0, type: 'endOfTrack' })
	return track
}

function buildChart(sections: Record<string, string[]>): Uint8Array {
	const lines: string[] = []
	for (const [name, content] of Object.entries(sections)) {
		lines.push(`[${name}]`)
		lines.push('{')
		for (const line of content) {
			lines.push(`  ${line}`)
		}
		lines.push('}')
	}
	return new TextEncoder().encode(lines.join('\r\n'))
}

// ---------------------------------------------------------------------------
// vocalTracks structure
// ---------------------------------------------------------------------------

describe('vocalTracks: PART VOCALS', () => {
	it('populates vocals entry with lyrics and phrases', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				lyrics: [
					{ tick: 480, text: 'Hel+' },
					{ tick: 960, text: 'lo' },
				],
				notes: [{ tick: 480, pitch: 60, length: 240 }],
				phrases105: [{ tick: 480, length: 720 }],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.vocalTracks.vocals).toBeDefined()
		expect(result.vocalTracks.vocals.lyrics).toHaveLength(2)
		expect(result.vocalTracks.vocals.lyrics[0]).toMatchObject({ tick: 480, text: 'Hel+' })
		expect(result.vocalTracks.vocals.vocalPhrases).toHaveLength(1)
		expect(result.vocalTracks.vocals.vocalPhrases[0]).toMatchObject({ tick: 480, length: 720 })
	})

	it('no vocal tracks when no PART VOCALS', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.vocalTracks.vocals).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// Harmony tracks
// ---------------------------------------------------------------------------

describe('vocalTracks: harmonies', () => {
	it('populates harmony1/2/3 from HARM1/HARM2/HARM3 tracks', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				lyrics: [{ tick: 480, text: 'main' }],
				notes: [{ tick: 480, pitch: 60, length: 240 }],
				phrases105: [{ tick: 480, length: 480 }],
			}),
			vocalTrack('HARM1', {
				lyrics: [{ tick: 480, text: 'harm1' }],
				notes: [{ tick: 480, pitch: 62, length: 240 }],
				phrases105: [{ tick: 480, length: 480 }],
			}),
			vocalTrack('HARM2', {
				lyrics: [{ tick: 480, text: 'harm2' }],
				notes: [{ tick: 480, pitch: 64, length: 240 }],
				// HARM2 has no phrase 105 — gets copied from HARM1
			}),
			vocalTrack('HARM3', {
				lyrics: [{ tick: 480, text: 'harm3' }],
				notes: [{ tick: 480, pitch: 65, length: 240 }],
				// HARM3 has no phrase 105 — gets copied from HARM1
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)

		// All four parts present
		expect(result.vocalTracks.vocals).toBeDefined()
		expect(result.vocalTracks.harmony1).toBeDefined()
		expect(result.vocalTracks.harmony2).toBeDefined()
		expect(result.vocalTracks.harmony3).toBeDefined()

		// Each has its own lyrics
		expect(result.vocalTracks.vocals.lyrics[0].text).toBe('main')
		expect(result.vocalTracks.harmony1.lyrics[0].text).toBe('harm1')
		expect(result.vocalTracks.harmony2.lyrics[0].text).toBe('harm2')
		expect(result.vocalTracks.harmony3.lyrics[0].text).toBe('harm3')

		// Each has vocal notes
		// Each has vocal notes (pitch 36-84)
		expect(result.vocalTracks.harmony1.lyrics).toHaveLength(1)
		expect(result.vocalTracks.harmony2.lyrics).toHaveLength(1)
		expect(result.vocalTracks.harmony3.lyrics).toHaveLength(1)
	})

	it('accepts PART HARM1/2/3 track name variants', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART HARM1', {
				lyrics: [{ tick: 480, text: 'h1' }],
				notes: [{ tick: 480, pitch: 60, length: 240 }],
				phrases105: [{ tick: 480, length: 480 }],
			}),
			vocalTrack('PART HARM2', {
				lyrics: [{ tick: 480, text: 'h2' }],
				notes: [{ tick: 480, pitch: 62, length: 240 }],
			}),
			vocalTrack('PART HARM3', {
				lyrics: [{ tick: 480, text: 'h3' }],
				notes: [{ tick: 480, pitch: 64, length: 240 }],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.vocalTracks.harmony1).toBeDefined()
		expect(result.vocalTracks.harmony2).toBeDefined()
		expect(result.vocalTracks.harmony3).toBeDefined()
		expect(result.vocalTracks.harmony1.lyrics[0].text).toBe('h1')
	})

	it('harmony without PART VOCALS is allowed', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('HARM1', {
				lyrics: [{ tick: 480, text: 'solo harmony' }],
				notes: [{ tick: 480, pitch: 60, length: 240 }],
				phrases105: [{ tick: 480, length: 480 }],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.vocalTracks.vocals).toBeUndefined()
		expect(result.vocalTracks.harmony1).toBeDefined()
		expect(result.vocalTracks.harmony1.lyrics[0].text).toBe('solo harmony')
	})
})

// ---------------------------------------------------------------------------
// CopyDownPhrases: HARM2/3 scoring phrases come from HARM1
// ---------------------------------------------------------------------------

describe('vocalTracks: CopyDownPhrases', () => {
	it('HARM2 gets scoring phrases from HARM1', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('HARM1', {
				notes: [{ tick: 480, pitch: 60, length: 240 }],
				phrases105: [
					{ tick: 480, length: 480 },
					{ tick: 1920, length: 480 },
				],
			}),
			vocalTrack('HARM2', {
				notes: [{ tick: 480, pitch: 62, length: 240 }],
				// HARM2 has its own single phrase in the MIDI, but it gets replaced
				phrases105: [{ tick: 480, length: 240 }],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		// HARM2 should have HARM1's phrases, not its own
		expect(result.vocalTracks.harmony2.vocalPhrases).toHaveLength(2)
		expect(result.vocalTracks.harmony2.vocalPhrases[0]).toMatchObject({ tick: 480, length: 480 })
		expect(result.vocalTracks.harmony2.vocalPhrases[1]).toMatchObject({ tick: 1920, length: 480 })
	})

	it('HARM3 gets scoring phrases from HARM1', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('HARM1', {
				notes: [{ tick: 480, pitch: 60, length: 240 }],
				phrases105: [
					{ tick: 480, length: 480 },
					{ tick: 1920, length: 960 },
				],
			}),
			vocalTrack('HARM3', {
				notes: [{ tick: 480, pitch: 64, length: 240 }],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.vocalTracks.harmony3.vocalPhrases).toHaveLength(2)
		expect(result.vocalTracks.harmony3.vocalPhrases[0]).toMatchObject({ tick: 480, length: 480 })
		expect(result.vocalTracks.harmony3.vocalPhrases[1]).toMatchObject({ tick: 1920, length: 960 })
	})

	it('HARM1 keeps its own phrases (not affected by CopyDown)', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('HARM1', {
				notes: [{ tick: 480, pitch: 60, length: 240 }],
				phrases105: [{ tick: 480, length: 480 }],
			}),
			vocalTrack('HARM2', {
				notes: [{ tick: 480, pitch: 62, length: 240 }],
				phrases105: [
					{ tick: 480, length: 240 },
					{ tick: 960, length: 240 },
					{ tick: 1440, length: 240 },
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		// HARM1 should still have its own single phrase
		expect(result.vocalTracks.harmony1.vocalPhrases).toHaveLength(1)
		expect(result.vocalTracks.harmony1.vocalPhrases[0]).toMatchObject({ tick: 480, length: 480 })
	})

	it('HARM2/3 without HARM1 keep their own phrases', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('HARM2', {
				notes: [{ tick: 480, pitch: 62, length: 240 }],
				phrases105: [{ tick: 480, length: 240 }],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		// No HARM1 to copy from, so HARM2 keeps its own
		expect(result.vocalTracks.harmony2.vocalPhrases).toHaveLength(1)
		expect(result.vocalTracks.harmony2.vocalPhrases[0]).toMatchObject({ tick: 480, length: 240 })
	})

	it('CopyDown creates independent copies (not shared references)', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('HARM1', {
				notes: [{ tick: 480, pitch: 60, length: 240 }],
				phrases105: [{ tick: 480, length: 480 }],
			}),
			vocalTrack('HARM2', {
				notes: [{ tick: 480, pitch: 62, length: 240 }],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		// Verify they're independent objects
		expect(result.vocalTracks.harmony1.vocalPhrases[0]).not.toBe(result.vocalTracks.harmony2.vocalPhrases[0])
		expect(result.vocalTracks.harmony2.vocalPhrases[0]).toEqual(result.vocalTracks.harmony1.vocalPhrases[0])
	})
})

// ---------------------------------------------------------------------------
// .chart vocalTracks
// ---------------------------------------------------------------------------

describe('vocalTracks: .chart format', () => {
	it('puts lyrics and phrases in vocals entry', () => {
		const chart = buildChart({
			Song: ['Resolution = 480'],
			SyncTrack: ['0 = B 120000'],
			Events: [
				'480 = E "phrase_start"',
				'480 = E "lyric Hello"',
				'1440 = E "phrase_end"',
			],
		})

		const result = parseNotesFromChart(chart)
		expect(result.vocalTracks.vocals).toBeDefined()
		expect(result.vocalTracks.vocals.lyrics).toHaveLength(1)
		expect(result.vocalTracks.vocals.lyrics[0].text).toBe('Hello')
		expect(result.vocalTracks.vocals.vocalPhrases).toHaveLength(1)
	})

	it('no harmonies in .chart format', () => {
		const chart = buildChart({
			Song: ['Resolution = 480'],
			SyncTrack: ['0 = B 120000'],
			Events: ['480 = E "lyric Hello"'],
		})

		const result = parseNotesFromChart(chart)
		expect(result.vocalTracks.harmony1).toBeUndefined()
		expect(result.vocalTracks.harmony2).toBeUndefined()
		expect(result.vocalTracks.harmony3).toBeUndefined()
	})
})
