/**
 * Round-trip tests for writeChartFile.
 *
 * All tests exercise the writer only through parseChartAndIni: build a
 * ParsedChart, write it out, re-parse, and assert on the resulting
 * ParsedChart. No assertions about the serialized .chart text (CRLF,
 * quoting, field order, section ordering, specific N numbers, etc.) —
 * the parser is the source of truth for observable behavior.
 */

import { describe, expect, it } from 'vitest'

import { writeChartFile } from '../chart/chart-writer'
import { createEmptyChart } from '../chart/create-chart'
import { noteFlags, noteTypes, NoteEvent } from '../chart/note-parsing-interfaces'
import { parseChartAndIni, type ParsedChart } from '../chart/parse-chart-and-ini'

function roundTrip(chart: ParsedChart, iniText?: string): ParsedChart {
	const files: { fileName: string; data: Uint8Array }[] = [
		{ fileName: 'notes.chart', data: new TextEncoder().encode(writeChartFile(chart)) },
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

function addDrumTrack(chart: ParsedChart, difficulty: 'expert' | 'hard' | 'medium' | 'easy' = 'expert') {
	const track: ParsedChart['trackData'][number] = {
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
	chart.trackData.push(track)
	return track
}

function addFretTrack(chart: ParsedChart, instrument: ParsedChart['trackData'][number]['instrument'] = 'guitar') {
	const track: ParsedChart['trackData'][number] = {
		instrument,
		difficulty: 'expert',
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
	chart.trackData.push(track)
	return track
}

function note(tick: number, type: number, flags = 0, length = 0): NoteEvent {
	return { tick, type, flags, length, msTime: 0, msLength: 0 }
}

/** Flatten a track's noteEventGroups into `{ tick, type, flags, length }` tuples for easy comparison. */
function flatNotes(track: ParsedChart['trackData'][number]) {
	return track.noteEventGroups.flatMap(g =>
		g.map(n => ({ tick: n.tick, type: n.type, flags: n.flags, length: n.length })),
	)
}

function findTrack(chart: ParsedChart, instrument: ParsedChart['trackData'][number]['instrument'], difficulty = 'expert') {
	const t = chart.trackData.find(t => t.instrument === instrument && t.difficulty === difficulty)
	if (!t) throw new Error(`no ${difficulty} ${instrument} track in round-tripped chart`)
	return t
}

describe('writeChartFile round-trip: [Song] metadata', () => {
	it('preserves chart resolution', () => {
		const re = roundTrip(createEmptyChart({ resolution: 192 }))
		expect(re.resolution).toBe(192)
	})

	it('preserves string metadata fields', () => {
		const chart = createEmptyChart()
		chart.metadata.name = 'My Song'
		chart.metadata.artist = 'Some Band'
		chart.metadata.album = 'Greatest Hits'
		chart.metadata.charter = 'Me'
		chart.metadata.genre = 'Rock'
		chart.metadata.year = '2024'
		const re = roundTrip(chart)
		expect(re.metadata).toMatchObject({
			name: 'My Song',
			artist: 'Some Band',
			album: 'Greatest Hits',
			charter: 'Me',
			genre: 'Rock',
			year: '2024',
		})
	})

	it('preserves chart_offset', () => {
		const chart = createEmptyChart()
		chart.metadata.chart_offset = 250
		expect(roundTrip(chart).metadata.chart_offset).toBe(250)
	})

	it('preserves preview_start_time', () => {
		const chart = createEmptyChart()
		chart.metadata.preview_start_time = 30000
		expect(roundTrip(chart).metadata.preview_start_time).toBe(30000)
	})

	it('preserves diff_* difficulty fields', () => {
		const chart = createEmptyChart()
		chart.metadata.diff_guitar = 5
		expect(roundTrip(chart).metadata.diff_guitar).toBe(5)
	})

	it('does not leak ini `delay` into chart_offset', () => {
		const chart = createEmptyChart()
		chart.metadata.delay = 999
		expect(roundTrip(chart).metadata.chart_offset).toBeUndefined()
	})

	it('does not emit a chart_offset for the value 0', () => {
		const chart = createEmptyChart()
		chart.metadata.chart_offset = 0
		expect(roundTrip(chart).metadata.chart_offset).toBeUndefined()
	})
})

describe('writeChartFile round-trip: [SyncTrack]', () => {
	it('preserves the default tempo and time signature on an empty chart', () => {
		const re = roundTrip(createEmptyChart())
		expect(re.tempos.map(t => ({ tick: t.tick, bpm: t.beatsPerMinute }))).toEqual([{ tick: 0, bpm: 120 }])
		expect(re.timeSignatures.map(ts => ({ tick: ts.tick, n: ts.numerator, d: ts.denominator }))).toEqual([
			{ tick: 0, n: 4, d: 4 },
		])
	})

	it('preserves non-4/4 time signatures', () => {
		const chart = createEmptyChart({ timeSignature: { numerator: 6, denominator: 8 } })
		expect(roundTrip(chart).timeSignatures[0]).toMatchObject({ numerator: 6, denominator: 8 })
	})

	it('preserves multiple tempo changes', () => {
		const chart = createEmptyChart({ bpm: 140 })
		chart.tempos.push({ tick: 1920, beatsPerMinute: 200, msTime: 0 })
		const re = roundTrip(chart)
		expect(re.tempos.map(t => ({ tick: t.tick, bpm: t.beatsPerMinute }))).toEqual([
			{ tick: 0, bpm: 140 },
			{ tick: 1920, bpm: 200 },
		])
	})

	it('preserves multiple time-signature changes', () => {
		const chart = createEmptyChart()
		chart.timeSignatures.push({ tick: 3840, numerator: 7, denominator: 8, msTime: 0, msLength: 0 })
		const re = roundTrip(chart)
		expect(re.timeSignatures.map(ts => ({ t: ts.tick, n: ts.numerator, d: ts.denominator }))).toEqual([
			{ t: 0, n: 4, d: 4 },
			{ t: 3840, n: 7, d: 8 },
		])
	})

	it('preserves fractional BPM', () => {
		const chart = createEmptyChart({ bpm: 137.5 })
		expect(roundTrip(chart).tempos[0].beatsPerMinute).toBe(137.5)
	})

	it('preserves tempo + TS events that share a tick', () => {
		const chart = createEmptyChart()
		chart.tempos.push({ tick: 960, beatsPerMinute: 150, msTime: 0 })
		chart.timeSignatures.push({ tick: 960, numerator: 3, denominator: 4, msTime: 0, msLength: 0 })
		const re = roundTrip(chart)
		expect(re.tempos.find(t => t.tick === 960)?.beatsPerMinute).toBe(150)
		expect(re.timeSignatures.find(ts => ts.tick === 960)).toMatchObject({ numerator: 3, denominator: 4 })
	})
})

describe('writeChartFile round-trip: [Events]', () => {
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

	it('preserves section names with special characters', () => {
		const chart = createEmptyChart()
		chart.sections.push({ tick: 0, name: '[BREAKDOWN]', msTime: 0, msLength: 0 })
		expect(roundTrip(chart).sections[0].name).toBe('[BREAKDOWN]')
	})

	it('preserves end events', () => {
		const chart = createEmptyChart()
		chart.endEvents.push({ tick: 9600, msTime: 0, msLength: 0 })
		expect(roundTrip(chart).endEvents.map(e => e.tick)).toEqual([9600])
	})

	it('preserves unrecognized global events', () => {
		const chart = createEmptyChart({ format: 'chart' })
		chart.unrecognizedEventsTrackTextEvents.push({ tick: 0, text: 'music_start', msTime: 0, msLength: 0 })
		const re = roundTrip(chart)
		expect(re.unrecognizedEventsTrackTextEvents.map(e => ({ tick: e.tick, text: e.text }))).toEqual([
			{ tick: 0, text: 'music_start' },
		])
	})

	it('does not duplicate an end event that also appears in unrecognizedEventsTrackTextEvents', () => {
		const chart = createEmptyChart()
		chart.endEvents.push({ tick: 1000, msTime: 0, msLength: 0 })
		chart.unrecognizedEventsTrackTextEvents.push({ tick: 1000, text: 'end', msTime: 0, msLength: 0 })
		const re = roundTrip(chart)
		expect(re.endEvents.map(e => e.tick)).toEqual([1000])
		expect(re.unrecognizedEventsTrackTextEvents.filter(e => e.text === 'end')).toHaveLength(0)
	})
})

describe('writeChartFile round-trip: unrecognized chart sections', () => {
	it('preserves unrecognized sections with arbitrary content', () => {
		const chart = createEmptyChart()
		chart.unrecognizedChartSections.push({
			name: 'MysteryBlock',
			lines: ['0 = foo', '100 = bar'],
		})
		expect(roundTrip(chart).unrecognizedChartSections).toEqual([
			{ name: 'MysteryBlock', lines: ['0 = foo', '100 = bar'] },
		])
	})
})

// ---------------------------------------------------------------------------
// Track section round-trip tests
// ---------------------------------------------------------------------------

describe('writeChartFile round-trip: drum tracks', () => {
	it('preserves a per-difficulty drum track (expert)', () => {
		const chart = createEmptyChart()
		const track = addDrumTrack(chart, 'expert')
		track.noteEventGroups.push([note(480, noteTypes.redDrum)])
		const re = roundTrip(chart)
		expect(findTrack(re, 'drums', 'expert').noteEventGroups).toHaveLength(1)
	})

	it('preserves base 4-lane drum notes with ticks and lengths', () => {
		const chart = createEmptyChart()
		const track = addDrumTrack(chart)
		track.noteEventGroups.push([note(0, noteTypes.kick)])
		track.noteEventGroups.push([note(480, noteTypes.redDrum, 0, 240)])
		track.noteEventGroups.push([note(960, noteTypes.yellowDrum)])
		track.noteEventGroups.push([note(1440, noteTypes.blueDrum)])
		track.noteEventGroups.push([note(1920, noteTypes.greenDrum)])
		const re = roundTrip(chart)
		const notes = flatNotes(findTrack(re, 'drums'))
		expect(notes).toEqual([
			expect.objectContaining({ tick: 0, type: noteTypes.kick, length: 0 }),
			expect.objectContaining({ tick: 480, type: noteTypes.redDrum, length: 240 }),
			expect.objectContaining({ tick: 960, type: noteTypes.yellowDrum, length: 0 }),
			expect.objectContaining({ tick: 1440, type: noteTypes.blueDrum, length: 0 }),
			expect.objectContaining({ tick: 1920, type: noteTypes.greenDrum, length: 0 }),
		])
	})

	it('preserves double-kick (not as a regular kick)', () => {
		const chart = createEmptyChart()
		const track = addDrumTrack(chart)
		track.noteEventGroups.push([note(0, noteTypes.kick, noteFlags.doubleKick)])
		const re = roundTrip(chart)
		const notes = flatNotes(findTrack(re, 'drums'))
		expect(notes).toHaveLength(1)
		expect(notes[0].flags & noteFlags.doubleKick).toBeTruthy()
	})

	it('preserves cymbal/accent/ghost flags in fourLanePro', () => {
		const chart = createEmptyChart()
		chart.drumType = 1
		const track = addDrumTrack(chart)
		track.noteEventGroups.push([note(0, noteTypes.redDrum, noteFlags.accent)])
		track.noteEventGroups.push([note(480, noteTypes.yellowDrum, noteFlags.cymbal)])
		track.noteEventGroups.push([note(960, noteTypes.blueDrum, noteFlags.ghost)])
		track.noteEventGroups.push([note(1440, noteTypes.greenDrum, noteFlags.cymbal)])
		const re = roundTrip(chart, '[Song]\npro_drums = True\n')
		const notes = flatNotes(findTrack(re, 'drums'))
		expect(notes[0].flags & noteFlags.accent).toBeTruthy()
		expect(notes[1].flags & noteFlags.cymbal).toBeTruthy()
		expect(notes[2].flags & noteFlags.ghost).toBeTruthy()
		expect(notes[3].flags & noteFlags.cymbal).toBeTruthy()
	})

	// Flam (N 109) round-trip lives in the MIDI writer tests: the .chart parser
	// doesn't recognize N 109, so flam doesn't survive a .chart round-trip.

	it('preserves star power, solo sections, flex lanes, and activation lanes', () => {
		const chart = createEmptyChart({ resolution: 480 })
		const track = addDrumTrack(chart)
		track.noteEventGroups.push([note(0, noteTypes.kick)])
		track.starPowerSections.push({ tick: 0, length: 960, msTime: 0, msLength: 0 })
		track.soloSections.push({ tick: 480, length: 480, msTime: 0, msLength: 0 })
		track.flexLanes.push({ tick: 960, length: 480, isDouble: false, msTime: 0, msLength: 0 })
		track.flexLanes.push({ tick: 1440, length: 480, isDouble: true, msTime: 0, msLength: 0 })
		track.drumFreestyleSections.push({ tick: 1920, length: 480, isCoda: false, msTime: 0, msLength: 0 })
		const re = roundTrip(chart)
		const reTrack = findTrack(re, 'drums')
		expect(reTrack.starPowerSections.map(s => ({ t: s.tick, l: s.length }))).toEqual([{ t: 0, l: 960 }])
		expect(reTrack.soloSections.map(s => ({ t: s.tick, l: s.length }))).toEqual([{ t: 480, l: 480 }])
		expect(reTrack.flexLanes.map(f => ({ t: f.tick, l: f.length, d: f.isDouble }))).toEqual([
			{ t: 960, l: 480, d: false },
			{ t: 1440, l: 480, d: true },
		])
		expect(reTrack.drumFreestyleSections.map(s => ({ t: s.tick, l: s.length }))).toEqual([{ t: 1920, l: 480 }])
	})
})

describe('writeChartFile round-trip: 5-fret tracks', () => {
	it('preserves base 5-fret notes on a guitar track', () => {
		const chart = createEmptyChart()
		const track = addFretTrack(chart, 'guitar')
		track.noteEventGroups.push([note(0, noteTypes.green)])
		track.noteEventGroups.push([note(100, noteTypes.red)])
		track.noteEventGroups.push([note(200, noteTypes.yellow)])
		track.noteEventGroups.push([note(300, noteTypes.blue)])
		track.noteEventGroups.push([note(400, noteTypes.orange)])
		track.noteEventGroups.push([note(500, noteTypes.open)])
		const re = roundTrip(chart)
		const notes = flatNotes(findTrack(re, 'guitar'))
		expect(notes.map(n => ({ tick: n.tick, type: n.type }))).toEqual([
			{ tick: 0, type: noteTypes.green },
			{ tick: 100, type: noteTypes.red },
			{ tick: 200, type: noteTypes.yellow },
			{ tick: 300, type: noteTypes.blue },
			{ tick: 400, type: noteTypes.orange },
			{ tick: 500, type: noteTypes.open },
		])
	})

	it('preserves the tap flag', () => {
		const chart = createEmptyChart()
		const track = addFretTrack(chart)
		track.noteEventGroups.push([note(0, noteTypes.green, noteFlags.tap)])
		const re = roundTrip(chart)
		const notes = flatNotes(findTrack(re, 'guitar'))
		expect(notes[0].flags & noteFlags.tap).toBeTruthy()
	})

	it('preserves a forced-hopo flag on a note whose natural state is strum', () => {
		const chart = createEmptyChart({ resolution: 480 })
		const track = addFretTrack(chart)
		// Two greens far apart — neither is natural HOPO. Flag the second → round-trip keeps the HOPO flag.
		track.noteEventGroups.push([note(0, noteTypes.green)])
		track.noteEventGroups.push([note(1920, noteTypes.green, noteFlags.hopo)])
		const re = roundTrip(chart)
		const notes = flatNotes(findTrack(re, 'guitar'))
		const hopoNote = notes.find(n => n.tick === 1920)!
		expect(hopoNote.flags & noteFlags.hopo).toBeTruthy()
	})

	it('preserves star power and solo sections on a guitar track', () => {
		const chart = createEmptyChart({ resolution: 480 })
		const track = addFretTrack(chart)
		track.noteEventGroups.push([note(0, noteTypes.green)])
		track.starPowerSections.push({ tick: 0, length: 960, msTime: 0, msLength: 0 })
		track.soloSections.push({ tick: 480, length: 480, msTime: 0, msLength: 0 })
		const re = roundTrip(chart)
		const reTrack = findTrack(re, 'guitar')
		expect(reTrack.starPowerSections.map(s => ({ t: s.tick, l: s.length }))).toEqual([{ t: 0, l: 960 }])
		expect(reTrack.soloSections.map(s => ({ t: s.tick, l: s.length }))).toEqual([{ t: 480, l: 480 }])
	})
})
