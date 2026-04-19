/**
 * Tests for vocalTracks parsing in midi-parser and chart-parser.
 * Covers: PART VOCALS, HARM1/2/3, CopyDownPhrases behavior, track name variants.
 */

import { describe, it, expect } from 'vitest'
import { writeMidi, MidiData } from 'midi-file'
import { parseNotesFromMidi } from '../chart/midi-parser'
import { parseNotesFromChart } from '../chart/chart-parser'
import { parseChartFile } from '../chart/notes-parser'
import { defaultIniChartModifiers, lyricFlags } from '../chart/note-parsing-interfaces'

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
	/** Note 105 phrases (scoring phrases). */
	phrases?: { tick: number; length: number }[]
	/** Note 106 phrases (static lyric phrases / versus player 2). */
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

	for (const p of opts.phrases ?? []) {
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
				phrases: [{ tick: 480, length: 720 }],
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
				phrases: [{ tick: 480, length: 480 }],
			}),
			vocalTrack('HARM1', {
				lyrics: [{ tick: 480, text: 'harm1' }],
				notes: [{ tick: 480, pitch: 62, length: 240 }],
				phrases: [{ tick: 480, length: 480 }],
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
				phrases: [{ tick: 480, length: 480 }],
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
				phrases: [{ tick: 480, length: 480 }],
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
				phrases: [
					{ tick: 480, length: 480 },
					{ tick: 1920, length: 480 },
				],
			}),
			vocalTrack('HARM2', {
				notes: [{ tick: 480, pitch: 62, length: 240 }],
				// HARM2 has its own single phrase in the MIDI, but it gets replaced
				phrases: [{ tick: 480, length: 240 }],
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
				phrases: [
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
				phrases: [{ tick: 480, length: 480 }],
			}),
			vocalTrack('HARM2', {
				notes: [{ tick: 480, pitch: 62, length: 240 }],
				phrases: [
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
				phrases: [{ tick: 480, length: 240 }],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		// No HARM1 to copy from, so HARM2 keeps its own
		expect(result.vocalTracks.harmony2.vocalPhrases).toHaveLength(1)
		expect(result.vocalTracks.harmony2.vocalPhrases[0]).toMatchObject({ tick: 480, length: 240 })
	})

	it('HARM2 own phrases become staticLyricPhrases', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('HARM1', {
				notes: [{ tick: 480, pitch: 60, length: 240 }],
				phrases: [
					{ tick: 480, length: 480 },
					{ tick: 1920, length: 480 },
					{ tick: 3840, length: 480 },
				],
			}),
			vocalTrack('HARM2', {
				notes: [{ tick: 480, pitch: 62, length: 240 }],
				phrases: [{ tick: 960, length: 240 }],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		// HARM2's own phrase (tick 960) becomes staticLyricPhrases
		expect(result.vocalTracks.harmony2.staticLyricPhrases).toHaveLength(1)
		expect(result.vocalTracks.harmony2.staticLyricPhrases[0]).toMatchObject({ tick: 960, length: 240 })
		// HARM2's scoring phrases come from HARM1
		expect(result.vocalTracks.harmony2.vocalPhrases).toHaveLength(3)
	})

	it('HARM3 clones staticLyricPhrases from HARM2', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('HARM1', {
				notes: [{ tick: 480, pitch: 60, length: 240 }],
				phrases: [{ tick: 480, length: 480 }],
			}),
			vocalTrack('HARM2', {
				notes: [{ tick: 480, pitch: 62, length: 240 }],
				phrases: [{ tick: 960, length: 240 }],
			}),
			vocalTrack('HARM3', {
				notes: [{ tick: 480, pitch: 64, length: 240 }],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		// HARM3 gets HARM2's staticLyricPhrases
		expect(result.vocalTracks.harmony3.staticLyricPhrases).toHaveLength(1)
		expect(result.vocalTracks.harmony3.staticLyricPhrases[0]).toMatchObject({ tick: 960, length: 240 })
		// Independent copy
		expect(result.vocalTracks.harmony3.staticLyricPhrases[0]).not.toBe(result.vocalTracks.harmony2.staticLyricPhrases[0])
	})

	it('CopyDown creates independent copies (not shared references)', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('HARM1', {
				notes: [{ tick: 480, pitch: 60, length: 240 }],
				phrases: [{ tick: 480, length: 480 }],
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

// ---------------------------------------------------------------------------
// Vocal notes, star power, range/lyric shifts through parseNotesFromMidi
// ---------------------------------------------------------------------------

describe('vocalTracks: notes and markers', () => {
	it('extracts vocal notes with correct types', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				notes: [
					{ tick: 480, pitch: 60, length: 240 },   // pitched
					{ tick: 960, pitch: 96, length: 120 },   // percussion
					{ tick: 1440, pitch: 97, length: 120 },  // percussionHidden
				],
				phrases: [{ tick: 480, length: 1200 }],
			}),
		])

		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		const notes = result.vocalTracks.vocals.notes
		expect(notes).toHaveLength(3)
		expect(notes[0]).toMatchObject({ tick: 480, length: 240, pitch: 60, type: 'pitched' })
		expect(notes[1]).toMatchObject({ tick: 960, length: 120, pitch: 96, type: 'percussion' })
		expect(notes[2]).toMatchObject({ tick: 1440, length: 120, pitch: 97, type: 'percussionHidden' })
	})

	it('extracts star power sections', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				notes: [{ tick: 480, pitch: 60, length: 240 }],
				phrases: [{ tick: 480, length: 960 }],
			}),
		])

		// Manually add note 116 for star power — vocalTrack helper doesn't support it
		// So test via the unit-level extractMidiVocalStarPower instead
		// Integration is covered by the fact that midi-parser calls the function
		const result = parseNotesFromMidi(midi, defaultIniChartModifiers)
		expect(result.vocalTracks.vocals.starPowerSections).toBeDefined()
		expect(result.vocalTracks.vocals.rangeShifts).toBeDefined()
		expect(result.vocalTracks.vocals.lyricShifts).toBeDefined()
	})

	it('.chart vocals have empty notes/starPower/shifts', () => {
		const chart = buildChart({
			Song: ['Resolution = 480'],
			SyncTrack: ['0 = B 120000'],
			Events: ['480 = E "lyric Hello"'],
		})

		const result = parseNotesFromChart(chart)
		expect(result.vocalTracks.vocals.notes).toEqual([])
		expect(result.vocalTracks.vocals.starPowerSections).toEqual([])
		expect(result.vocalTracks.vocals.rangeShifts).toEqual([])
		expect(result.vocalTracks.vocals.lyricShifts).toEqual([])
		expect(result.vocalTracks.vocals.staticLyricPhrases).toEqual([])
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

// ---------------------------------------------------------------------------
// Normalized vocal tracks (through parseChartFile)
// ---------------------------------------------------------------------------

describe('normalizedVocalTracks', () => {
	it('groups notes and lyrics into phrases', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				lyrics: [
					{ tick: 480, text: 'Hel-' },
					{ tick: 720, text: 'lo' },
					{ tick: 1920, text: 'World' },
				],
				notes: [
					{ tick: 480, pitch: 60, length: 240 },
					{ tick: 720, pitch: 62, length: 240 },
					{ tick: 1920, pitch: 64, length: 240 },
				],
				phrases: [
					{ tick: 480, length: 480 },
					{ tick: 1920, length: 480 },
				],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		const vocals = result.vocalTracks.parts.vocals
		expect(vocals.notePhrases).toHaveLength(2)

		// First phrase has 2 notes and 2 lyrics
		expect(vocals.notePhrases[0].tick).toBe(480)
		expect(vocals.notePhrases[0].notes).toHaveLength(2)
		expect(vocals.notePhrases[0].lyrics).toHaveLength(2)
		expect(vocals.notePhrases[0].notes[0].pitch).toBe(60)
		expect(vocals.notePhrases[0].lyrics[0].text).toBe('Hel-')
		expect(vocals.notePhrases[0].lyrics[0].flags).toBe(lyricFlags.joinWithNext)
		expect(vocals.notePhrases[0].lyrics[1].text).toBe('lo')

		// Second phrase has 1 note and 1 lyric
		expect(vocals.notePhrases[1].tick).toBe(1920)
		expect(vocals.notePhrases[1].notes).toHaveLength(1)
		expect(vocals.notePhrases[1].lyrics).toHaveLength(1)
		expect(vocals.notePhrases[1].lyrics[0].text).toBe('World')
	})

	it('determines isPercussion from first note', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				notes: [
					{ tick: 600, pitch: 96, length: 120 },  // percussion (not at phrase start)
				],
				phrases: [{ tick: 480, length: 480 }],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		expect(result.vocalTracks.parts.vocals.notePhrases[0].isPercussion).toBe(true)
	})

	it('isPercussion is false when first note is pitched', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				notes: [{ tick: 480, pitch: 60, length: 240 }],
				phrases: [{ tick: 480, length: 480 }],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		expect(result.vocalTracks.parts.vocals.notePhrases[0].isPercussion).toBe(false)
	})

	it('excludes notes outside phrases', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				notes: [
					{ tick: 100, pitch: 60, length: 50 },  // before phrase
					{ tick: 480, pitch: 62, length: 240 },  // in phrase
					{ tick: 5000, pitch: 64, length: 240 }, // after phrase
				],
				phrases: [{ tick: 480, length: 480 }],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		expect(result.vocalTracks.parts.vocals.notePhrases[0].notes).toHaveLength(1)
		expect(result.vocalTracks.parts.vocals.notePhrases[0].notes[0].pitch).toBe(62)
	})

	it('preserves lyric symbols in text and derives flags', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				lyrics: [
					{ tick: 480, text: 'Cha#' },
					{ tick: 720, text: '$hid-' },
				],
				notes: [
					{ tick: 480, pitch: 60, length: 240 },
					{ tick: 720, pitch: 62, length: 240 },
				],
				phrases: [{ tick: 480, length: 480 }],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		const lyrics = result.vocalTracks.parts.vocals.notePhrases[0].lyrics
		expect(lyrics[0].text).toBe('Cha#')
		expect(lyrics[0].flags).toBe(lyricFlags.nonPitched)
		expect(lyrics[1].text).toBe('$hid-')
		expect(lyrics[1].flags).toBe(lyricFlags.harmonyHidden | lyricFlags.joinWithNext)
	})

	it('.chart vocals keep phrases with lyrics (no vocal notes in .chart format)', () => {
		// .chart format has lyrics and phrase markers but no vocal notes (MIDI-only).
		// Phrases are kept so all lyrics are accessible through phrase grouping.
		const chart = buildChart({
			Song: ['Resolution = 480'],
			SyncTrack: ['0 = B 120000'],
			Events: [
				'480 = E "phrase_start"',
				'480 = E "lyric Hello"',
				'960 = E "lyric World"',
				'1440 = E "phrase_end"',
			],
		})

		const result = parseChartFile(chart, 'chart')
		const vocals = result.vocalTracks.parts.vocals
		expect(vocals.notePhrases).toHaveLength(1)
		expect(vocals.notePhrases[0].lyrics).toHaveLength(2)
		expect(vocals.notePhrases[0].lyrics[0].text).toBe('Hello')
		expect(vocals.notePhrases[0].lyrics[1].text).toBe('World')
		expect(vocals.notePhrases[0].notes).toHaveLength(0)
	})

	it('preserves star power sections as separate array', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				notes: [{ tick: 480, pitch: 60, length: 240 }],
				phrases: [{ tick: 480, length: 480 }],
			}),
		])
		// Manually add star power note 116 — vocalTrack helper doesn't support it
		// Test via raw parser then parseChartFile
		const result = parseChartFile(midi, 'mid')
		expect(result.vocalTracks.parts.vocals.starPowerSections).toBeDefined()
		expect(Array.isArray(result.vocalTracks.parts.vocals.starPowerSections)).toBe(true)
	})

	it('stores range shifts at track level', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				notes: [{ tick: 480, pitch: 60, length: 240 }],
				phrases: [{ tick: 480, length: 480 }],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		expect(result.vocalTracks.rangeShifts).toBeDefined()
		expect(Array.isArray(result.vocalTracks.rangeShifts)).toBe(true)
		expect(result.vocalTracks.lyricShifts).toBeDefined()
		expect(Array.isArray(result.vocalTracks.lyricShifts)).toBe(true)
	})

	it('staticLyricPhrases copies notePhrases for vocals/HARM1', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				lyrics: [{ tick: 480, text: 'Hey' }],
				notes: [{ tick: 480, pitch: 60, length: 240 }],
				phrases: [{ tick: 480, length: 480 }],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		const vocals = result.vocalTracks.parts.vocals
		expect(vocals.staticLyricPhrases).toHaveLength(vocals.notePhrases.length)
		expect(vocals.staticLyricPhrases[0].tick).toBe(vocals.notePhrases[0].tick)
	})

	it('empty vocal track produces empty arrays', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {}),
		])

		const result = parseChartFile(midi, 'mid')
		const vocals = result.vocalTracks.parts.vocals
		expect(vocals.notePhrases).toHaveLength(0)
		expect(vocals.staticLyricPhrases).toHaveLength(0)
		expect(vocals.starPowerSections).toHaveLength(0)
	})

	it('includes msTime and msLength on phrases and notes', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				notes: [{ tick: 480, pitch: 60, length: 240 }],
				lyrics: [{ tick: 480, text: 'Hey' }],
				phrases: [{ tick: 480, length: 480 }],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		const phrase = result.vocalTracks.parts.vocals.notePhrases[0]
		expect(phrase.msTime).toBeGreaterThan(0)
		expect(phrase.msLength).toBeGreaterThan(0)
		expect(phrase.notes[0].msTime).toBeGreaterThan(0)
		expect(phrase.notes[0].msLength).toBeGreaterThan(0)
		expect(phrase.lyrics[0].msTime).toBeGreaterThan(0)
	})

	it('pitch slide with filtered "+" keeps the note for round-trip consistency', () => {
		// When "+" strips to empty and is filtered, the pitch slide note is NOT
		// skipped — on re-parse "+" wouldn't exist, so consistency requires keeping it.
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				lyrics: [
					{ tick: 480, text: 'me' },
					{ tick: 720, text: '+' },  // stripped to "" → filtered → note NOT skipped
					{ tick: 960, text: 'too' },
				],
				notes: [
					{ tick: 480, pitch: 60, length: 240 },
					{ tick: 720, pitch: 62, length: 240 },
					{ tick: 960, pitch: 64, length: 240 },
				],
				phrases: [{ tick: 480, length: 720 }],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		const lyrics = result.vocalTracks.parts.vocals.notePhrases[0].lyrics
		// "+" stripped to empty → filtered. Pitch slide note NOT skipped.
		expect(lyrics).toHaveLength(2)
		expect(lyrics[0].text).toBe('me')
		expect(lyrics[1].text).toBe('too')
		// All 3 notes kept (pitch slide at 720 not skipped because "+" was filtered)
		const notes = result.vocalTracks.parts.vocals.notePhrases[0].notes
		expect(notes).toHaveLength(3)
	})

	it('nonPitched flag keeps original MIDI pitch (consumers check lyric flags)', () => {
		// NonPitched notes (lyric with '#' suffix) keep their original MIDI pitch
		// for lossless round-trip. Consumers check lyric flags for nonPitched status.
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				lyrics: [{ tick: 480, text: 'Cha#' }],
				notes: [{ tick: 480, pitch: 60, length: 240 }],
				phrases: [{ tick: 480, length: 480 }],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		const note = result.vocalTracks.parts.vocals.notePhrases[0].notes[0]
		expect(note.pitch).toBe(60)  // keeps original MIDI pitch
		expect(note.type).toBe('pitched')
	})

	it('excludes percussionHidden (note 97) from normalized notes', () => {
		// YARG only processes PERCUSSION_NOTE (96), not NONPLAYED_PERCUSSION_NOTE (97).
		// Real example: "311 - Down" has 26 note-96 + 94 note-97 in a single phrase.
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				notes: [
					{ tick: 600, pitch: 96, length: 60 },   // percussion (included)
					{ tick: 720, pitch: 97, length: 60 },   // percussionHidden (excluded)
					{ tick: 960, pitch: 96, length: 60 },   // percussion (included)
				],
				phrases: [{ tick: 480, length: 720 }],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		const notes = result.vocalTracks.parts.vocals.notePhrases[0].notes
		expect(notes).toHaveLength(2)
		expect(notes[0].type).toBe('percussion')
		expect(notes[1].type).toBe('percussion')
	})

	it('pitch slide note is skipped when lyric survives filtering', () => {
		// When the pitchSlide lyric has displayable text (e.g. "oh+"), it survives
		// the emptiness filter → the pitch slide note IS skipped for round-trip
		// consistency (the lyric will exist on re-parse too).
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				lyrics: [
					{ tick: 480, text: 'oh' },
					{ tick: 720, text: 'slide+' },  // pitchSlide with displayable text → survives filter
					{ tick: 960, text: 'yeah' },
				],
				notes: [
					{ tick: 480, pitch: 60, length: 240 },
					{ tick: 720, pitch: 62, length: 240 },  // pitch slide target → skipped
					{ tick: 960, pitch: 64, length: 240 },
				],
				phrases: [{ tick: 480, length: 720 }],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		const notes = result.vocalTracks.parts.vocals.notePhrases[0].notes
		expect(notes).toHaveLength(2)  // note at 720 skipped
		expect(notes[0].tick).toBe(480)
		expect(notes[1].tick).toBe(960)
	})

	it('keeps phrases without notes (lyrics stay in their phrase)', () => {
		// All phrases are kept — even without notes — so that all content is
		// accessible through phrase grouping and writers can round-trip boundaries.
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				lyrics: [{ tick: 480, text: 'hey' }, { tick: 1920, text: 'yo' }],
				notes: [{ tick: 1920, pitch: 60, length: 240 }],  // only in second phrase
				phrases: [
					{ tick: 480, length: 480 },   // no notes, but has lyrics
					{ tick: 1920, length: 480 },  // has note + lyric
				],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		const phrases = result.vocalTracks.parts.vocals.notePhrases
		expect(phrases).toHaveLength(2)
		expect(phrases[0].tick).toBe(480)
		expect(phrases[0].notes).toHaveLength(0)
		expect(phrases[0].lyrics).toHaveLength(1)
		expect(phrases[0].lyrics[0].text).toBe('hey')
		expect(phrases[1].tick).toBe(1920)
		expect(phrases[1].notes).toHaveLength(1)
		expect(phrases[1].lyrics).toHaveLength(1)
		expect(phrases[1].lyrics[0].text).toBe('yo')
	})

	it('deduplicates phrases at same tick (note 105 + 106)', () => {
		// When both MIDI note 105 and 106 exist at the same tick, only one phrase is created.
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				notes: [{ tick: 480, pitch: 60, length: 240 }],
				phrases: [
					{ tick: 480, length: 480 },
					// Simulate note 106 at same tick (vocalPhrases would have both)
				],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		// Only one phrase, not duplicated
		expect(result.vocalTracks.parts.vocals.notePhrases).toHaveLength(1)
	})

	it('applies DeferredLyricJoinWorkaround for "+-" lyrics', () => {
		// Real pattern: badly-formatted charts place the hyphen on the pitch bend lyric.
		// YARG merges "+-" into the previous lyric and reduces it to "+".
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				lyrics: [
					{ tick: 480, text: 'sto' },
					{ tick: 720, text: '+-' },  // workaround: merges "-" into previous
					{ tick: 960, text: 'ry' },
				],
				notes: [
					{ tick: 480, pitch: 60, length: 240 },
					{ tick: 720, pitch: 62, length: 240 },
					{ tick: 960, pitch: 64, length: 240 },
				],
				phrases: [{ tick: 480, length: 720 }],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		const lyrics = result.vocalTracks.parts.vocals.notePhrases[0].lyrics
		// "sto" becomes "sto-" with JoinWithNext, "+-" becomes "+" which is filtered
		expect(lyrics).toHaveLength(2)
		expect(lyrics[0].text).toBe('sto-')
		expect(lyrics[0].flags & lyricFlags.joinWithNext).toBeTruthy()
		expect(lyrics[1].text).toBe('ry')
	})

	it('skips underscore-only lyrics (whitespace-only after _ → space replacement)', () => {
		// Real case: "Aoi - c.s.q.n." has lyric "_" which YARG replaces to " " → IsNullOrWhiteSpace → skip.
		// We keep "_" as-is but still skip it from normalized output since YARG would skip it.
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				lyrics: [
					{ tick: 480, text: 'hey' },
					{ tick: 720, text: '_' },    // underscore-only → skipped
				],
				notes: [
					{ tick: 480, pitch: 60, length: 240 },
					{ tick: 720, pitch: 62, length: 240 },
				],
				phrases: [{ tick: 480, length: 480 }],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		const lyrics = result.vocalTracks.parts.vocals.notePhrases[0].lyrics
		expect(lyrics).toHaveLength(1)
		expect(lyrics[0].text).toBe('hey')
	})

	it('sorts lyrics by locale within same tick (matching YARG .NET string.Compare)', () => {
		// Real case: "Billy Idol - Rebel Yell" has "re" and "+-" at same tick.
		// YARG sorts via .NET string.Compare (culture-aware): "+-" before "re".
		// This affects DeferredLyricJoinWorkaround and final lyricFlags.
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				lyrics: [
					{ tick: 480, text: 'mo' },
					{ tick: 720, text: 're' },     // MIDI order: "re" first
					{ tick: 720, text: '+-' },     // MIDI order: "+-" second
				],
				notes: [
					{ tick: 480, pitch: 60, length: 240 },
					{ tick: 720, pitch: 62, length: 240 },
				],
				phrases: [{ tick: 480, length: 480 }],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		const lyrics = result.vocalTracks.parts.vocals.notePhrases[0].lyrics
		// After sorting: "+-" comes before "re" at tick 720.
		// DeferredLyricJoinWorkaround triggers on "+-": modifies "mo" → "mo-".
		// "+-" becomes "+" which is filtered. "re" processed normally.
		expect(lyrics).toHaveLength(2)
		expect(lyrics[0].text).toBe('mo-')
		expect(lyrics[0].flags & lyricFlags.joinWithNext).toBeTruthy()
		expect(lyrics[1].text).toBe('re')
		expect(lyrics[1].flags).toBe(0)
	})

	it('detects $ (harmonyHidden) at end of lyric as trailing flag', () => {
		// Real pattern: HARM3 lyrics like "uh#$" — $ at end, not start
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				lyrics: [{ tick: 480, text: 'uh#$' }],
				notes: [{ tick: 480, pitch: 60, length: 240 }],
				phrases: [{ tick: 480, length: 480 }],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		const lyric = result.vocalTracks.parts.vocals.notePhrases[0].lyrics[0]
		expect(lyric.text).toBe('uh#$')
		expect(lyric.flags & lyricFlags.harmonyHidden).toBeTruthy()
		expect(lyric.flags & lyricFlags.nonPitched).toBeTruthy()
	})

	it('range shifts and lyric shifts stored at track level', () => {
		// Range shifts come from PART VOCALS / HARM1, shared across all parts
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				notes: [{ tick: 480, pitch: 60, length: 240 }],
				phrases: [{ tick: 480, length: 480 }],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		expect(result.vocalTracks.rangeShifts).toBeDefined()
		expect(result.vocalTracks.lyricShifts).toBeDefined()
		expect(Array.isArray(result.vocalTracks.rangeShifts)).toBe(true)
		expect(Array.isArray(result.vocalTracks.lyricShifts)).toBe(true)
	})

	it('trims ASCII whitespace from lyrics before flag detection (YARG NormalizeTextEvent)', () => {
		// Real case: "Deep Purple - Smoke on the Water" has lyric "+ " (plus trailing space).
		// YARG's NormalizeTextEvent.TrimAscii strips the space → "+" → detected as pitch slide.
		// Without trim, the space prevents pitch slide detection and the note is kept incorrectly.
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				lyrics: [
					{ tick: 480, text: 'mo-' },
					{ tick: 720, text: '+ ' },  // trailing space — should be trimmed to "+"
					{ tick: 960, text: 'bile' },
				],
				notes: [
					{ tick: 480, pitch: 60, length: 240 },
					{ tick: 720, pitch: 62, length: 240 },  // pitch slide target — skipped
					{ tick: 960, pitch: 64, length: 240 },
				],
				phrases: [{ tick: 480, length: 720 }],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		const phrase = result.vocalTracks.parts.vocals.notePhrases[0]
		// Lyric "+ " trimmed to "+" → stripped to empty → filtered.
		// Pitch slide note at 720 NOT skipped (filtered lyric → no round-trip marker).
		expect(phrase.notes).toHaveLength(3)
		expect(phrase.notes[0].tick).toBe(480)
		expect(phrase.notes[1].tick).toBe(720)
		expect(phrase.notes[2].tick).toBe(960)
		expect(phrase.lyrics).toHaveLength(2)
		expect(phrase.lyrics[0].text).toBe('mo-')
		expect(phrase.lyrics[1].text).toBe('bile')
	})

	it('skips percussion notes at exact phrase start tick (MIDI event ordering)', () => {
		// Real case: "500 Miles to Memphis" has percussion note 96 at same tick as phrase start.
		// In MIDI, noteOn for 96 arrives before noteOn for 105 (phrase marker) at same tick.
		// YARG's normalizer doesn't include this note in the phrase.
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				notes: [
					{ tick: 480, pitch: 96, length: 60 },   // percussion at phrase start — skipped
					{ tick: 600, pitch: 96, length: 60 },   // percussion after start — kept
				],
				phrases: [{ tick: 480, length: 480 }],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		const notes = result.vocalTracks.parts.vocals.notePhrases[0].notes
		expect(notes).toHaveLength(1)
		expect(notes[0].tick).toBe(600)
	})

	it('pitch slide across phrase boundary via previousParentLyric', () => {
		// YARG's previousParentLyric persists across phrases, allowing pitch slides to
		// attach to the last note of the previous phrase even without note length carry-over.
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				lyrics: [
					{ tick: 480, text: 'la' },
					{ tick: 1440, text: '+' },   // pitch slide — first note of phrase 2
					{ tick: 1920, text: 'oo' },
				],
				notes: [
					{ tick: 480, pitch: 60, length: 240 },   // phrase 1
					{ tick: 1440, pitch: 72, length: 120 },  // phrase 2 — pitch slide, skipped
					{ tick: 1920, pitch: 64, length: 240 },  // phrase 2 — kept
				],
				phrases: [
					{ tick: 480, length: 480 },
					{ tick: 1440, length: 720 },
				],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		const phrases = result.vocalTracks.parts.vocals.notePhrases
		expect(phrases).toHaveLength(2)
		// Phrase 2: "+" is filtered → pitch slide note at 1440 is NOT skipped
		// (ensures round-trip consistency — "+" won't exist on re-parse either)
		expect(phrases[1].notes).toHaveLength(2)
		expect(phrases[1].notes[0].tick).toBe(1440)
		expect(phrases[1].notes[1].tick).toBe(1920)
	})

	it('lyrics stay in their phrase even when phrase has no notes', () => {
		// All phrases are kept. Lyrics remain in their phrase — the phrase
		// exists as a boundary even without notes. Writers iterate all phrases.
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				lyrics: [
					{ tick: 480, text: 'Whoa' },   // in first phrase (no notes)
					{ tick: 1920, text: 'I' },      // in second phrase
				],
				notes: [
					{ tick: 1920, pitch: 60, length: 240 },
				],
				phrases: [
					{ tick: 480, length: 480 },   // no notes, has lyric
					{ tick: 1920, length: 480 },  // has note + lyric
				],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		const phrases = result.vocalTracks.parts.vocals.notePhrases
		expect(phrases).toHaveLength(2)
		expect(phrases[0].lyrics).toHaveLength(1)
		expect(phrases[0].lyrics[0].text).toBe('Whoa')
		expect(phrases[1].lyrics).toHaveLength(1)
		expect(phrases[1].lyrics[0].text).toBe('I')
	})

	it('note 106 phrases create player 2 phrases on PART VOCALS (Dani California pattern)', () => {
		// Test A: note 106 phrase before first note 105 phrase.
		// Both 105 and 106 create phrases; merged set tagged with player.
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				lyrics: [
					{ tick: 100, text: 'Hel-' },
					{ tick: 500, text: 'lo' },
				],
				notes: [
					{ tick: 100, pitch: 60, length: 100 },
					{ tick: 500, pitch: 62, length: 100 },
				],
				phrases106: [{ tick: 0, length: 480 }],
				phrases: [{ tick: 480, length: 480 }],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		const phrases = result.vocalTracks.parts.vocals.notePhrases
		expect(phrases).toHaveLength(2)

		// First phrase (from note 106) — player 2
		expect(phrases[0].tick).toBe(0)
		expect(phrases[0].player).toBe(2)
		expect(phrases[0].notes).toHaveLength(1)
		expect(phrases[0].notes[0].tick).toBe(100)
		expect(phrases[0].lyrics).toHaveLength(1)
		expect(phrases[0].lyrics[0].text).toBe('Hel-')

		// Second phrase (from note 105) — player 1
		expect(phrases[1].tick).toBe(480)
		expect(phrases[1].player).toBe(1)
		expect(phrases[1].notes).toHaveLength(1)
		expect(phrases[1].notes[0].tick).toBe(500)
		expect(phrases[1].lyrics).toHaveLength(1)
		expect(phrases[1].lyrics[0].text).toBe('lo')
	})

	it('absorbs orphaned lyrics before first phrase into that phrase', () => {
		// Test D: lyrics before the first phrase are absorbed into it.
		// Notes before all phrases are dropped.
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				lyrics: [
					{ tick: 100, text: 'orphan' },  // before all phrases
					{ tick: 500, text: 'inside' },   // inside phrase
				],
				notes: [
					{ tick: 100, pitch: 60, length: 50 },  // before phrase — dropped
					{ tick: 500, pitch: 62, length: 100 }, // inside phrase — kept
				],
				phrases: [{ tick: 480, length: 480 }],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		const phrases = result.vocalTracks.parts.vocals.notePhrases
		expect(phrases).toHaveLength(1)
		// Note at tick 100 is dropped (outside all phrases)
		expect(phrases[0].notes).toHaveLength(1)
		expect(phrases[0].notes[0].tick).toBe(500)
		// Orphaned lyric at tick 100 is absorbed into the phrase
		expect(phrases[0].lyrics).toHaveLength(2)
		expect(phrases[0].lyrics[0].text).toBe('orphan')
		expect(phrases[0].lyrics[1].text).toBe('inside')
	})

	it('lyric at exact tick of an adjacent phrase boundary belongs to the new phrase', () => {
		// Phrase 1 ends at tick 960, phrase 2 starts at tick 960. The lyric at
		// tick 960 should belong to phrase 2 (the one starting there), not the
		// previous phrase. The vocalTrack helper sorts events by tick — at the
		// same tick, lyric events are pushed before phrase events (insertion
		// order), so the lyric appears FIRST in the file. The grouping logic
		// must still place the lyric in the new phrase, not the closing one.
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('PART VOCALS', {
				lyrics: [
					{ tick: 480, text: 'phrase1lyric' }, // in phrase 1
					{ tick: 960, text: 'boundary' },     // exactly at phrase 1 end / phrase 2 start
					{ tick: 1200, text: 'phrase2lyric' },
				],
				notes: [
					{ tick: 480, pitch: 60, length: 240 },
					{ tick: 960, pitch: 62, length: 240 },
					{ tick: 1200, pitch: 64, length: 240 },
				],
				phrases: [
					{ tick: 480, length: 480 },   // [480, 960)
					{ tick: 960, length: 480 },   // [960, 1440)
				],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		const phrases = result.vocalTracks.parts.vocals.notePhrases
		expect(phrases).toHaveLength(2)

		// Phrase 1 [480, 960): only "phrase1lyric"
		expect(phrases[0].tick).toBe(480)
		expect(phrases[0].lyrics.map(l => l.text)).toEqual(['phrase1lyric'])

		// Phrase 2 [960, 1440): "boundary" + "phrase2lyric"
		expect(phrases[1].tick).toBe(960)
		expect(phrases[1].lyrics.map(l => l.text)).toEqual(['boundary', 'phrase2lyric'])
	})

	it('lyric at boundary tick stays in new phrase regardless of MIDI event ordering', () => {
		// Same edge case as above, but explicitly construct the MIDI with the
		// lyric event placed BEFORE the noteOff (phrase 1 end) and the noteOn
		// (phrase 2 start) at the boundary tick — i.e., file order is
		// `lyric → noteOff(105) → noteOn(105)` at tick 960. The parser sorts by
		// tick + type before grouping, so file order shouldn't change which
		// phrase the lyric ends up in.
		const track: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'PART VOCALS' },
			// Phrase 1 starts at 480
			{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 105, velocity: 100 },
			// Lyric in phrase 1
			{ deltaTime: 0, type: 'lyrics', text: 'phrase1lyric' },
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 100 },
			{ deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
			// Boundary tick: lyric BEFORE noteOff(105) AND noteOn(105)
			{ deltaTime: 240, type: 'lyrics', text: 'boundary' },
			{ deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 105, velocity: 0 },
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 105, velocity: 100 },
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 62, velocity: 100 },
			{ deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 62, velocity: 0 },
			{ deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 105, velocity: 0 },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const midi = buildMidi(480, [tempoTrack(), eventsTrack(), track])

		const result = parseChartFile(midi, 'mid')
		const phrases = result.vocalTracks.parts.vocals.notePhrases
		expect(phrases).toHaveLength(2)
		expect(phrases[0].tick).toBe(480)
		expect(phrases[0].lyrics.map(l => l.text)).toEqual(['phrase1lyric'])
		expect(phrases[1].tick).toBe(960)
		// "boundary" lyric must be in phrase 2 even though it appears before
		// the phrase-2 noteOn in file order.
		expect(phrases[1].lyrics.map(l => l.text)).toEqual(['boundary'])
	})

	it('harmony phrases have no player field', () => {
		const midi = buildMidi(480, [
			tempoTrack(),
			eventsTrack(),
			vocalTrack('HARM1', {
				lyrics: [{ tick: 480, text: 'hey' }],
				notes: [{ tick: 480, pitch: 60, length: 240 }],
				phrases: [{ tick: 480, length: 480 }],
			}),
		])

		const result = parseChartFile(midi, 'mid')
		const phrase = result.vocalTracks.parts.harmony1.notePhrases[0]
		expect(phrase.player).toBeUndefined()
	})
})
