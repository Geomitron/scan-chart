/**
 * Round-trip tests for writeMidiFile.
 *
 * All tests exercise the writer only through parseChartAndIni: build a
 * ParsedChart, write it out as MIDI, re-parse, and assert on the resulting
 * ParsedChart. No assertions about the raw MIDI structure (track count,
 * track names, note numbers, setTempo microseconds, text-event brackets,
 * etc.) — the parser is the source of truth for observable behavior.
 */

import type { MidiEvent } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { createEmptyChart } from '../chart/create-chart'
import { writeMidiFile } from '../chart/midi-writer'
import { noteFlags, noteTypes } from '../chart/note-parsing-interfaces'
import { parseChartAndIni, type ParsedChart } from '../chart/parse-chart-and-ini'

function roundTrip(chart: ParsedChart, iniText?: string): ParsedChart {
	const files: { fileName: string; data: Uint8Array }[] = [
		{ fileName: 'notes.mid', data: writeMidiFile(chart) },
	]
	if (iniText !== undefined) {
		files.push({ fileName: 'song.ini', data: new TextEncoder().encode(iniText) })
	}
	const result = parseChartAndIni(files)
	if (!result.parsedChart) {
		throw new Error(`round-trip produced no parsedChart: ${JSON.stringify(result.chartFolderIssues)}`)
	}
	return result.parsedChart
}

function emptyDrumTrack(
	difficulty: 'expert' | 'hard' | 'medium' | 'easy' = 'expert',
): ParsedChart['trackData'][number] {
	return {
		instrument: 'drums',
		difficulty,
		starPowerSections: [],
		rejectedStarPowerSections: [],
		soloSections: [],
		flexLanes: [],
		drumFreestyleSections: [],
		textEvents: [],
		versusPhrases: [],
		animations: [],
		unrecognizedMidiEvents: [],
		noteEventGroups: [],
	}
}

function note(tick: number, type: number, flags = 0, length = 0) {
	return { tick, type, flags, length, msTime: 0, msLength: 0 }
}

function findTrack(
	chart: ParsedChart,
	instrument: ParsedChart['trackData'][number]['instrument'],
	difficulty = 'expert',
) {
	const t = chart.trackData.find(t => t.instrument === instrument && t.difficulty === difficulty)
	if (!t) throw new Error(`no ${difficulty} ${instrument} track in round-tripped chart`)
	return t
}

function flatNotes(track: ParsedChart['trackData'][number]) {
	return track.noteEventGroups.flatMap(g =>
		g.map(n => ({ tick: n.tick, type: n.type, flags: n.flags, length: n.length })),
	)
}

const PRO_DRUMS_INI = '[Song]\npro_drums = True\n'

describe('writeMidiFile round-trip: resolution + [SyncTrack]', () => {
	it('preserves chart resolution', () => {
		const re = roundTrip(createEmptyChart({ resolution: 192 }))
		expect(re.resolution).toBe(192)
	})

	it('preserves the default tempo on an empty chart', () => {
		const re = roundTrip(createEmptyChart({ bpm: 120 }))
		expect(re.tempos.map(t => ({ tick: t.tick, bpm: Math.round(t.beatsPerMinute) }))).toEqual([{ tick: 0, bpm: 120 }])
	})

	it('preserves fractional BPM within microsecondsPerBeat rounding', () => {
		const re = roundTrip(createEmptyChart({ bpm: 137.5 }))
		expect(re.tempos[0].beatsPerMinute).toBeCloseTo(137.5, 1)
	})

	it('preserves multiple tempo changes at their ticks', () => {
		const chart = createEmptyChart({ resolution: 480, bpm: 120 })
		chart.tempos.push({ tick: 960, beatsPerMinute: 180, msTime: 0 })
		const re = roundTrip(chart)
		expect(re.tempos.map(t => ({ tick: t.tick, bpm: Math.round(t.beatsPerMinute) }))).toEqual([
			{ tick: 0, bpm: 120 },
			{ tick: 960, bpm: 180 },
		])
	})

	it('preserves non-4/4 time signatures', () => {
		const chart = createEmptyChart({ timeSignature: { numerator: 6, denominator: 8 } })
		expect(roundTrip(chart).timeSignatures[0]).toMatchObject({ numerator: 6, denominator: 8 })
	})

	it('preserves multiple time-signature changes', () => {
		const chart = createEmptyChart({ timeSignature: { numerator: 7, denominator: 8 } })
		chart.timeSignatures.push({ tick: 3840, numerator: 3, denominator: 4, msTime: 0, msLength: 0 })
		const re = roundTrip(chart)
		expect(re.timeSignatures.map(ts => ({ t: ts.tick, n: ts.numerator, d: ts.denominator }))).toEqual([
			{ t: 0, n: 7, d: 8 },
			{ t: 3840, n: 3, d: 4 },
		])
	})
})

describe('writeMidiFile round-trip: EVENTS track', () => {
	it('preserves sections at the right ticks with correct names', () => {
		const chart = createEmptyChart()
		chart.sections.push({ tick: 0, name: 'Intro', msTime: 0, msLength: 0 })
		chart.sections.push({ tick: 1920, name: 'Verse 1', msTime: 0, msLength: 0 })
		const re = roundTrip(chart)
		expect(re.sections.map(s => ({ tick: s.tick, name: s.name }))).toEqual([
			{ tick: 0, name: 'Intro' },
			{ tick: 1920, name: 'Verse 1' },
		])
	})

	it('preserves end events', () => {
		const chart = createEmptyChart()
		chart.endEvents.push({ tick: 1920, msTime: 0, msLength: 0 })
		expect(roundTrip(chart).endEvents.map(e => e.tick)).toEqual([1920])
	})

	it('preserves unrecognized EVENTS events on .mid source', () => {
		const chart = createEmptyChart({ format: 'mid' })
		chart.unrecognizedEventsTrackTextEvents.push({ tick: 480, text: 'crowd_noclap', msTime: 0, msLength: 0 })
		const re = roundTrip(chart)
		expect(re.unrecognizedEventsTrackTextEvents.map(e => ({ tick: e.tick, text: e.text }))).toEqual([
			{ tick: 480, text: 'crowd_noclap' },
		])
	})
})

describe('writeMidiFile round-trip: unrecognized MIDI tracks', () => {
	it('preserves an unrecognized track by name', () => {
		const chart = createEmptyChart()
		chart.unrecognizedMidiTracks.push({
			trackName: 'CUSTOM',
			events: [
				{ deltaTime: 0, meta: true, type: 'trackName', text: 'CUSTOM' } as MidiEvent,
				{ deltaTime: 240, meta: true, type: 'text', text: 'hello' } as MidiEvent,
				{ deltaTime: 240, meta: true, type: 'endOfTrack' } as MidiEvent,
			],
		})
		expect(roundTrip(chart).unrecognizedMidiTracks.map(t => t.trackName)).toEqual(['CUSTOM'])
	})

	it('preserves multiple unrecognized tracks with the same name', () => {
		const chart = createEmptyChart()
		for (let i = 0; i < 3; i++) {
			chart.unrecognizedMidiTracks.push({
				trackName: 'CUSTOM',
				events: [
					{ deltaTime: 0, meta: true, type: 'trackName', text: 'CUSTOM' } as MidiEvent,
					{ deltaTime: 0, meta: true, type: 'endOfTrack' } as MidiEvent,
				],
			})
		}
		expect(roundTrip(chart).unrecognizedMidiTracks).toHaveLength(3)
	})
})

describe('writeMidiFile round-trip: drum tracks', () => {
	it('preserves base 4-lane drum notes at the right ticks', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.kick)])
		td.noteEventGroups.push([note(120, noteTypes.redDrum)])
		td.noteEventGroups.push([note(240, noteTypes.yellowDrum)])
		td.noteEventGroups.push([note(360, noteTypes.blueDrum)])
		td.noteEventGroups.push([note(480, noteTypes.greenDrum)])
		chart.trackData.push(td)
		const notes = flatNotes(findTrack(roundTrip(chart), 'drums'))
		expect(notes.map(n => ({ tick: n.tick, type: n.type }))).toEqual([
			{ tick: 0, type: noteTypes.kick },
			{ tick: 120, type: noteTypes.redDrum },
			{ tick: 240, type: noteTypes.yellowDrum },
			{ tick: 360, type: noteTypes.blueDrum },
			{ tick: 480, type: noteTypes.greenDrum },
		])
	})

	it('preserves tracks across all difficulties on a single chart', () => {
		const chart = createEmptyChart({ format: 'mid' })
		for (const d of ['expert', 'hard', 'medium', 'easy'] as const) {
			const td = emptyDrumTrack(d)
			td.noteEventGroups.push([note(0, noteTypes.kick)])
			chart.trackData.push(td)
		}
		const re = roundTrip(chart)
		for (const d of ['expert', 'hard', 'medium', 'easy'] as const) {
			expect(findTrack(re, 'drums', d).noteEventGroups).toHaveLength(1)
		}
	})

	it('preserves double-kick (not as a regular kick)', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.kick, noteFlags.doubleKick)])
		chart.trackData.push(td)
		const notes = flatNotes(findTrack(roundTrip(chart), 'drums'))
		expect(notes).toHaveLength(1)
		expect(notes[0].flags & noteFlags.doubleKick).toBeTruthy()
	})

	it('preserves accent and ghost flags', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.redDrum, noteFlags.accent)])
		td.noteEventGroups.push([note(240, noteTypes.yellowDrum, noteFlags.ghost)])
		chart.trackData.push(td)
		const notes = flatNotes(findTrack(roundTrip(chart), 'drums'))
		expect(notes[0].flags & noteFlags.accent).toBeTruthy()
		expect(notes[1].flags & noteFlags.ghost).toBeTruthy()
	})

	it('preserves cymbal/tom distinction in fourLanePro', () => {
		const chart = createEmptyChart({ format: 'mid' })
		chart.drumType = 1 // fourLanePro
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.yellowDrum, noteFlags.cymbal)])
		td.noteEventGroups.push([note(120, noteTypes.yellowDrum, noteFlags.tom)])
		td.noteEventGroups.push([note(240, noteTypes.blueDrum, noteFlags.cymbal)])
		td.noteEventGroups.push([note(360, noteTypes.blueDrum, noteFlags.tom)])
		td.noteEventGroups.push([note(480, noteTypes.greenDrum, noteFlags.cymbal)])
		td.noteEventGroups.push([note(600, noteTypes.greenDrum, noteFlags.tom)])
		chart.trackData.push(td)
		const notes = flatNotes(findTrack(roundTrip(chart, PRO_DRUMS_INI), 'drums'))
		expect(notes[0].flags & noteFlags.cymbal).toBeTruthy()
		expect(notes[1].flags & noteFlags.tom).toBeTruthy()
		expect(notes[2].flags & noteFlags.cymbal).toBeTruthy()
		expect(notes[3].flags & noteFlags.tom).toBeTruthy()
		expect(notes[4].flags & noteFlags.cymbal).toBeTruthy()
		expect(notes[5].flags & noteFlags.tom).toBeTruthy()
	})

	it('preserves the flam flag on a chord group', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([
			note(0, noteTypes.redDrum, noteFlags.flam),
			note(0, noteTypes.yellowDrum, noteFlags.flam),
		])
		chart.trackData.push(td)
		const group = findTrack(roundTrip(chart), 'drums').noteEventGroups[0]
		expect(group.some(n => (n.flags & noteFlags.flam) !== 0)).toBe(true)
	})

	it('preserves star power, solo sections, flex lanes, and activation lanes', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.kick)])
		td.starPowerSections.push({ tick: 0, length: 960, msTime: 0, msLength: 0 })
		td.soloSections.push({ tick: 480, length: 480, msTime: 0, msLength: 0 })
		td.flexLanes.push({ tick: 960, length: 480, isDouble: false, msTime: 0, msLength: 0 })
		td.flexLanes.push({ tick: 1440, length: 480, isDouble: true, msTime: 0, msLength: 0 })
		td.drumFreestyleSections.push({ tick: 1920, length: 480, isCoda: false, msTime: 0, msLength: 0 })
		chart.trackData.push(td)
		const reTrack = findTrack(roundTrip(chart), 'drums')
		expect(reTrack.starPowerSections.map(s => ({ t: s.tick, l: s.length }))).toEqual([{ t: 0, l: 960 }])
		expect(reTrack.soloSections.map(s => ({ t: s.tick, l: s.length }))).toEqual([{ t: 480, l: 480 }])
		expect(reTrack.flexLanes.map(f => ({ t: f.tick, l: f.length, d: f.isDouble }))).toEqual([
			{ t: 960, l: 480, d: false },
			{ t: 1440, l: 480, d: true },
		])
		expect(reTrack.drumFreestyleSections.map(s => ({ t: s.tick, l: s.length }))).toEqual([{ t: 1920, l: 480 }])
	})
})


// ---------------------------------------------------------------------------
// Fret / GHL track tests
// ---------------------------------------------------------------------------

function emptyFretTrack(
	instrument: ParsedChart['trackData'][number]['instrument'] = 'guitar',
	difficulty: 'expert' | 'hard' | 'medium' | 'easy' = 'expert',
): ParsedChart['trackData'][number] {
	return {
		instrument,
		difficulty,
		starPowerSections: [],
		rejectedStarPowerSections: [],
		soloSections: [],
		flexLanes: [],
		drumFreestyleSections: [],
		textEvents: [],
		versusPhrases: [],
		animations: [],
		unrecognizedMidiEvents: [],
		noteEventGroups: [],
	}
}

describe('writeMidiFile round-trip: 5-fret tracks', () => {
	it('preserves all five fret colors on a guitar track', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyFretTrack('guitar', 'expert')
		td.noteEventGroups.push([note(0, noteTypes.green)])
		td.noteEventGroups.push([note(120, noteTypes.red)])
		td.noteEventGroups.push([note(240, noteTypes.yellow)])
		td.noteEventGroups.push([note(360, noteTypes.blue)])
		td.noteEventGroups.push([note(480, noteTypes.orange)])
		chart.trackData.push(td)
		const notes = flatNotes(findTrack(roundTrip(chart), 'guitar'))
		expect(notes.map(n => ({ tick: n.tick, type: n.type }))).toEqual([
			{ tick: 0, type: noteTypes.green },
			{ tick: 120, type: noteTypes.red },
			{ tick: 240, type: noteTypes.yellow },
			{ tick: 360, type: noteTypes.blue },
			{ tick: 480, type: noteTypes.orange },
		])
	})

	it('preserves tracks at all difficulties', () => {
		const chart = createEmptyChart({ format: 'mid' })
		for (const d of ['expert', 'hard', 'medium', 'easy'] as const) {
			const td = emptyFretTrack('guitar', d)
			td.noteEventGroups.push([note(0, noteTypes.green)])
			chart.trackData.push(td)
		}
		const re = roundTrip(chart)
		for (const d of ['expert', 'hard', 'medium', 'easy'] as const) {
			expect(findTrack(re, 'guitar', d).noteEventGroups).toHaveLength(1)
		}
	})

	it('preserves a plain open note (not in a chord)', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyFretTrack('guitar', 'expert')
		td.noteEventGroups.push([note(0, noteTypes.open)])
		chart.trackData.push(td)
		const notes = flatNotes(findTrack(roundTrip(chart), 'guitar'))
		expect(notes.map(n => n.type)).toEqual([noteTypes.open])
	})

	it('preserves an open-in-chord group (ENHANCED_OPENS path)', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyFretTrack('guitar', 'expert')
		td.noteEventGroups.push([note(0, noteTypes.open), note(0, noteTypes.red)])
		chart.trackData.push(td)
		const group = findTrack(roundTrip(chart), 'guitar').noteEventGroups[0]
		expect(group.map(n => n.type).sort()).toEqual([noteTypes.open, noteTypes.red].sort())
	})

	it('preserves a forced-hopo flag on a note whose natural state is strum', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		const td = emptyFretTrack('guitar', 'expert')
		td.noteEventGroups.push([note(0, noteTypes.green)])
		td.noteEventGroups.push([note(1920, noteTypes.green, noteFlags.hopo)])
		chart.trackData.push(td)
		const notes = flatNotes(findTrack(roundTrip(chart), 'guitar'))
		expect(notes.find(n => n.tick === 1920)!.flags & noteFlags.hopo).toBeTruthy()
	})

	it('preserves a forced-strum flag on a note whose natural state is hopo', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		const td = emptyFretTrack('guitar', 'expert')
		td.noteEventGroups.push([note(0, noteTypes.green)])
		td.noteEventGroups.push([note(120, noteTypes.red, noteFlags.strum)])
		chart.trackData.push(td)
		const notes = flatNotes(findTrack(roundTrip(chart), 'guitar'))
		expect(notes.find(n => n.tick === 120)!.flags & noteFlags.strum).toBeTruthy()
	})

	it('preserves the tap flag', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyFretTrack('guitar', 'expert')
		td.noteEventGroups.push([note(0, noteTypes.green, noteFlags.tap)])
		chart.trackData.push(td)
		const notes = flatNotes(findTrack(roundTrip(chart), 'guitar'))
		expect(notes[0].flags & noteFlags.tap).toBeTruthy()
	})

	it('preserves star power and solo sections on a guitar track', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyFretTrack('guitar', 'expert')
		td.noteEventGroups.push([note(0, noteTypes.green)])
		td.starPowerSections.push({ tick: 0, length: 480, msTime: 0, msLength: 0 })
		td.soloSections.push({ tick: 480, length: 240, msTime: 0, msLength: 0 })
		chart.trackData.push(td)
		const reTrack = findTrack(roundTrip(chart), 'guitar')
		expect(reTrack.starPowerSections.map(s => ({ t: s.tick, l: s.length }))).toEqual([{ t: 0, l: 480 }])
		expect(reTrack.soloSections.map(s => ({ t: s.tick, l: s.length }))).toEqual([{ t: 480, l: 240 }])
	})

	// MIDI note 120 is the Big Rock Ending / coda activation marker. It can
	// appear on fret tracks (e.g. PART GUITAR/BASS) as well as drums; the
	// parser captures it in `drumFreestyleSections` per track and the fret
	// writer emits it back so trackHashes are stable across round-trip.
	it('preserves drumFreestyleSections (BRE/coda) on a fret track', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyFretTrack('guitar', 'expert')
		td.noteEventGroups.push([note(0, noteTypes.green)])
		td.drumFreestyleSections.push({ tick: 1920, length: 480, isCoda: true, msTime: 0, msLength: 0 })
		chart.trackData.push(td)
		const reTrack = findTrack(roundTrip(chart), 'guitar')
		expect(reTrack.drumFreestyleSections.map(s => ({ t: s.tick, l: s.length, isCoda: s.isCoda })))
			.toEqual([{ t: 1920, l: 480, isCoda: true }])
	})

	// Open notes encoded via the forceOpen SysEx share MIDI 96 with green.
	// When an open's tick range overlaps a green's, the writer must use
	// ENHANCED_OPENS so opens get their own MIDI number — otherwise the two
	// note-96 noteOn/noteOff pairs re-pair wrong on parse and swap lengths.
	it('preserves overlapping open + green sustains without swapping lengths', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		const td = emptyFretTrack('guitar', 'expert')
		td.noteEventGroups.push([note(0, noteTypes.green, noteFlags.strum, 1680)])
		td.noteEventGroups.push([note(960, noteTypes.open, noteFlags.strum, 1680)])
		chart.trackData.push(td)
		const notes = flatNotes(findTrack(roundTrip(chart), 'guitar'))
		const green = notes.find(n => n.type === noteTypes.green)!
		const open = notes.find(n => n.type === noteTypes.open)!
		expect({ tick: green.tick, length: green.length }).toEqual({ tick: 0, length: 1680 })
		expect({ tick: open.tick, length: open.length }).toEqual({ tick: 960, length: 1680 })
	})
})

describe('writeMidiFile round-trip: GHL (6-fret) tracks', () => {
	it('preserves all six GHL fret colors', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyFretTrack('guitarghl', 'expert')
		td.noteEventGroups.push([note(0, noteTypes.white1)])
		td.noteEventGroups.push([note(120, noteTypes.white2)])
		td.noteEventGroups.push([note(240, noteTypes.white3)])
		td.noteEventGroups.push([note(360, noteTypes.black1)])
		td.noteEventGroups.push([note(480, noteTypes.black2)])
		td.noteEventGroups.push([note(600, noteTypes.black3)])
		chart.trackData.push(td)
		const notes = flatNotes(findTrack(roundTrip(chart), 'guitarghl'))
		expect(notes.map(n => ({ tick: n.tick, type: n.type }))).toEqual([
			{ tick: 0, type: noteTypes.white1 },
			{ tick: 120, type: noteTypes.white2 },
			{ tick: 240, type: noteTypes.white3 },
			{ tick: 360, type: noteTypes.black1 },
			{ tick: 480, type: noteTypes.black2 },
			{ tick: 600, type: noteTypes.black3 },
		])
	})

	it('preserves a chord of open + white1 on GHL (ENHANCED_OPENS path)', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyFretTrack('guitarghl', 'expert')
		td.noteEventGroups.push([note(0, noteTypes.open), note(0, noteTypes.white1)])
		chart.trackData.push(td)
		const group = findTrack(roundTrip(chart), 'guitarghl').noteEventGroups[0]
		expect(group.map(n => n.type).sort()).toEqual([noteTypes.open, noteTypes.white1].sort())
	})
})

// ---------------------------------------------------------------------------
// Vocal track round-trip tests
// ---------------------------------------------------------------------------

function phrase(tick: number, length: number, opts: {
	player?: 1 | 2
	lyrics?: { tick: number; text: string }[]
	notes?: { tick: number; length: number; pitch: number; type?: 'pitched' | 'percussion' }[]
} = {}) {
	return {
		tick,
		length,
		msTime: 0,
		msLength: 0,
		isPercussion: false,
		player: opts.player,
		notes: (opts.notes ?? []).map(n => ({ ...n, msTime: 0, msLength: 0, type: n.type ?? ('pitched' as const) })),
		lyrics: (opts.lyrics ?? []).map(l => ({ ...l, msTime: 0, flags: 0 })),
	}
}

const EMPTY_VOCAL_PART = {
	notePhrases: [],
	staticLyricPhrases: [],
	starPowerSections: [],
	rangeShifts: [],
	lyricShifts: [],
	textEvents: [],
}

describe('writeMidiFile round-trip: vocal tracks', () => {
	it('emits no vocal part when none is set', () => {
		const chart = createEmptyChart({ format: 'mid' })
		expect(roundTrip(chart).vocalTracks.parts.vocals).toBeUndefined()
	})

	it('preserves PART VOCALS with a phrase, a note, and lyrics', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		chart.vocalTracks.parts.vocals = {
			...EMPTY_VOCAL_PART,
			notePhrases: [phrase(0, 960, {
				lyrics: [{ tick: 0, text: 'Hel-' }, { tick: 240, text: 'lo' }],
				notes: [
					{ tick: 0, length: 240, pitch: 60 },
					{ tick: 240, length: 240, pitch: 62 },
				],
			})],
		}
		const vocals = roundTrip(chart).vocalTracks.parts.vocals
		expect(vocals).toBeDefined()
		expect(vocals.notePhrases).toHaveLength(1)
		expect(vocals.notePhrases[0].lyrics.map(l => ({ tick: l.tick, text: l.text }))).toEqual([
			{ tick: 0, text: 'Hel-' },
			{ tick: 240, text: 'lo' },
		])
		expect(vocals.notePhrases[0].notes.map(n => ({ tick: n.tick, pitch: n.pitch }))).toEqual([
			{ tick: 0, pitch: 60 },
			{ tick: 240, pitch: 62 },
		])
	})

	it('preserves player-2 phrases', () => {
		const chart = createEmptyChart({ format: 'mid' })
		chart.vocalTracks.parts.vocals = {
			...EMPTY_VOCAL_PART,
			notePhrases: [
				phrase(0, 480, { player: 1 }),
				phrase(480, 480, { player: 2 }),
			],
		}
		const vocals = roundTrip(chart).vocalTracks.parts.vocals
		expect(vocals.notePhrases).toHaveLength(2)
		const p2 = vocals.notePhrases.find(p => p.player === 2)
		expect(p2).toBeDefined()
	})

	it('preserves HARM1 / HARM2 / HARM3 parts', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		chart.vocalTracks.parts.harmony1 = {
			...EMPTY_VOCAL_PART,
			notePhrases: [phrase(0, 960, {
				lyrics: [{ tick: 0, text: 'harm1' }],
				notes: [{ tick: 0, length: 240, pitch: 60 }],
			})],
		}
		chart.vocalTracks.parts.harmony2 = {
			...EMPTY_VOCAL_PART,
			staticLyricPhrases: [phrase(0, 960, {
				lyrics: [{ tick: 0, text: 'harm2' }],
				notes: [{ tick: 0, length: 240, pitch: 62 }],
			})],
		}
		chart.vocalTracks.parts.harmony3 = {
			...EMPTY_VOCAL_PART,
			staticLyricPhrases: [phrase(0, 960, {
				lyrics: [{ tick: 0, text: 'harm3' }],
				notes: [{ tick: 0, length: 240, pitch: 64 }],
			})],
		}
		const parts = roundTrip(chart).vocalTracks.parts
		expect(parts.harmony1).toBeDefined()
		expect(parts.harmony2).toBeDefined()
		expect(parts.harmony3).toBeDefined()
		expect(parts.harmony1.notePhrases[0].lyrics[0].text).toBe('harm1')
		expect(parts.harmony2.staticLyricPhrases[0].lyrics.map(l => l.text)).toContain('harm2')
		expect(parts.harmony3.staticLyricPhrases[0].lyrics.map(l => l.text)).toContain('harm3')
	})

	it('preserves vocal star power on PART VOCALS', () => {
		const chart = createEmptyChart({ format: 'mid' })
		chart.vocalTracks.parts.vocals = {
			...EMPTY_VOCAL_PART,
			notePhrases: [phrase(0, 480)],
			starPowerSections: [{ tick: 0, length: 480, msTime: 0, msLength: 0 }],
		}
		const vocals = roundTrip(chart).vocalTracks.parts.vocals
		expect(vocals.starPowerSections.map(s => ({ t: s.tick, l: s.length }))).toEqual([{ t: 0, l: 480 }])
	})

	it('preserves rangeShifts and lyricShifts', () => {
		const chart = createEmptyChart({ format: 'mid' })
		chart.vocalTracks.parts.vocals = {
			...EMPTY_VOCAL_PART,
			notePhrases: [phrase(0, 960)],
			rangeShifts: [{ tick: 0, length: 480, msTime: 0, msLength: 0 }],
			lyricShifts: [{ tick: 480, length: 480, msTime: 0, msLength: 0 }],
		}
		const vocals = roundTrip(chart).vocalTracks.parts.vocals
		expect(vocals.rangeShifts.map(s => s.tick)).toContain(0)
		expect(vocals.lyricShifts.map(s => s.tick)).toContain(480)
	})

	it('preserves vocal text events', () => {
		const chart = createEmptyChart({ format: 'mid' })
		chart.vocalTracks.parts.vocals = {
			...EMPTY_VOCAL_PART,
			notePhrases: [phrase(0, 960)],
			textEvents: [
				{ tick: 0, msTime: 0, text: '[idle]' },
				{ tick: 480, msTime: 0, text: '[mellow]' },
			],
		}
		const vocals = roundTrip(chart).vocalTracks.parts.vocals
		expect(vocals.textEvents.map(t => ({ tick: t.tick, text: t.text }))).toEqual([
			{ tick: 0, text: '[idle]' },
			{ tick: 480, text: '[mellow]' },
		])
	})
})
