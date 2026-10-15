/**
 * Round-trip tests for writeMidiFile.
 *
 * Most tests exercise the writer through parseChartAndIni: build a
 * ParsedChart, write it out as MIDI, re-parse, and assert on the resulting
 * ParsedChart. Where scan-chart reads a file the same either way but another
 * reader doesn't (a note number YARG or Rock Band reads, a marker Clone Hero
 * 1.1 reads), a test checks the written events themselves.
 */

import { type MidiEvent, parseMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { createEmptyChart } from 'src/chart/create-chart'
import { writeChartFile } from 'src/chart/chart-writer'
import { midiSustainCutoff, writeMidiFile } from 'src/chart/midi-writer'
import { writeChartFolder } from 'src/chart/chart-document'
import { noteFlags, type NoteType, noteTypes } from 'src/chart/types'
import { drumTypes } from 'src/types'
import { parseChartAndIni, type ParsedChart } from 'src/chart/parse-chart-and-ini'
import { parseChartFile, parseChartFileFrozenLegacyIdentity } from 'src/chart/parse-chart-file'
import { readMidiTokens } from 'src/chart/midi-tokens'
import { readMidiFile } from 'src/chart/midi-file-parser'
import { scanVocalTrack } from 'src/chart/lyric-parser'
import { chartSpellingIssues } from 'src/spelling-issues'

import { midiFile, midiNote, midiText } from './helpers/midi-files'

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

/** A `.mid` file with one track besides the tempo track: `trackName`, with text or lyric events and notes (`[tick, note, length = 0]`). */
function trackMidi(trackName: string, texts: { tick: number; text: string; type?: 'text' | 'lyrics' }[], notes: [number, number, number?][]): Uint8Array {
	return midiFile([{
		name: trackName,
		events: [...texts.map(({ tick, text, type }) => midiText(tick, text, type)), ...notes.flatMap(([tick, noteNumber, length]) => midiNote(tick, noteNumber, length))],
	}])
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

function note(tick: number, type: NoteType, flags = 0, length = 0) {
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
		chart.unrecognized.eventsTrackTextEvents.push({ tick: 480, text: 'crowd_noclap', msTime: 0, msLength: 0 })
		const re = roundTrip(chart)
		expect(re.unrecognized.eventsTrackTextEvents.map(e => ({ tick: e.tick, text: e.text }))).toEqual([
			{ tick: 480, text: 'crowd_noclap' },
		])
	})
})

describe('writeMidiFile round-trip: unrecognized MIDI tracks', () => {
	it('preserves an unrecognized track by name', () => {
		const chart = createEmptyChart()
		chart.unrecognized.midiTracks.push({
			trackName: 'CUSTOM',
			events: [
				{ deltaTime: 0, meta: true, type: 'trackName', text: 'CUSTOM' } as MidiEvent,
				{ deltaTime: 240, meta: true, type: 'text', text: 'hello' } as MidiEvent,
				{ deltaTime: 240, meta: true, type: 'endOfTrack' } as MidiEvent,
			],
		})
		expect(roundTrip(chart).unrecognized.midiTracks.map(t => t.trackName)).toEqual(['CUSTOM'])
	})

	it('preserves multiple unrecognized tracks with the same name', () => {
		const chart = createEmptyChart()
		for (let i = 0; i < 3; i++) {
			chart.unrecognized.midiTracks.push({
				trackName: 'CUSTOM',
				events: [
					{ deltaTime: 0, meta: true, type: 'trackName', text: 'CUSTOM' } as MidiEvent,
					{ deltaTime: 0, meta: true, type: 'endOfTrack' } as MidiEvent,
				],
			})
		}
		expect(roundTrip(chart).unrecognized.midiTracks).toHaveLength(3)
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

	it('writes a drum fill the track has twice twice, in both formats, and a fill on several difficulties once', () => {
		const chart = createEmptyChart({ format: 'mid' })
		for (const difficulty of ['expert', 'hard'] as const) {
			const td = emptyDrumTrack(difficulty)
			td.noteEventGroups.push([note(0, noteTypes.kick)], [note(480, noteTypes.redDrum)])
			td.drumFreestyleSections.push({ tick: 480, length: 240, isCoda: false, msTime: 0, msLength: 0 })
			if (difficulty === 'expert') td.drumFreestyleSections.push({ tick: 480, length: 240, isCoda: false, msTime: 0, msLength: 0 })
			chart.trackData.push(td)
		}
		const fills = (parsed: ParsedChart, difficulty: string) => findTrack(parsed, 'drums', difficulty).drumFreestyleSections.map(fill => [fill.tick, fill.length])
		const asMidi = roundTrip(chart)
		expect(fills(asMidi, 'expert')).toEqual([[480, 240], [480, 240]])
		const asChart = parseChartAndIni([{ fileName: 'notes.chart', data: new TextEncoder().encode(writeChartFile({ ...chart, format: 'chart' })) }]).parsedChart!
		expect(fills(asChart, 'expert')).toEqual([[480, 240], [480, 240]])
		expect(fills(asChart, 'hard')).toEqual([[480, 240]])
	})

	it('preserves the accent of a sustained note at tick 0: [ENABLE_CHART_DYNAMICS] comes before it', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.redDrum, noteFlags.accent, 240)])
		chart.trackData.push(td)
		const notes = flatNotes(findTrack(roundTrip(chart), 'drums'))
		expect(notes[0].flags & noteFlags.accent).toBeTruthy()
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

	it('keeps a pro chart pro when every yellow, blue and green note is a cymbal and no tick has only kick or red', () => {
		const chart = createEmptyChart({ format: 'mid' })
		chart.drumType = drumTypes.fourLanePro
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push(
			[note(0, noteTypes.kick), note(0, noteTypes.yellowDrum, noteFlags.cymbal), note(0, noteTypes.greenDrum, noteFlags.cymbal)],
			[note(480, noteTypes.redDrum, noteFlags.tom), note(480, noteTypes.yellowDrum, noteFlags.cymbal)],
			[note(960, noteTypes.kick), note(960, noteTypes.blueDrum, noteFlags.cymbal)],
		)
		chart.trackData.push(td)
		const re = roundTrip(chart)
		expect(re.drumType).toBe(drumTypes.fourLanePro)
		expect(flatNotes(findTrack(re, 'drums'))).toEqual(flatNotes(td))
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

	it('writes back the mix events it read, with their stem configuration, and adds one where an edit changed a flip', () => {
		const mix = (tick: number, text: string) => ({ tick, text })
		const source = trackMidi('PART DRUMS', [
			mix(0, '[mix 3 drums2]'), mix(0, '[mix 0 drums4]'), mix(480, '[mix 3 drums2d]'), mix(1440, '[mix 3 drums2]'), mix(1920, '[mix 3 drums2easy]'),
		], [[0, 97], [0, 98], [480, 97], [480, 98], [720, 96], [960, 97], [1440, 97], [1920, 98], [0, 61]])
		const parsed = parseChartAndIni([{ fileName: 'notes.mid', data: source }]).parsedChart!
		const mixEvents = (data: Uint8Array) => parseMidi(data).tracks.flatMap(track => {
			let tick = 0
			return track.flatMap(event => (tick += event.deltaTime, event.type === 'text' && event.text.startsWith('[mix') ? [[tick, event.text]] : []))
		})
		const discoTicks = (chart: ParsedChart) => flatNotes(findTrack(chart, 'drums')).filter(n => n.flags & noteFlags.disco).map(n => n.tick)
		const written = writeMidiFile(parsed)
		expect(mixEvents(written)).toEqual(mixEvents(source))
		const reparsed = parseChartAndIni([{ fileName: 'notes.mid', data: written }]).parsedChart!
		expect(discoTicks(reparsed)).toEqual([480, 480, 960])
		expect(findTrack(reparsed, 'drums').drumMixes).toEqual(findTrack(parsed, 'drums').drumMixes)

		// An edit takes the flip off the red note at 960.
		for (const n of findTrack(parsed, 'drums').noteEventGroups.flat()) if (n.tick === 960) n.flags &= ~noteFlags.disco
		const edited = writeMidiFile(parsed)
		expect(mixEvents(edited)).toEqual([[0, '[mix 3 drums2]'], [0, '[mix 0 drums4]'], [480, '[mix 3 drums2d]'], [960, '[mix 3 drums2]'], [1440, '[mix 3 drums2]'], [1920, '[mix 3 drums2easy]']])
		expect(discoTicks(parseChartAndIni([{ fileName: 'notes.mid', data: edited }]).parsedChart!)).toEqual([480, 480])
	})

	it('writes back a tom marker that covers no note, which makes Clone Hero 1.1 read the chart as pro drums', () => {
		// Yellow at 0 under a tom marker, and a yellow tom marker over no note.
		const source = trackMidi('PART DRUMS', [], [[0, 98], [0, 110, 1], [960, 97], [1440, 110, 240]])
		const parsed = parseChartAndIni([{ fileName: 'notes.mid', data: source }]).parsedChart!
		const tomMarkers = (data: Uint8Array) => parseMidi(data).tracks.flatMap(track => {
			let tick = 0
			return track.flatMap(event => (tick += event.deltaTime, event.type === 'noteOn' && event.noteNumber === 110 ? [tick] : []))
		})
		const written = writeMidiFile(parsed)
		expect(tomMarkers(written)).toEqual([0, 1440])
		const reparsed = parseChartAndIni([{ fileName: 'notes.mid', data: written }]).parsedChart!
		expect(reparsed.drumType).toBe(parsed.drumType)
		expect(flatNotes(findTrack(reparsed, 'drums'))).toEqual(flatNotes(findTrack(parsed, 'drums')))
		expect(tomMarkers(writeMidiFile(reparsed))).toEqual([0, 1440])

		// Over no note at all, the marker leaves the chart 4-lane in scan-chart, and is still written.
		const uncoveredOnly = parseChartAndIni([{ fileName: 'notes.mid', data: trackMidi('PART DRUMS', [], [[0, 98], [480, 111, 60]]) }]).parsedChart!
		expect(uncoveredOnly.drumType).toBe(drumTypes.fourLane)
		expect(parseMidi(writeMidiFile(uncoveredOnly)).tracks.flat().some(event => event.type === 'noteOn' && event.noteNumber === 111)).toBe(true)
	})

	it('ends a kept tom marker before a written one starts at its end, and keeps a zero-length verbatim note', () => {
		// A yellow tom marker over no note up to 480, a tom at 480 under the next one, and an unread zero-length note 13.
		const source = trackMidi('PART DRUMS', [], [[480, 98], [0, 110, 480], [480, 110, 1], [960, 97], [960, 13]])
		const parsed = parseChartAndIni([{ fileName: 'notes.mid', data: source }]).parsedChart!
		const written = writeMidiFile(parsed)
		expect(chartSpellingIssues({ format: 'mid', bytes: written, tokens: readMidiTokens(written, 'reject') }, false)).toEqual([])
		const reparsed = parseChartAndIni([{ fileName: 'notes.mid', data: written }]).parsedChart!
		expect(flatNotes(findTrack(reparsed, 'drums'))).toEqual(flatNotes(findTrack(parsed, 'drums')))
		expect(findTrack(reparsed, 'drums').unrecognizedMidiEvents).toEqual(findTrack(parsed, 'drums').unrecognizedMidiEvents)
	})

	it('ends a lane before a lane of its number that starts where it ends, from another difficulty', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		for (const [difficulty, tick] of [['expert', 480], ['hard', 0]] as const) {
			const td = emptyDrumTrack(difficulty)
			td.noteEventGroups.push([note(0, noteTypes.redDrum)], [note(480, noteTypes.redDrum)])
			td.flexLanes.push({ tick, length: 480, isDouble: false, msTime: 0, msLength: 0 })
			chart.trackData.push(td)
		}
		const written = writeMidiFile(chart)
		expect(chartSpellingIssues({ format: 'mid', bytes: written, tokens: readMidiTokens(written, 'reject') }, false)).toEqual([])
		const re = roundTrip(chart)
		const lanes = (difficulty: string) => findTrack(re, 'drums', difficulty).flexLanes.map(lane => [lane.tick, lane.length])
		// The Hard lane's velocity makes it apply to Expert as well, as .mid can't hold a lane only Hard has.
		expect(lanes('expert')).toEqual([[0, 480], [480, 480]])
		expect(lanes('hard')).toEqual([[0, 480]])
	})

	it('preserves versus phrases', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.kick)], [note(960, noteTypes.redDrum)])
		td.versusPhrases.push({ tick: 0, length: 480, isPlayer2: false, msTime: 0, msLength: 0 }, { tick: 960, length: 480, isPlayer2: true, msTime: 0, msLength: 0 })
		chart.trackData.push(td)
		expect(findTrack(roundTrip(chart), 'drums').versusPhrases.map(phrase => [phrase.tick, phrase.length, phrase.isPlayer2])).toEqual([
			[0, 480, false],
			[960, 480, true],
		])
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

	it('writes star power on note 103 when song.ini says multiplier_note = 103, and rejected star power on 116', () => {
		const chart = createEmptyChart({ format: 'mid' })
		chart.iniChartModifiers = { ...chart.iniChartModifiers, multiplier_note: 103 }
		const td = emptyFretTrack('guitar', 'expert')
		td.noteEventGroups.push([note(0, noteTypes.green)], [note(960, noteTypes.red)])
		td.starPowerSections.push({ tick: 0, length: 480, msTime: 0, msLength: 0 })
		td.rejectedStarPowerSections.push({ tick: 960, length: 480, msTime: 0, msLength: 0 })
		chart.trackData.push(td)
		const track = findTrack(roundTrip(chart, '[song]\nmultiplier_note = 103\n'), 'guitar')
		expect(track.starPowerSections.map(sp => [sp.tick, sp.length])).toEqual([[0, 480]])
		expect(track.rejectedStarPowerSections.map(sp => [sp.tick, sp.length])).toEqual([[960, 480]])
		expect(track.soloSections).toEqual([])
	})

	it('preserves a sustained open in a chord at tick 0: [ENHANCED_OPENS] comes before it', () => {
		const chart = createEmptyChart({ format: 'mid' })
		const td = emptyFretTrack('guitar', 'expert')
		td.noteEventGroups.push([note(0, noteTypes.open, 0, 240), note(0, noteTypes.red, 0, 240)])
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

	it('ends each tap range before the next note, so a tap end read inclusively or exclusively taps the same notes', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		const td = emptyFretTrack('guitar', 'expert')
		td.noteEventGroups.push([note(0, noteTypes.green)])
		// A tap with the next note a tick later, two taps with the next note a tick later, and a tap with room after it.
		td.noteEventGroups.push([note(480, noteTypes.green, noteFlags.tap)], [note(481, noteTypes.red, noteFlags.strum)])
		td.noteEventGroups.push([note(960, noteTypes.green, noteFlags.tap)], [note(961, noteTypes.red, noteFlags.tap)], [note(962, noteTypes.yellow, noteFlags.strum)])
		td.noteEventGroups.push([note(1440, noteTypes.green, noteFlags.tap)], [note(1920, noteTypes.red, noteFlags.strum)])
		chart.trackData.push(td)
		const tapped = (track: ParsedChart['trackData'][number]) => flatNotes(track).filter(n => n.flags & noteFlags.tap).map(n => n.tick)
		const expected = [480, 960, 961, 1440]
		expect(tapped(findTrack(roundTrip(chart), 'guitar'))).toEqual(expected)
		const written = writeMidiFile(chart)
		expect(tapped(parseChartFile(written, 'mid').trackData[0])).toEqual(expected)
		expect(tapped(parseChartFileFrozenLegacyIdentity(written, 'mid').trackData[0])).toEqual(expected)
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

	it('writes sustains of one fret that meet with the note-off first, which scan-chart reads as standard', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 192 })
		const td = emptyFretTrack('guitar', 'expert')
		td.noteEventGroups.push([note(0, noteTypes.green, 0, 192)], [note(192, noteTypes.green, 0, 192)], [note(384, noteTypes.green, 0, 192)])
		chart.trackData.push(td)
		const written = writeMidiFile(chart)
		expect(chartSpellingIssues({ format: 'mid', bytes: written, tokens: readMidiTokens(written, 'reject') }, false)).toEqual([])
		expect(flatNotes(findTrack(roundTrip(chart), 'guitar')).map(n => [n.tick, n.length])).toEqual([[0, 192], [192, 192], [384, 192]])
	})

	it('writes a sustain the cutoff would cut with its note-off first too, and keeps it with the lower cutoff midiSustainCutoff gives', () => {
		// 30 ticks is under the default cutoff of 65 at resolution 192, which only the overlap step leaves.
		const chart = createEmptyChart({ format: 'mid', resolution: 192 })
		const td = emptyFretTrack('guitar', 'expert')
		td.noteEventGroups.push([note(0, noteTypes.green, 0, 30)], [note(30, noteTypes.green, 0, 192)], [note(480, noteTypes.green, 0, 192)], [note(672, noteTypes.green, 0, 192)])
		chart.trackData.push(td)
		const written = writeMidiFile(chart)
		expect(chartSpellingIssues({ format: 'mid', bytes: written, tokens: readMidiTokens(written, 'reject') }, false)).toEqual([])
		expect(midiSustainCutoff(chart, -1)).toEqual({ value: 29, write: true })
		const lengths = [[0, 30], [30, 192], [480, 192], [672, 192]]
		expect(flatNotes(findTrack(roundTrip(chart, '[song]\r\nsustain_cutoff_threshold = 29\r\n'), 'guitar')).map(n => [n.tick, n.length])).toEqual(lengths)
		// A cutoff song.ini sets is lowered too, where it would cut such a sustain.
		chart.iniChartModifiers = { ...chart.iniChartModifiers, sustain_cutoff_threshold: 40 }
		expect(midiSustainCutoff(chart, 40)).toEqual({ value: 29, write: true })
		expect(midiSustainCutoff(chart, 20)).toEqual({ value: 20, write: false })
		const folder = writeChartFolder({ parsedChart: chart, assets: [] })
		const reread = parseChartAndIni(folder.map(({ fileName, data }) => ({ fileName, data })))
		expect(flatNotes(findTrack(reread.parsedChart!, 'guitar')).map(n => [n.tick, n.length])).toEqual(lengths)
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

	it('writes opens on the open key, so an open sustain over a White 1 sustain keeps both lengths', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		for (const difficulty of ['expert', 'easy'] as const) {
			const td = emptyFretTrack('guitarghl', difficulty)
			td.noteEventGroups.push([note(0, noteTypes.open, 0, 960)], [note(480, noteTypes.white1, 0, 960)], [note(1920, noteTypes.open)])
			chart.trackData.push(td)
		}
		const re = roundTrip(chart)
		for (const difficulty of ['expert', 'easy']) {
			expect(flatNotes(findTrack(re, 'guitarghl', difficulty)).map(n => [n.tick, n.type, n.length])).toEqual([
				[0, noteTypes.open, 960],
				[480, noteTypes.white1, 960],
				[1920, noteTypes.open, 0],
			])
		}
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

	it('writes HARM2 phrases on note 105, so a HARM2 without HARM1 keeps its note phrases', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		const harm2Phrase = phrase(0, 960, { lyrics: [{ tick: 0, text: 'harm2' }], notes: [{ tick: 0, length: 240, pitch: 62 }] })
		chart.vocalTracks.parts.harmony2 = { ...EMPTY_VOCAL_PART, notePhrases: [harm2Phrase], staticLyricPhrases: [harm2Phrase] }
		const written = writeMidiFile(chart)
		const harm2Track = parseMidi(written).tracks.find(track => track.some(event => event.type === 'trackName' && event.text === 'HARM2'))!
		expect(harm2Track.filter(event => event.type === 'noteOn').map(event => event.type === 'noteOn' && event.noteNumber)).toEqual([105, 62])
		const harmony2 = roundTrip(chart).vocalTracks.parts.harmony2
		expect(harmony2.notePhrases.map(p => [p.tick, p.length, p.notes.length])).toEqual([[0, 960, 1]])
		expect(harmony2.staticLyricPhrases.map(p => [p.tick, p.length, p.notes.length])).toEqual([[0, 960, 1]])
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

	it('writes back pitch slides, a percussion note on the first tick of a phrase, and [range_shift] events', () => {
		const lyric = (tick: number, text: string) => ({ tick, text, type: 'lyrics' as const })
		const source = trackMidi('PART VOCALS', [
			lyric(0, 'Hel-'), lyric(120, '+'), { tick: 240, text: '[range_shift]' }, lyric(480, 'lo'), lyric(720, 'oh+'),
		], [
			[0, 105, 960], [0, 60, 100], [120, 64, 100], [480, 62, 100], [720, 65, 100],
			[1920, 105, 480], [1920, 96], [2040, 96],
		])
		const vocalTrack = (data: Uint8Array) => {
			const track = readMidiFile(data).tracks.find(events => events.some(event => event.type === 'trackName' && event.text === 'PART VOCALS'))!
			const { lyrics, notes, textEvents, phrases105 } = scanVocalTrack(track)
			return { lyrics: lyrics.map(l => [l.tick, l.text]), notes, textEvents, phrases105 }
		}
		const parsed = parseChartAndIni([{ fileName: 'notes.mid', data: source }]).parsedChart!
		const written = writeMidiFile(parsed)
		expect(vocalTrack(written)).toEqual(vocalTrack(source))
		const reparsed = parseChartAndIni([{ fileName: 'notes.mid', data: written }]).parsedChart!
		expect(reparsed.vocalTracks).toEqual(parsed.vocalTracks)
		expect(parsed.vocalTracks.parts.vocals.notePhrases.map(p => p.notes.map(n => [n.tick, n.pitchSlide ?? false]))).toEqual([
			[[0, false], [120, true], [480, false], [720, true]],
			[[1920, false], [2040, false]],
		])
	})

	it('reads [range_shift] events as vocal text events, and writes them back', () => {
		const source = trackMidi('PART VOCALS', [
			{ tick: 0, text: 'a', type: 'lyrics' }, { tick: 240, text: '[range_shift]' }, { tick: 480, text: '[range_shift 2.5]' },
		], [[0, 105, 960], [0, 60, 100]])
		const textEvents = (chart: ParsedChart) => chart.vocalTracks.parts.vocals.textEvents.map(event => [event.tick, event.text])
		const parsed = parseChartAndIni([{ fileName: 'notes.mid', data: source }]).parsedChart!
		expect(textEvents(parsed)).toEqual([[240, '[range_shift]'], [480, '[range_shift 2.5]']])
		const written = readMidiFile(writeMidiFile(parsed)).tracks.find(track => track.some(event => event.type === 'trackName' && event.text === 'PART VOCALS'))!
		expect(written.flatMap(event => event.type === 'text' ? [[event.deltaTime, event.text]] : [])).toEqual([[240, '[range_shift]'], [480, '[range_shift 2.5]']])
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
