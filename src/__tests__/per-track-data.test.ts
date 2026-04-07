/**
 * Tests for per-track data fields: textEvents, versusPhrases, animations.
 * Covers both MIDI and .chart format parsing.
 */

import { describe, it, expect } from 'vitest'
import { writeMidi, MidiData } from 'midi-file'
import { parseNotesFromMidi } from '../chart/midi-parser'
import { parseNotesFromChart } from '../chart/chart-parser'
import { parseChartFile } from '../chart/notes-parser'
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

/**
 * Build an instrument track with notes and optional text events, versus phrases, and animations.
 */
function instrumentTrack(name: string, opts: {
	notes?: { tick: number; noteNumber: number; length: number; velocity?: number }[]
	textEvents?: { tick: number; text: string }[]
}): MidiData['tracks'][number] {
	const track: MidiData['tracks'][number] = [
		{ deltaTime: 0, type: 'trackName', text: name },
	]

	const timedEvents: TimedEvent[] = []

	for (const n of opts.notes ?? []) {
		timedEvents.push({
			absTick: n.tick,
			event: { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: n.noteNumber, velocity: n.velocity ?? 100 },
		})
		timedEvents.push({
			absTick: n.tick + n.length,
			event: { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: n.noteNumber, velocity: 0 },
		})
	}

	for (const t of opts.textEvents ?? []) {
		timedEvents.push({
			absTick: t.tick,
			event: { deltaTime: 0, type: 'text', text: t.text },
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

/** Helper to get trackData for a specific instrument+difficulty. */
function getTrack(result: { trackData: { instrument: string; difficulty: string }[] }, instrument: string, difficulty = 'expert') {
	return result.trackData.find(t => t.instrument === instrument && t.difficulty === difficulty)
}

// ---------------------------------------------------------------------------
// MIDI: Text Events
// ---------------------------------------------------------------------------

describe('MIDI: per-track text events', () => {
	it('captures general text events on instrument tracks', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART GUITAR', {
				notes: [{ tick: 480, noteNumber: 96, length: 120 }], // expert green
				textEvents: [
					{ tick: 0, text: '[idle]' },
					{ tick: 480, text: '[play]' },
					{ tick: 960, text: 'map HandMap_Default' },
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'guitar')!
		expect(track).toBeDefined()
		expect(track.textEvents).toEqual([
			{ tick: 0, text: '[idle]' },
			{ tick: 480, text: '[play]' },
			{ tick: 960, text: 'map HandMap_Default' },
		])
	})

	it('excludes ENHANCED_OPENS and ENABLE_CHART_DYNAMICS from textEvents', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART GUITAR', {
				notes: [{ tick: 480, noteNumber: 96, length: 120 }],
				textEvents: [
					{ tick: 0, text: 'ENHANCED_OPENS' },
					{ tick: 0, text: '[ENHANCED_OPENS]' },
					{ tick: 0, text: 'ENABLE_CHART_DYNAMICS' },
					{ tick: 0, text: '[ENABLE_CHART_DYNAMICS]' },
					{ tick: 480, text: '[play]' },
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'guitar')!
		expect(track.textEvents).toEqual([
			{ tick: 480, text: '[play]' },
		])
	})

	it('excludes disco flip mix events from textEvents on drum tracks', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART DRUMS', {
				notes: [{ tick: 480, noteNumber: 97, length: 120 }], // expert red
				textEvents: [
					{ tick: 0, text: '[mix 0 drums0]' },
					{ tick: 480, text: '[mix 1 drums2d]' },
					{ tick: 960, text: '[idle]' },
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'drums')!
		expect(track.textEvents).toEqual([
			{ tick: 960, text: '[idle]' },
		])
	})

	it('shares text events across all difficulties', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART GUITAR', {
				notes: [
					{ tick: 480, noteNumber: 96, length: 120 }, // expert green
					{ tick: 480, noteNumber: 84, length: 120 }, // hard green
				],
				textEvents: [{ tick: 0, text: '[play]' }],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const expert = getTrack(result, 'guitar', 'expert')!
		const hard = getTrack(result, 'guitar', 'hard')!
		expect(expert.textEvents).toEqual([{ tick: 0, text: '[play]' }])
		expect(hard.textEvents).toEqual([{ tick: 0, text: '[play]' }])
	})
})

// ---------------------------------------------------------------------------
// MIDI: Versus Phrases
// ---------------------------------------------------------------------------

describe('MIDI: versus phrases', () => {
	it('extracts player 1 and player 2 versus phrases from notes 105/106', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART GUITAR', {
				notes: [
					{ tick: 480, noteNumber: 96, length: 120 },     // expert green
					{ tick: 480, noteNumber: 105, length: 960 },    // player 1 versus phrase
					{ tick: 1920, noteNumber: 106, length: 480 },   // player 2 versus phrase
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'guitar')!
		expect(track.versusPhrases).toEqual([
			{ tick: 480, length: 960, isPlayer2: false },
			{ tick: 1920, length: 480, isPlayer2: true },
		])
	})

	it('handles overlapping player 1 and player 2 phrases', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART GUITAR', {
				notes: [
					{ tick: 480, noteNumber: 96, length: 120 },
					{ tick: 480, noteNumber: 105, length: 960 },
					{ tick: 480, noteNumber: 106, length: 960 },
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'guitar')!
		expect(track.versusPhrases).toHaveLength(2)
		expect(track.versusPhrases[0]).toEqual({ tick: 480, length: 960, isPlayer2: false })
		expect(track.versusPhrases[1]).toEqual({ tick: 480, length: 960, isPlayer2: true })
	})

	it('shares versus phrases across all difficulties', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART GUITAR', {
				notes: [
					{ tick: 480, noteNumber: 96, length: 120 },  // expert
					{ tick: 480, noteNumber: 84, length: 120 },  // hard
					{ tick: 480, noteNumber: 105, length: 960 }, // versus p1
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const expert = getTrack(result, 'guitar', 'expert')!
		const hard = getTrack(result, 'guitar', 'hard')!
		expect(expert.versusPhrases).toEqual([{ tick: 480, length: 960, isPlayer2: false }])
		expect(hard.versusPhrases).toEqual([{ tick: 480, length: 960, isPlayer2: false }])
	})
})

// ---------------------------------------------------------------------------
// MIDI: Animations
// ---------------------------------------------------------------------------

describe('MIDI: animation notes', () => {
	it('extracts guitar left hand positions (notes 40-59)', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART GUITAR', {
				notes: [
					{ tick: 480, noteNumber: 96, length: 120 },  // expert green
					{ tick: 480, noteNumber: 40, length: 240 },  // left hand position 1
					{ tick: 960, noteNumber: 52, length: 120 },  // left hand position 13
					{ tick: 1440, noteNumber: 59, length: 120 }, // left hand position 20
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'guitar')!
		expect(track.animations).toEqual([
			{ tick: 480, length: 240, noteNumber: 40 },
			{ tick: 960, length: 120, noteNumber: 52 },
			{ tick: 1440, length: 120, noteNumber: 59 },
		])
	})

	it('extracts drum pad animations (notes 24-51)', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART DRUMS', {
				notes: [
					{ tick: 480, noteNumber: 97, length: 120 },  // expert red
					{ tick: 480, noteNumber: 24, length: 120 },  // kick right foot
					{ tick: 960, noteNumber: 27, length: 120 },  // snare right hand hard
					{ tick: 1440, noteNumber: 51, length: 120 }, // floor tom right hand
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'drums')!
		expect(track.animations).toEqual([
			{ tick: 480, length: 120, noteNumber: 24 },
			{ tick: 960, length: 120, noteNumber: 27 },
			{ tick: 1440, length: 120, noteNumber: 51 },
		])
	})

	it('does not mix guitar animation range with drum animation range', () => {
		// Guitar tracks should capture 40-59, NOT 24-39
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART GUITAR', {
				notes: [
					{ tick: 480, noteNumber: 96, length: 120 },
					{ tick: 480, noteNumber: 30, length: 120 }, // drum range, should be ignored on guitar
					{ tick: 480, noteNumber: 45, length: 120 }, // guitar range
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'guitar')!
		expect(track.animations).toEqual([
			{ tick: 480, length: 120, noteNumber: 45 },
		])
	})

	it('does not capture guitar animation range on drum tracks', () => {
		// Drum tracks should capture 24-51, notes 52-59 should be ignored
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART DRUMS', {
				notes: [
					{ tick: 480, noteNumber: 97, length: 120 },
					{ tick: 480, noteNumber: 55, length: 120 }, // guitar range only
					{ tick: 480, noteNumber: 45, length: 120 }, // within drum range (tom 1 left hand)
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'drums')!
		expect(track.animations).toEqual([
			{ tick: 480, length: 120, noteNumber: 45 },
		])
	})

	it('extracts bass left hand positions same as guitar', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART BASS', {
				notes: [
					{ tick: 480, noteNumber: 96, length: 120 },
					{ tick: 480, noteNumber: 42, length: 240 },
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'bass')!
		expect(track.animations).toEqual([
			{ tick: 480, length: 240, noteNumber: 42 },
		])
	})
})

// ---------------------------------------------------------------------------
// .chart: Text Events
// ---------------------------------------------------------------------------

describe('.chart: per-track text events', () => {
	it('captures E events that are not solo/soloend/disco flip', () => {
		const chart = buildChart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
			ExpertSingle: [
				'0 = N 0 0',
				'0 = E [idle]',
				'192 = E [play]',
				'384 = E map HandMap_Default',
			],
		})

		const result = parseNotesFromChart(chart)
		const track = getTrack(result, 'guitar')!
		expect(track.textEvents).toEqual([
			{ tick: 0, text: '[idle]' },
			{ tick: 192, text: '[play]' },
			{ tick: 384, text: 'map HandMap_Default' },
		])
	})

	it('excludes solo and soloend from textEvents', () => {
		const chart = buildChart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
			ExpertSingle: [
				'0 = N 0 0',
				'0 = E solo',
				'192 = E [play]',
				'384 = E soloend',
			],
		})

		const result = parseNotesFromChart(chart)
		const track = getTrack(result, 'guitar')!
		expect(track.textEvents).toEqual([
			{ tick: 192, text: '[play]' },
		])
	})

	it('excludes disco flip mix events from textEvents', () => {
		const chart = buildChart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
			ExpertDrums: [
				'0 = N 0 0',
				'0 = E [mix 0 drums0]',
				'192 = E [mix 1 drums2d]',
				'384 = E [idle]',
			],
		})

		const result = parseNotesFromChart(chart)
		const track = getTrack(result, 'drums')!
		expect(track.textEvents).toEqual([
			{ tick: 384, text: '[idle]' },
		])
	})
})

// ---------------------------------------------------------------------------
// .chart: Versus Phrases
// ---------------------------------------------------------------------------

describe('.chart: versus phrases', () => {
	it('extracts S 0 and S 1 as versus phrases', () => {
		const chart = buildChart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
			ExpertSingle: [
				'0 = N 0 0',
				'0 = S 0 384',
				'768 = S 1 192',
			],
		})

		const result = parseNotesFromChart(chart)
		const track = getTrack(result, 'guitar')!
		expect(track.versusPhrases).toEqual([
			{ tick: 0, length: 384, isPlayer2: false },
			{ tick: 768, length: 192, isPlayer2: true },
		])
	})

	it('does not mix versus phrases with star power (S 2)', () => {
		const chart = buildChart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
			ExpertSingle: [
				'0 = N 0 0',
				'0 = S 0 384',
				'0 = S 2 384',
				'768 = S 1 192',
			],
		})

		const result = parseNotesFromChart(chart)
		const track = getTrack(result, 'guitar')!
		expect(track.versusPhrases).toEqual([
			{ tick: 0, length: 384, isPlayer2: false },
			{ tick: 768, length: 192, isPlayer2: true },
		])
		expect(track.starPowerSections).toHaveLength(1)
	})
})

// ---------------------------------------------------------------------------
// .chart: Animations (always empty)
// ---------------------------------------------------------------------------

describe('.chart: animations', () => {
	it('returns empty animations array (.chart has no note-based animations)', () => {
		const chart = buildChart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
			ExpertSingle: ['0 = N 0 0'],
		})

		const result = parseNotesFromChart(chart)
		const track = getTrack(result, 'guitar')!
		expect(track.animations).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// MIDI: additional text event filters
// ---------------------------------------------------------------------------

describe('MIDI: text event edge cases', () => {
	it('filters tick-0 text events that duplicate the track name', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART GUITAR', {
				notes: [{ tick: 480, noteNumber: 96, length: 120 }],
				textEvents: [
					{ tick: 0, text: 'PART GUITAR' },
					{ tick: 480, text: '[play]' },
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'guitar')!
		expect(track.textEvents).toEqual([
			{ tick: 480, text: '[play]' },
		])
	})

	it('keeps track-name text at non-zero tick', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART DRUMS', {
				notes: [{ tick: 480, noteNumber: 97, length: 120 }],
				textEvents: [
					{ tick: 480, text: 'PART DRUMS' },
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'drums')!
		expect(track.textEvents).toEqual([
			{ tick: 480, text: 'PART DRUMS' },
		])
	})

	it('does not filter disco flip on non-drum instrument tracks', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART GUITAR', {
				notes: [{ tick: 480, noteNumber: 96, length: 120 }],
				textEvents: [
					{ tick: 0, text: '[mix 0 drums0]' },
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'guitar')!
		expect(track.textEvents).toEqual([
			{ tick: 0, text: '[mix 0 drums0]' },
		])
	})
})

// ---------------------------------------------------------------------------
// .chart: additional text event filters
// ---------------------------------------------------------------------------

describe('.chart: text event edge cases', () => {
	it('excludes ENABLE_CHART_DYNAMICS from textEvents', () => {
		const chart = buildChart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
			ExpertDrums: [
				'0 = N 0 0',
				'0 = E ENABLE_CHART_DYNAMICS',
			],
		})

		const result = parseNotesFromChart(chart)
		const track = getTrack(result, 'drums')!
		expect(track.textEvents).toEqual([])
	})

	it('excludes [ENABLE_CHART_DYNAMICS] (with brackets) from textEvents', () => {
		const chart = buildChart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
			ExpertDrums: [
				'0 = N 0 0',
				'0 = E [ENABLE_CHART_DYNAMICS]',
			],
		})

		const result = parseNotesFromChart(chart)
		const track = getTrack(result, 'drums')!
		expect(track.textEvents).toEqual([])
	})

	it('excludes ENHANCED_OPENS and [ENHANCED_OPENS] from textEvents', () => {
		const chart = buildChart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
			ExpertSingle: [
				'0 = N 0 0',
				'0 = E ENHANCED_OPENS',
				'0 = E [ENHANCED_OPENS]',
				'192 = E [play]',
			],
		})

		const result = parseNotesFromChart(chart)
		const track = getTrack(result, 'guitar')!
		expect(track.textEvents).toEqual([
			{ tick: 192, text: '[play]' },
		])
	})
})

// ---------------------------------------------------------------------------
// MIDI: noteOn/noteOff edge cases
// ---------------------------------------------------------------------------

describe('MIDI: note pair extraction edge cases', () => {
	it('handles velocity-0 noteOn as noteOff for versus phrases', () => {
		// Build MIDI manually with velocity-0 noteOn to end the phrase
		const track: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'PART GUITAR' },
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },    // expert green
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 105, velocity: 100 },   // versus p1 start
			{ deltaTime: 120, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
			{ deltaTime: 360, type: 'noteOn', channel: 0, noteNumber: 105, velocity: 0 },   // versus p1 end (velocity-0 noteOn)
			{ deltaTime: 0, type: 'endOfTrack' },
		]

		const midi = buildMidi(480, [tempoTrack(), eventsTrack(), track])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const gtr = getTrack(result, 'guitar')!
		expect(gtr.versusPhrases).toEqual([
			{ tick: 0, length: 480, isPlayer2: false },
		])
	})

	it('skips duplicate noteOn for animations', () => {
		// Two noteOns for the same note without an intervening noteOff — second should be ignored
		const track: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'PART GUITAR' },
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },  // expert green
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 40, velocity: 100 },  // anim start
			{ deltaTime: 240, type: 'noteOn', channel: 0, noteNumber: 40, velocity: 100 }, // duplicate noteOn (ignored)
			{ deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 40, velocity: 0 },  // anim end
			{ deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
			{ deltaTime: 0, type: 'endOfTrack' },
		]

		const midi = buildMidi(480, [tempoTrack(), eventsTrack(), track])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const gtr = getTrack(result, 'guitar')!
		// Should produce exactly one animation from tick 0 to tick 480 (length 480)
		expect(gtr.animations).toEqual([
			{ tick: 0, length: 480, noteNumber: 40 },
		])
	})
})

// ---------------------------------------------------------------------------
// MIDI: keys animation range
// ---------------------------------------------------------------------------

describe('MIDI: keys animations', () => {
	it('extracts left hand positions (40-59) on keys track', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART KEYS', {
				notes: [
					{ tick: 480, noteNumber: 96, length: 120 }, // expert green
					{ tick: 480, noteNumber: 48, length: 240 }, // left hand position 9
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'keys')!
		expect(track.animations).toEqual([
			{ tick: 480, length: 240, noteNumber: 48 },
		])
	})
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('per-track data edge cases', () => {
	it('returns empty arrays when no text events, versus phrases, or animations present', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART GUITAR', {
				notes: [{ tick: 480, noteNumber: 96, length: 120 }],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'guitar')!
		expect(track.textEvents).toEqual([])
		expect(track.versusPhrases).toEqual([])
		expect(track.animations).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// MIDI: Global Events
// ---------------------------------------------------------------------------

describe('MIDI: global events', () => {
	it('captures crowd and music events from EVENTS track', () => {
		const events: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'EVENTS' },
			{ deltaTime: 0, type: 'text', text: '[crowd_normal]' },
			{ deltaTime: 480, type: 'text', text: '[music_start]' },
			{ deltaTime: 960, type: 'text', text: '[music_end]' },
			{ deltaTime: 0, type: 'endOfTrack' },
		]

		const midi = buildMidi(480, [tempoTrack(), events])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.globalEvents).toEqual([
			{ tick: 0, text: '[crowd_normal]' },
			{ tick: 480, text: '[music_start]' },
			{ tick: 1440, text: '[music_end]' },
		])
	})

	it('excludes sections from globalEvents', () => {
		const events: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'EVENTS' },
			{ deltaTime: 0, type: 'text', text: '[section intro]' },
			{ deltaTime: 480, type: 'text', text: '[crowd_intense]' },
			{ deltaTime: 480, type: 'text', text: '[section verse]' },
			{ deltaTime: 0, type: 'endOfTrack' },
		]

		const midi = buildMidi(480, [tempoTrack(), events])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.globalEvents).toEqual([
			{ tick: 480, text: '[crowd_intense]' },
		])
	})

	it('excludes end events, lyrics, and phrase markers from globalEvents (keeps coda)', () => {
		const events: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'EVENTS' },
			{ deltaTime: 480, type: 'text', text: '[end]' },
			{ deltaTime: 0, type: 'text', text: '[coda]' },
			{ deltaTime: 480, type: 'text', text: '[crowd_clap]' },
			{ deltaTime: 0, type: 'endOfTrack' },
		]

		const midi = buildMidi(480, [tempoTrack(), events])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.globalEvents).toEqual([
			{ tick: 480, text: '[coda]' },
			{ tick: 960, text: '[crowd_clap]' },
		])
	})

	it('excludes lyric and phrase events from globalEvents', () => {
		const events: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'EVENTS' },
			{ deltaTime: 480, type: 'text', text: 'lyric Hello' },
			{ deltaTime: 480, type: 'text', text: 'phrase_start' },
			{ deltaTime: 480, type: 'text', text: 'phrase_end' },
			{ deltaTime: 480, type: 'text', text: '[music_end]' },
			{ deltaTime: 0, type: 'endOfTrack' },
		]

		const midi = buildMidi(480, [tempoTrack(), events])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.globalEvents).toEqual([
			{ tick: 1920, text: '[music_end]' },
		])
	})

	it('reads from lyrics, marker, and cuePoint event types (not just text)', () => {
		const events: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'EVENTS' },
			{ deltaTime: 0, type: 'text', text: '[crowd_normal]' },
			{ deltaTime: 480, type: 'lyrics', text: '[music_start]' },
			{ deltaTime: 480, type: 'marker', text: '[crowd_clap]' },
			{ deltaTime: 480, type: 'cuePoint', text: '[music_end]' },
			{ deltaTime: 0, type: 'endOfTrack' },
		]

		const midi = buildMidi(480, [tempoTrack(), events])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.globalEvents).toEqual([
			{ tick: 0, text: '[crowd_normal]' },
			{ tick: 480, text: '[music_start]' },
			{ tick: 960, text: '[crowd_clap]' },
			{ tick: 1440, text: '[music_end]' },
		])
	})

	it('reads sections from lyrics/marker event types', () => {
		const events: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'EVENTS' },
			{ deltaTime: 0, type: 'lyrics', text: '[section intro]' },
			{ deltaTime: 480, type: 'marker', text: '[section verse]' },
			{ deltaTime: 0, type: 'endOfTrack' },
		]

		const midi = buildMidi(480, [tempoTrack(), events])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.sections).toEqual([
			{ tick: 0, name: 'intro' },
			{ tick: 480, name: 'verse' },
		])
		expect(result.globalEvents).toEqual([])
	})

	it('reads end events from lyrics event type', () => {
		const events: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'EVENTS' },
			{ deltaTime: 960, type: 'lyrics', text: '[end]' },
			{ deltaTime: 0, type: 'endOfTrack' },
		]

		const midi = buildMidi(480, [tempoTrack(), events])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.endEvents).toEqual([{ tick: 960 }])
		expect(result.globalEvents).toEqual([])
	})

	it('returns empty array when no EVENTS track', () => {
		const midi = buildMidi(480, [tempoTrack()])
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.globalEvents).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// .chart: Global Events
// ---------------------------------------------------------------------------

describe('.chart: global events', () => {
	it('captures non-section/end/lyric/phrase events from [Events]', () => {
		const chart = buildChart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [
				'0 = E "crowd_normal"',
				'192 = E "music_start"',
				'384 = E "section intro"',
				'768 = E "music_end"',
			],
		})

		const result = parseNotesFromChart(chart)
		expect(result.globalEvents).toEqual([
			{ tick: 0, text: 'crowd_normal' },
			{ tick: 192, text: 'music_start' },
			{ tick: 768, text: 'music_end' },
		])
	})

	it('excludes end events, lyrics, and phrase markers (keeps coda)', () => {
		const chart = buildChart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [
				'0 = E "end"',
				'0 = E "coda"',
				'192 = E "lyric Hello"',
				'384 = E "phrase_start"',
				'576 = E "phrase_end"',
				'768 = E "crowd_clap"',
			],
		})

		const result = parseNotesFromChart(chart)
		expect(result.globalEvents).toEqual([
			{ tick: 0, text: 'coda' },
			{ tick: 768, text: 'crowd_clap' },
		])
	})

	it('returns empty array when no Events section', () => {
		const chart = buildChart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			ExpertSingle: ['0 = N 0 0'],
		})

		const result = parseNotesFromChart(chart)
		expect(result.globalEvents).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// gameMode
// ---------------------------------------------------------------------------

describe('gameMode on ParsedChart trackData', () => {
	it('sets fiveFret for guitar', () => {
		const chart = buildChart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
			ExpertSingle: ['0 = N 0 0'],
		})

		const parsed = parseChartFile(chart, 'chart')
		const track = parsed.trackData.find(t => t.instrument === 'guitar' && t.difficulty === 'expert')!
		expect(track.gameMode).toBe('fiveFret')
	})

	it('sets sixFret for GHL instruments', () => {
		const chart = buildChart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
			ExpertGHLGuitar: ['0 = N 0 0'],
		})

		const parsed = parseChartFile(chart, 'chart')
		const track = parsed.trackData.find(t => t.instrument === 'guitarghl' && t.difficulty === 'expert')!
		expect(track.gameMode).toBe('sixFret')
	})

	it('sets drums for drum tracks', () => {
		const chart = buildChart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
			ExpertDrums: ['0 = N 0 0'],
		})

		const parsed = parseChartFile(chart, 'chart')
		const track = parsed.trackData.find(t => t.instrument === 'drums' && t.difficulty === 'expert')!
		expect(track.gameMode).toBe('drums')
	})

	it('sets gameMode from MIDI tracks', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART GUITAR', {
				notes: [{ tick: 480, noteNumber: 96, length: 120 }],
			}),
			instrumentTrack('PART DRUMS', {
				notes: [{ tick: 480, noteNumber: 97, length: 120 }],
			}),
		])

		const parsed = parseChartFile(midi, 'mid')
		const gtr = parsed.trackData.find(t => t.instrument === 'guitar' && t.difficulty === 'expert')!
		const drums = parsed.trackData.find(t => t.instrument === 'drums' && t.difficulty === 'expert')!
		expect(gtr.gameMode).toBe('fiveFret')
		expect(drums.gameMode).toBe('drums')
	})
})

// ---------------------------------------------------------------------------
// New instruments
// ---------------------------------------------------------------------------

describe('MIDI: Pro Guitar', () => {
	it('recognizes PART REAL_GUITAR and extracts star power and solo', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART REAL_GUITAR', {
				notes: [
					{ tick: 480, noteNumber: 116, length: 960 },  // star power
					{ tick: 480, noteNumber: 115, length: 960 },  // solo (pro guitar uses 115)
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'proguitar', 'expert')!
		expect(track).toBeDefined()
		expect(track.starPowerSections).toHaveLength(1)
		expect(track.starPowerSections[0]).toMatchObject({ tick: 480, length: 960 })
		expect(track.soloSections).toHaveLength(1)
		expect(track.soloSections[0]).toMatchObject({ tick: 480, length: 960 })
		expect(track.trackEvents).toEqual([]) // standard note parsing skipped for pro instruments
	})

	it('extracts raw notes with fret and channel data', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART REAL_GUITAR', {
				notes: [
					{ tick: 480, noteNumber: 96, length: 120, velocity: 105 },  // expert string 0 (low E), fret 5
					{ tick: 480, noteNumber: 97, length: 120, velocity: 100 },  // expert string 1 (A), open
					{ tick: 960, noteNumber: 96, length: 240, velocity: 107 },  // expert string 0, fret 7
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'proguitar', 'expert')!
		expect(track.rawNotes).toHaveLength(3)
		expect(track.rawNotes[0]).toMatchObject({ tick: 480, noteNumber: 96, velocity: 105 })
		expect(track.rawNotes[1]).toMatchObject({ tick: 480, noteNumber: 97, velocity: 100 })
		expect(track.rawNotes[2]).toMatchObject({ tick: 960, noteNumber: 96, velocity: 107 })
	})

	it('assigns raw notes to correct difficulties', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART REAL_GUITAR', {
				notes: [
					{ tick: 480, noteNumber: 96, length: 120 },  // expert (96-101)
					{ tick: 480, noteNumber: 72, length: 120 },  // hard (72-77)
					{ tick: 480, noteNumber: 48, length: 120 },  // medium (48-53)
					{ tick: 480, noteNumber: 24, length: 120 },  // easy (24-29)
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(getTrack(result, 'proguitar', 'expert')!.rawNotes).toHaveLength(1)
		expect(getTrack(result, 'proguitar', 'hard')!.rawNotes).toHaveLength(1)
		expect(getTrack(result, 'proguitar', 'medium')!.rawNotes).toHaveLength(1)
		expect(getTrack(result, 'proguitar', 'easy')!.rawNotes).toHaveLength(1)
	})

	it('extracts text events from Pro Guitar track', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART REAL_GUITAR', {
				notes: [{ tick: 480, noteNumber: 116, length: 960 }],
				textEvents: [{ tick: 0, text: 'begin_pg song_trainer_pg_1' }],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'proguitar', 'expert')!
		expect(track.textEvents).toEqual([{ tick: 0, text: 'begin_pg song_trainer_pg_1' }])
	})

	it('sets gameMode to proGuitar', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART REAL_GUITAR', {
				notes: [{ tick: 480, noteNumber: 116, length: 960 }],
			}),
		])

		const parsed = parseChartFile(midi, 'mid')
		const track = parsed.trackData.find(t => t.instrument === 'proguitar')!
		expect(track.gameMode).toBe('proGuitar')
	})

	it('recognizes PART REAL_GUITAR_22 as proguitar22', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART REAL_GUITAR_22', {
				notes: [{ tick: 480, noteNumber: 116, length: 960 }],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'proguitar22', 'expert')!
		expect(track).toBeDefined()
		expect(track.starPowerSections).toHaveLength(1)
	})
})

describe('MIDI: Pro Bass', () => {
	it('recognizes PART REAL_BASS and PART REAL_BASS_22', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART REAL_BASS', {
				notes: [{ tick: 480, noteNumber: 116, length: 960 }],
			}),
			instrumentTrack('PART REAL_BASS_22', {
				notes: [{ tick: 480, noteNumber: 116, length: 960 }],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(getTrack(result, 'probass', 'expert')).toBeDefined()
		expect(getTrack(result, 'probass22', 'expert')).toBeDefined()
	})
})

describe('MIDI: Pro Keys', () => {
	it('maps each PART REAL_KEYS_* track to a single difficulty', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART REAL_KEYS_X', {
				notes: [{ tick: 480, noteNumber: 116, length: 960 }],
			}),
			instrumentTrack('PART REAL_KEYS_H', {
				notes: [{ tick: 480, noteNumber: 116, length: 960 }],
			}),
			instrumentTrack('PART REAL_KEYS_M', {
				notes: [{ tick: 480, noteNumber: 116, length: 960 }],
			}),
			instrumentTrack('PART REAL_KEYS_E', {
				notes: [{ tick: 480, noteNumber: 116, length: 960 }],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const prokeys = result.trackData.filter(t => t.instrument === 'prokeys')
		expect(prokeys).toHaveLength(4)
		expect(prokeys.map(t => t.difficulty).sort()).toEqual(['easy', 'expert', 'hard', 'medium'])
	})

	it('extracts star power on Pro Keys', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART REAL_KEYS_X', {
				notes: [{ tick: 480, noteNumber: 116, length: 960 }],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'prokeys', 'expert')!
		expect(track.starPowerSections).toHaveLength(1)
		// Should NOT create entries for other difficulties from this track
		expect(getTrack(result, 'prokeys', 'hard')).toBeUndefined()
	})

	it('sets gameMode to proKeys', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART REAL_KEYS_X', {
				notes: [{ tick: 480, noteNumber: 116, length: 960 }],
			}),
		])

		const parsed = parseChartFile(midi, 'mid')
		const track = parsed.trackData.find(t => t.instrument === 'prokeys')!
		expect(track.gameMode).toBe('proKeys')
	})

	it('extracts raw key notes (MIDI 48-72)', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART REAL_KEYS_X', {
				notes: [
					{ tick: 480, noteNumber: 48, length: 240 },  // C1 (lowest key)
					{ tick: 480, noteNumber: 60, length: 240 },  // C2 (middle)
					{ tick: 960, noteNumber: 72, length: 120 },  // C3 (highest key)
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'prokeys', 'expert')!
		expect(track.rawNotes).toHaveLength(3)
		expect(track.rawNotes[0]).toMatchObject({ tick: 480, noteNumber: 48 })
		expect(track.rawNotes[1]).toMatchObject({ tick: 480, noteNumber: 60 })
		expect(track.rawNotes[2]).toMatchObject({ tick: 960, noteNumber: 72 })
	})
})

describe('MIDI: Elite Drums', () => {
	it('recognizes PART ELITE_DRUMS and extracts star power', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART ELITE_DRUMS', {
				notes: [{ tick: 480, noteNumber: 116, length: 960 }],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'elitedrums', 'expert')!
		expect(track).toBeDefined()
		expect(track.starPowerSections).toHaveLength(1)
	})

	it('sets gameMode to eliteDrums', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART ELITE_DRUMS', {
				notes: [{ tick: 480, noteNumber: 116, length: 960 }],
			}),
		])

		const parsed = parseChartFile(midi, 'mid')
		const track = parsed.trackData.find(t => t.instrument === 'elitedrums')!
		expect(track.gameMode).toBe('eliteDrums')
	})

	it('extracts raw pad notes with velocity and assigns to correct difficulty', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART ELITE_DRUMS', {
				notes: [
					{ tick: 480, noteNumber: 74, length: 0, velocity: 100 },  // expert kick (base=74, offset 0)
					{ tick: 480, noteNumber: 75, length: 0, velocity: 127 },  // expert snare, accent (velocity 127)
					{ tick: 960, noteNumber: 50, length: 0, velocity: 100 },  // hard kick (base=50)
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const expert = getTrack(result, 'elitedrums', 'expert')!
		expect(expert.rawNotes).toHaveLength(2)
		expect(expert.rawNotes[0]).toMatchObject({ tick: 480, noteNumber: 74, velocity: 100 })
		expect(expert.rawNotes[1]).toMatchObject({ tick: 480, noteNumber: 75, velocity: 127 })
		const hard = getTrack(result, 'elitedrums', 'hard')!
		expect(hard.rawNotes).toHaveLength(1)
		expect(hard.rawNotes[0]).toMatchObject({ tick: 960, noteNumber: 50 })
	})
})

describe('MIDI: Phase Shift Real Drums', () => {
	it('maps PART REAL_DRUMS_PS to drums instrument', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART REAL_DRUMS_PS', {
				notes: [{ tick: 480, noteNumber: 97, length: 120 }], // expert red drum
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'drums', 'expert')!
		expect(track).toBeDefined()
		expect(track.trackEvents.length).toBeGreaterThan(0) // notes should be parsed as standard drums
	})
})

describe('MIDI: GHL Keys', () => {
	it('recognizes PART KEYS GHL as keysghl with sixFret note parsing', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART KEYS GHL', {
				notes: [
					{ tick: 480, noteNumber: 94, length: 120 },  // expert open (sixFretDiffStart.expert = 94)
					{ tick: 960, noteNumber: 95, length: 120 },  // expert white1
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'keysghl', 'expert')!
		expect(track).toBeDefined()
		expect(track.trackEvents.length).toBeGreaterThan(0)
	})

	it('sets gameMode to sixFret', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART KEYS GHL', {
				notes: [{ tick: 480, noteNumber: 95, length: 120 }],
			}),
		])

		const parsed = parseChartFile(midi, 'mid')
		const track = parsed.trackData.find(t => t.instrument === 'keysghl')!
		expect(track.gameMode).toBe('sixFret')
	})
})

describe('.chart: GHL Keys', () => {
	it('parses ExpertGHLKeys section', () => {
		const chart = buildChart({
			Song: ['Resolution = 192'],
			SyncTrack: ['0 = B 120000', '0 = TS 4'],
			Events: [],
			ExpertGHLKeys: ['0 = N 0 0', '192 = N 1 0'],
		})

		const result = parseNotesFromChart(chart)
		const track = getTrack(result, 'keysghl')!
		expect(track).toBeDefined()
		expect(track.trackEvents.length).toBeGreaterThan(0)
	})
})

// ---------------------------------------------------------------------------
// Semantic labels on rawNotes
// ---------------------------------------------------------------------------

describe('rawNotes semantic labels', () => {
	it('adds string/fret/noteModifier for Pro Guitar', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART REAL_GUITAR', {
				notes: [
					{ tick: 480, noteNumber: 98, length: 120, velocity: 107 }, // expert, string 2 (D), fret 7
				],
			}),
		])

		const parsed = parseChartFile(midi, 'mid')
		const track = parsed.trackData.find(t => t.instrument === 'proguitar' && t.difficulty === 'expert')!
		expect(track.rawNotes[0]).toMatchObject({ string: 2, fret: 7, noteModifier: 'normal' })
	})

	it('maps MIDI channel to pro guitar note modifier', () => {
		// Build MIDI with channel 3 (muted)
		const track: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'PART REAL_GUITAR' },
			{ deltaTime: 0, type: 'noteOn', channel: 3, noteNumber: 96, velocity: 103 },
			{ deltaTime: 120, type: 'noteOff', channel: 3, noteNumber: 96, velocity: 0 },
			{ deltaTime: 0, type: 'endOfTrack' },
		]

		const midi = buildMidi(480, [tempoTrack(), eventsTrack(), track])
		const parsed = parseChartFile(midi, 'mid')
		const gtr = parsed.trackData.find(t => t.instrument === 'proguitar' && t.difficulty === 'expert')!
		expect(gtr.rawNotes[0]).toMatchObject({ string: 0, fret: 3, noteModifier: 'muted' })
	})

	it('adds key index for Pro Keys', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART REAL_KEYS_X', {
				notes: [{ tick: 480, noteNumber: 60, length: 120 }], // C2 = key 12
			}),
		])

		const parsed = parseChartFile(midi, 'mid')
		const track = parsed.trackData.find(t => t.instrument === 'prokeys' && t.difficulty === 'expert')!
		expect(track.rawNotes[0]).toMatchObject({ key: 12 })
	})

	it('adds pad name for Elite Drums', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART ELITE_DRUMS', {
				notes: [
					{ tick: 480, noteNumber: 74, length: 0 },  // expert kick (base=74, offset 0)
					{ tick: 480, noteNumber: 72, length: 0 },  // expert hatPedal (base=74, offset -2)
					{ tick: 480, noteNumber: 75, length: 0 },  // expert snare (offset 1)
				],
			}),
		])

		const parsed = parseChartFile(midi, 'mid')
		const track = parsed.trackData.find(t => t.instrument === 'elitedrums' && t.difficulty === 'expert')!
		expect(track.rawNotes[0]).toMatchObject({ pad: 'hatPedal' })
		expect(track.rawNotes[1]).toMatchObject({ pad: 'kick' })
		expect(track.rawNotes[2]).toMatchObject({ pad: 'snare' })
	})
})

// ---------------------------------------------------------------------------
// Pro instrument sustain trimming and fret capping
// ---------------------------------------------------------------------------

describe('Pro instrument sustain trimming', () => {
	it('trims short sustains to 0 on Pro Keys (length < resolution/3)', () => {
		// resolution=480 → threshold=160 → notes with length < 160 are trimmed
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART REAL_KEYS_X', {
				notes: [
					{ tick: 480, noteNumber: 60, length: 60 },   // 60 < 160 → trimmed to 0
					{ tick: 960, noteNumber: 60, length: 120 },  // 120 < 160 → trimmed to 0
				],
			}),
		])

		const parsed = parseChartFile(midi, 'mid')
		const track = parsed.trackData.find(t => t.instrument === 'prokeys' && t.difficulty === 'expert')!
		expect(track.rawNotes[0].length).toBe(0)
		expect(track.rawNotes[1].length).toBe(0)
	})

	it('preserves sustains at exactly resolution/3 on Pro instruments', () => {
		// resolution=480 → threshold=160 → length 160 is NOT trimmed (strict <)
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART REAL_KEYS_X', {
				notes: [{ tick: 480, noteNumber: 60, length: 160 }], // 160 is NOT < 160 → kept
			}),
		])

		const parsed = parseChartFile(midi, 'mid')
		const track = parsed.trackData.find(t => t.instrument === 'prokeys' && t.difficulty === 'expert')!
		expect(track.rawNotes[0].length).toBe(160)
	})

	it('trims short sustains on Pro Guitar', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART REAL_GUITAR', {
				notes: [
					{ tick: 480, noteNumber: 96, length: 100, velocity: 105 }, // 100 < 160 → trimmed
					{ tick: 960, noteNumber: 96, length: 200, velocity: 105 }, // 200 > 160 → kept
				],
			}),
		])

		const parsed = parseChartFile(midi, 'mid')
		const track = parsed.trackData.find(t => t.instrument === 'proguitar' && t.difficulty === 'expert')!
		expect(track.rawNotes[0].length).toBe(0)
		expect(track.rawNotes[1].length).toBe(200)
	})
})

describe('Pro Guitar fret capping', () => {
	it('caps 17-fret guitar at fret 17', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART REAL_GUITAR', {
				notes: [
					{ tick: 480, noteNumber: 96, length: 0, velocity: 120 }, // fret = 120-100 = 20, capped to 17
				],
			}),
		])

		const parsed = parseChartFile(midi, 'mid')
		const track = parsed.trackData.find(t => t.instrument === 'proguitar' && t.difficulty === 'expert')!
		expect(track.rawNotes[0].fret).toBe(17)
	})

	it('caps 22-fret guitar at fret 22', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART REAL_GUITAR_22', {
				notes: [
					{ tick: 480, noteNumber: 96, length: 0, velocity: 123 }, // fret = 23, capped to 22
				],
			}),
		])

		const parsed = parseChartFile(midi, 'mid')
		const track = parsed.trackData.find(t => t.instrument === 'proguitar22' && t.difficulty === 'expert')!
		expect(track.rawNotes[0].fret).toBe(22)
	})

	it('does not cap frets within valid range', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART REAL_GUITAR_22', {
				notes: [
					{ tick: 480, noteNumber: 96, length: 0, velocity: 100 }, // fret 0 (open)
					{ tick: 960, noteNumber: 96, length: 0, velocity: 112 }, // fret 12
					{ tick: 1440, noteNumber: 96, length: 0, velocity: 122 }, // fret 22
				],
			}),
		])

		const parsed = parseChartFile(midi, 'mid')
		const track = parsed.trackData.find(t => t.instrument === 'proguitar22' && t.difficulty === 'expert')!
		expect(track.rawNotes[0].fret).toBe(0)
		expect(track.rawNotes[1].fret).toBe(12)
		expect(track.rawNotes[2].fret).toBe(22)
	})
})

// ---------------------------------------------------------------------------
// Animation naming
// ---------------------------------------------------------------------------

describe('animation semantic names', () => {
	it('names guitar animations as left hand positions', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART GUITAR', {
				notes: [
					{ tick: 480, noteNumber: 96, length: 120 },
					{ tick: 480, noteNumber: 45, length: 120 },
				],
			}),
		])

		const parsed = parseChartFile(midi, 'mid')
		const track = parsed.trackData.find(t => t.instrument === 'guitar' && t.difficulty === 'expert')!
		expect(track.animations[0]).toMatchObject({ noteNumber: 45, name: 'leftHandPosition6' })
	})

	it('names drum animations', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART DRUMS', {
				notes: [
					{ tick: 480, noteNumber: 97, length: 120 },
					{ tick: 480, noteNumber: 24, length: 120 },
					{ tick: 480, noteNumber: 27, length: 120 },
				],
			}),
		])

		const parsed = parseChartFile(midi, 'mid')
		const track = parsed.trackData.find(t => t.instrument === 'drums' && t.difficulty === 'expert')!
		expect(track.animations[0]).toMatchObject({ noteNumber: 24, name: 'kick' })
		expect(track.animations[1]).toMatchObject({ noteNumber: 27, name: 'snareRHHard' })
	})
})

// ---------------------------------------------------------------------------
// HandMap, StrumMap, CharacterState
// ---------------------------------------------------------------------------

describe('HandMap, StrumMap, CharacterState parsing', () => {
	it('parses HandMap from text events', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART GUITAR', {
				notes: [{ tick: 480, noteNumber: 96, length: 120 }],
				textEvents: [
					{ tick: 0, text: '[map HandMap_Default]' },
					{ tick: 480, text: '[map HandMap_Solo]' },
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'guitar')!
		expect(track.handMaps).toEqual([
			{ tick: 0, type: 'default' },
			{ tick: 480, type: 'solo' },
		])
	})

	it('parses StrumMap from text events', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART BASS', {
				notes: [{ tick: 480, noteNumber: 96, length: 120 }],
				textEvents: [{ tick: 0, text: '[map StrumMap_SlapBass]' }],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'bass')!
		expect(track.strumMaps).toEqual([{ tick: 0, type: 'slapBass' }])
	})

	it('parses CharacterState from text events', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART GUITAR', {
				notes: [{ tick: 480, noteNumber: 96, length: 120 }],
				textEvents: [
					{ tick: 0, text: '[idle]' },
					{ tick: 480, text: '[play]' },
					{ tick: 960, text: '[intense]' },
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'guitar')!
		expect(track.characterStates).toEqual([
			{ tick: 0, type: 'idle' },
			{ tick: 480, type: 'play' },
			{ tick: 960, type: 'intense' },
		])
	})
})

// ---------------------------------------------------------------------------
// Pro Keys glissando
// ---------------------------------------------------------------------------

describe('Pro Keys glissando', () => {
	it('extracts note 126 as glissando on Pro Keys (not flexLane)', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART REAL_KEYS_X', {
				notes: [
					{ tick: 480, noteNumber: 116, length: 1920 }, // star power (so track is included)
					{ tick: 480, noteNumber: 126, length: 960 },  // glissando on pro keys
					{ tick: 480, noteNumber: 127, length: 960 },  // trill (flexLaneDouble)
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'prokeys', 'expert')!
		expect(track.glissandoSections).toHaveLength(1)
		expect(track.glissandoSections[0]).toMatchObject({ tick: 480, length: 960 })
		// Note 127 should be a flex lane (trill)
		expect(track.flexLanes).toHaveLength(1)
	})

	it('keeps note 126 as flexLane on standard guitar', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			instrumentTrack('PART GUITAR', {
				notes: [
					{ tick: 480, noteNumber: 96, length: 120 },
					{ tick: 480, noteNumber: 126, length: 960 },
				],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const track = getTrack(result, 'guitar')!
		expect(track.flexLanes).toHaveLength(1)
		expect(track.glissandoSections).toHaveLength(0)
	})
})

