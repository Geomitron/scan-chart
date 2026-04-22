/**
 * Same-format round-trip integration tests for scan-chart's writers.
 *
 * These exercise the full pipeline — build a ParsedChart → serialize via
 * writeChartFile / writeMidiFile → re-parse via parseChartAndIni → check
 * that structured fields survive. Per-feature correctness is already
 * covered by the granular writer/parser tests; this file's value is
 * catching regressions in interactions across tracks and coverage of the
 * "build a whole chart with everything populated" shape.
 *
 * Tests live in both formats where both formats support the feature. A
 * few features are format-asymmetric (e.g. .chart has no vocal encoding
 * for harmony parts beyond [Events] lyrics) and are tested in only one.
 */

import { describe, expect, it } from 'vitest'

import { createEmptyChart } from '../chart/create-chart'
import { writeChartFile, writeMidiFile } from '../chart'
import { parseChartAndIni } from '../chart/parse-chart-and-ini'
import type { ParsedChart } from '../chart/parse-chart-and-ini'
import { noteFlags, noteTypes } from '../chart/note-parsing-interfaces'

// ---------------------------------------------------------------------------
// Small helpers — mirror the builders used by midi-writer.test.ts and
// chart-writer.test.ts to keep fixture boilerplate in check.
// ---------------------------------------------------------------------------

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

function note(tick: number, type: number, flags = 0, length = 0) {
	return { tick, type, flags, length, msTime: 0, msLength: 0 }
}

function writeAndReparseAsChart(chart: ParsedChart): ParsedChart {
	const text = writeChartFile(chart)
	const re = parseChartAndIni([{ fileName: 'notes.chart', data: new TextEncoder().encode(text) }])
	expect(re.parsedChart).not.toBeNull()
	return re.parsedChart!
}

function writeAndReparseAsMidi(chart: ParsedChart): ParsedChart {
	const bytes = writeMidiFile(chart)
	const re = parseChartAndIni([{ fileName: 'notes.mid', data: bytes }])
	expect(re.parsedChart).not.toBeNull()
	return re.parsedChart!
}

// ---------------------------------------------------------------------------
// Tempo / sync / events
// ---------------------------------------------------------------------------

describe('round-trip: tempo + time signature + sections', () => {
	for (const format of ['chart', 'mid'] as const) {
		it(`survives a full sync map and section list via .${format}`, () => {
			const chart = createEmptyChart({ format, resolution: 480, bpm: 120 })
			chart.tempos.push({ tick: 1920, beatsPerMinute: 140, msTime: 0 })
			chart.tempos.push({ tick: 3840, beatsPerMinute: 90, msTime: 0 })
			chart.timeSignatures.push({ tick: 1920, numerator: 3, denominator: 4, msTime: 0, msLength: 0 })
			chart.sections.push({ tick: 0, name: 'intro', msTime: 0, msLength: 0 })
			chart.sections.push({ tick: 1920, name: 'verse 1', msTime: 0, msLength: 0 })
			chart.endEvents.push({ tick: 7680, msTime: 0, msLength: 0 })

			const re = format === 'chart' ? writeAndReparseAsChart(chart) : writeAndReparseAsMidi(chart)

			expect(re.tempos.map(t => ({ tick: t.tick, bpm: Math.round(t.beatsPerMinute) }))).toEqual([
				{ tick: 0, bpm: 120 },
				{ tick: 1920, bpm: 140 },
				{ tick: 3840, bpm: 90 },
			])
			expect(re.timeSignatures.map(ts => ({ tick: ts.tick, n: ts.numerator, d: ts.denominator }))).toEqual([
				{ tick: 0, numerator: 4, denominator: 4 },
				{ tick: 1920, numerator: 3, denominator: 4 },
			].map(x => ({ tick: x.tick, n: x.numerator, d: x.denominator })))
			expect(re.sections.map(s => ({ tick: s.tick, name: s.name }))).toEqual([
				{ tick: 0, name: 'intro' },
				{ tick: 1920, name: 'verse 1' },
			])
			expect(re.endEvents.map(e => e.tick)).toEqual([7680])
		})
	}
})

// ---------------------------------------------------------------------------
// Drum track
// ---------------------------------------------------------------------------

describe('round-trip: drums', () => {
	for (const format of ['chart', 'mid'] as const) {
		it(`preserves kick / tom / cymbal / 2x-kick + accent/ghost flags via .${format}`, () => {
			const chart = createEmptyChart({ format, resolution: 480 })
			if (format === 'mid') chart.iniChartModifiers.pro_drums = true
			chart.drumType = 1 // fourLanePro — required for tom markers in .chart

			const td = emptyDrumTrack('expert')
			td.noteEventGroups.push([note(0, noteTypes.kick)])
			td.noteEventGroups.push([note(120, noteTypes.redDrum, noteFlags.accent)])
			td.noteEventGroups.push([note(240, noteTypes.yellowDrum, noteFlags.tom)])
			td.noteEventGroups.push([note(360, noteTypes.blueDrum, noteFlags.ghost)])
			td.noteEventGroups.push([note(480, noteTypes.greenDrum, noteFlags.tom)])
			td.noteEventGroups.push([note(960, noteTypes.kick, noteFlags.doubleKick)])
			chart.trackData.push(td)

			const re = format === 'chart' ? writeAndReparseAsChart(chart) : writeAndReparseAsMidi(chart)

			const reTd = re.trackData.find(t => t.instrument === 'drums' && t.difficulty === 'expert')!
			expect(reTd.noteEventGroups).toHaveLength(6)
			expect(reTd.noteEventGroups[0][0].type).toBe(noteTypes.kick)
			expect(reTd.noteEventGroups[1][0].flags & noteFlags.accent).toBeTruthy()
			expect(reTd.noteEventGroups[2][0].flags & noteFlags.tom).toBeTruthy()
			expect(reTd.noteEventGroups[3][0].flags & noteFlags.ghost).toBeTruthy()
			expect(reTd.noteEventGroups[4][0].flags & noteFlags.tom).toBeTruthy()
			expect(reTd.noteEventGroups[5][0].flags & noteFlags.doubleKick).toBeTruthy()
		})
	}

	// Flam survives only .mid round-trip. The .chart writer emits `N 109` but
	// the .chart parser does not recognize it as a flam marker — this is a
	// pre-existing parser gap, not a writer bug. Asymmetric test is the
	// honest thing to ship.
	it('preserves flam via .mid', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		chart.iniChartModifiers.pro_drums = true
		chart.drumType = 1

		const td = emptyDrumTrack('expert')
		td.noteEventGroups.push([note(0, noteTypes.redDrum, noteFlags.flam)])
		chart.trackData.push(td)

		const re = writeAndReparseAsMidi(chart)
		const reTd = re.trackData.find(t => t.instrument === 'drums')!
		expect(reTd.noteEventGroups[0][0].flags & noteFlags.flam).toBeTruthy()
	})
})

// ---------------------------------------------------------------------------
// Fret tracks (5-fret + GHL)
// ---------------------------------------------------------------------------

describe('round-trip: 5-fret', () => {
	for (const format of ['chart', 'mid'] as const) {
		it(`preserves base colors + forceHopo / forceTap via .${format}`, () => {
			const chart = createEmptyChart({ format, resolution: 480 })
			const td = emptyFretTrack('guitar', 'expert')
			td.noteEventGroups.push([note(0, noteTypes.green)])
			td.noteEventGroups.push([note(1920, noteTypes.green, noteFlags.hopo)])
			td.noteEventGroups.push([note(3840, noteTypes.red, noteFlags.tap)])
			td.noteEventGroups.push([note(5760, noteTypes.orange, 0, 480)])
			chart.trackData.push(td)

			const re = format === 'chart' ? writeAndReparseAsChart(chart) : writeAndReparseAsMidi(chart)

			const reTd = re.trackData.find(t => t.instrument === 'guitar' && t.difficulty === 'expert')!
			expect(reTd.noteEventGroups).toHaveLength(4)
			expect(reTd.noteEventGroups[0][0].type).toBe(noteTypes.green)
			expect(reTd.noteEventGroups[1][0].flags & noteFlags.hopo).toBeTruthy()
			expect(reTd.noteEventGroups[2][0].flags & noteFlags.tap).toBeTruthy()
			expect(reTd.noteEventGroups[3][0].length).toBeGreaterThan(0)
		})
	}

	for (const format of ['chart', 'mid'] as const) {
		it(`preserves star power + solo sections via .${format}`, () => {
			const chart = createEmptyChart({ format, resolution: 480 })
			const td = emptyFretTrack('guitar', 'expert')
			td.noteEventGroups.push([note(0, noteTypes.green)])
			td.noteEventGroups.push([note(480, noteTypes.red)])
			td.starPowerSections.push({ tick: 0, length: 960, msTime: 0, msLength: 0 })
			td.soloSections.push({ tick: 1920, length: 480, msTime: 0, msLength: 0 })
			chart.trackData.push(td)

			const re = format === 'chart' ? writeAndReparseAsChart(chart) : writeAndReparseAsMidi(chart)

			const reTd = re.trackData.find(t => t.instrument === 'guitar' && t.difficulty === 'expert')!
			expect(reTd.starPowerSections).toHaveLength(1)
			expect(reTd.starPowerSections[0].tick).toBe(0)
			expect(reTd.soloSections).toHaveLength(1)
			expect(reTd.soloSections[0].tick).toBe(1920)
		})
	}
})

describe('round-trip: GHL', () => {
	for (const format of ['chart', 'mid'] as const) {
		it(`preserves open + chord-with-open (ENHANCED_OPENS path) via .${format}`, () => {
			const chart = createEmptyChart({ format, resolution: 480 })
			const td = emptyFretTrack('guitarghl', 'expert')
			td.noteEventGroups.push([note(0, noteTypes.open)])
			td.noteEventGroups.push([
				note(480, noteTypes.open),
				note(480, noteTypes.white1),
			])
			chart.trackData.push(td)

			const re = format === 'chart' ? writeAndReparseAsChart(chart) : writeAndReparseAsMidi(chart)

			const reTd = re.trackData.find(t => t.instrument === 'guitarghl')!
			expect(reTd.noteEventGroups).toHaveLength(2)
			expect(reTd.noteEventGroups[0][0].type).toBe(noteTypes.open)
			const chordTypes = reTd.noteEventGroups[1].map(n => n.type).sort()
			expect(chordTypes).toEqual([noteTypes.open, noteTypes.white1].sort())
		})
	}
})

// ---------------------------------------------------------------------------
// Vocals — .mid only (full phrase/marker support); .chart has only [Events]
// lyric events, which are handled at the global-events level (not part of
// this PR's scope — see the vocal-tracks tests for format-specific coverage).
// ---------------------------------------------------------------------------

describe('round-trip: vocals (.mid)', () => {
	it('preserves PART VOCALS phrases, notes, lyrics, star power', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		chart.vocalTracks.parts.vocals = {
			notePhrases: [{
				tick: 0, length: 960, msTime: 0, msLength: 0,
				isPercussion: false,
				notes: [
					{ tick: 0, msTime: 0, length: 240, msLength: 0, pitch: 60, type: 'pitched' },
					{ tick: 240, msTime: 0, length: 240, msLength: 0, pitch: 64, type: 'pitched' },
				],
				lyrics: [
					{ tick: 0, msTime: 0, text: 'Hel-', flags: 0 },
					{ tick: 240, msTime: 0, text: 'lo', flags: 0 },
				],
			}],
			staticLyricPhrases: [],
			starPowerSections: [{ tick: 0, length: 960, msTime: 0, msLength: 0 }],
			rangeShifts: [],
			lyricShifts: [],
			textEvents: [],
		}

		const re = writeAndReparseAsMidi(chart)
		const reVocals = re.vocalTracks.parts.vocals
		expect(reVocals).toBeDefined()
		expect(reVocals.notePhrases).toHaveLength(1)
		expect(reVocals.notePhrases[0].notes.map(n => n.pitch)).toEqual([60, 64])
		expect(reVocals.notePhrases[0].lyrics.map(l => l.text)).toEqual(['Hel-', 'lo'])
		expect(reVocals.starPowerSections).toHaveLength(1)
	})

	it('preserves HARM1 / HARM2 / HARM3 with CopyDown semantics', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		const h1 = {
			tick: 0, length: 960, msTime: 0, msLength: 0,
			isPercussion: false,
			notes: [{ tick: 0, msTime: 0, length: 240, msLength: 0, pitch: 60, type: 'pitched' as const }],
			lyrics: [{ tick: 0, msTime: 0, text: 'One', flags: 0 }],
		}
		chart.vocalTracks.parts.harmony1 = {
			notePhrases: [h1], staticLyricPhrases: [],
			starPowerSections: [], rangeShifts: [], lyricShifts: [], textEvents: [],
		}
		chart.vocalTracks.parts.harmony2 = {
			notePhrases: [h1], staticLyricPhrases: [h1],
			starPowerSections: [], rangeShifts: [], lyricShifts: [], textEvents: [],
		}
		chart.vocalTracks.parts.harmony3 = {
			notePhrases: [h1], staticLyricPhrases: [h1],
			starPowerSections: [], rangeShifts: [], lyricShifts: [], textEvents: [],
		}

		const re = writeAndReparseAsMidi(chart)
		const parts = re.vocalTracks.parts
		expect(parts.harmony1).toBeDefined()
		expect(parts.harmony2).toBeDefined()
		expect(parts.harmony3).toBeDefined()
		expect(parts.harmony1.notePhrases[0].notes[0].pitch).toBe(60)
		// HARM2/HARM3 receive HARM1 notePhrases via CopyDown on re-parse.
		expect(parts.harmony2.notePhrases[0].notes[0].pitch).toBe(60)
		expect(parts.harmony3.notePhrases[0].notes[0].pitch).toBe(60)
	})
})

// ---------------------------------------------------------------------------
// Multi-track interactions: a chart with drums + guitar + vocals all at once.
// ---------------------------------------------------------------------------

describe('round-trip: multi-track chart', () => {
	for (const format of ['chart', 'mid'] as const) {
		it(`preserves drums + guitar + bass in the same chart via .${format}`, () => {
			const chart = createEmptyChart({ format, resolution: 480 })
			chart.drumType = 1

			const drums = emptyDrumTrack('expert')
			drums.noteEventGroups.push([note(0, noteTypes.kick)])
			drums.noteEventGroups.push([note(480, noteTypes.redDrum)])
			chart.trackData.push(drums)

			const guitar = emptyFretTrack('guitar', 'expert')
			guitar.noteEventGroups.push([note(0, noteTypes.green)])
			guitar.noteEventGroups.push([note(480, noteTypes.red, noteFlags.hopo)])
			chart.trackData.push(guitar)

			const bass = emptyFretTrack('bass', 'expert')
			bass.noteEventGroups.push([note(0, noteTypes.green, 0, 240)])
			chart.trackData.push(bass)

			const re = format === 'chart' ? writeAndReparseAsChart(chart) : writeAndReparseAsMidi(chart)

			expect(re.trackData.find(t => t.instrument === 'drums')).toBeDefined()
			expect(re.trackData.find(t => t.instrument === 'guitar')).toBeDefined()
			expect(re.trackData.find(t => t.instrument === 'bass')).toBeDefined()
			// Drums: 2 groups. Guitar: 2 groups, second is forceHopo.
			const reDrums = re.trackData.find(t => t.instrument === 'drums')!
			const reGuitar = re.trackData.find(t => t.instrument === 'guitar')!
			expect(reDrums.noteEventGroups).toHaveLength(2)
			expect(reGuitar.noteEventGroups).toHaveLength(2)
			expect(reGuitar.noteEventGroups[1][0].flags & noteFlags.hopo).toBeTruthy()
		})
	}

	it('preserves drums + guitar + vocals in a .mid chart', () => {
		const chart = createEmptyChart({ format: 'mid', resolution: 480 })
		chart.iniChartModifiers.pro_drums = true
		chart.drumType = 1

		const drums = emptyDrumTrack('expert')
		drums.noteEventGroups.push([note(0, noteTypes.kick)])
		drums.noteEventGroups.push([note(480, noteTypes.redDrum)])
		chart.trackData.push(drums)

		const guitar = emptyFretTrack('guitar', 'expert')
		guitar.noteEventGroups.push([note(0, noteTypes.green)])
		chart.trackData.push(guitar)

		chart.vocalTracks.parts.vocals = {
			notePhrases: [{
				tick: 0, length: 960, msTime: 0, msLength: 0,
				isPercussion: false,
				notes: [{ tick: 0, msTime: 0, length: 240, msLength: 0, pitch: 60, type: 'pitched' }],
				lyrics: [{ tick: 0, msTime: 0, text: 'Hi', flags: 0 }],
			}],
			staticLyricPhrases: [],
			starPowerSections: [],
			rangeShifts: [],
			lyricShifts: [],
			textEvents: [],
		}

		const re = writeAndReparseAsMidi(chart)
		expect(re.trackData.find(t => t.instrument === 'drums')).toBeDefined()
		expect(re.trackData.find(t => t.instrument === 'guitar')).toBeDefined()
		expect(re.vocalTracks.parts.vocals).toBeDefined()
		expect(re.vocalTracks.parts.vocals.notePhrases[0].lyrics[0].text).toBe('Hi')
	})
})

// ---------------------------------------------------------------------------
// Metadata — values in [Song] vs song.ini should survive their own channel.
// ---------------------------------------------------------------------------

describe('round-trip: metadata', () => {
	it('preserves [Song] metadata via .chart', () => {
		const chart = createEmptyChart({ format: 'chart', resolution: 480 })
		chart.metadata.name = 'Test Song'
		chart.metadata.artist = 'Test Artist'
		chart.metadata.album = 'Test Album'
		chart.metadata.year = '2024'

		const re = writeAndReparseAsChart(chart)
		expect(re.metadata.name).toBe('Test Song')
		expect(re.metadata.artist).toBe('Test Artist')
		expect(re.metadata.album).toBe('Test Album')
		expect(re.metadata.year).toBe('2024')
	})

	it('preserves chart_offset via .chart (separate from song.ini delay)', () => {
		const chart = createEmptyChart({ format: 'chart', resolution: 480 })
		chart.metadata.chart_offset = 250

		const re = writeAndReparseAsChart(chart)
		expect(re.metadata.chart_offset).toBe(250)
	})
})
