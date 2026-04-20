/**
 * Tests for writeChartFile: Song/SyncTrack/Events/unrecognized-sections emission.
 * Instrument-track tests land with the follow-up PR that ports serializeTrackSection.
 */

import { describe, expect, it } from 'vitest'

import { writeChartFile } from '../chart/chart-writer'
import { createEmptyChart } from '../chart/create-chart'
import { parseChartAndIni } from '../chart/parse-chart-and-ini'
import type { ParsedChart } from '../chart/parse-chart-and-ini'

function linesOf(out: string): string[] {
	return out.split('\r\n')
}

function sectionBody(out: string, header: string): string[] {
	const lines = linesOf(out)
	const start = lines.indexOf(header)
	if (start === -1) throw new Error(`section ${header} not found`)
	const open = lines.indexOf('{', start)
	const close = lines.indexOf('}', open)
	return lines.slice(open + 1, close)
}

function roundTripThroughParser(chart: ParsedChart): ReturnType<typeof parseChartAndIni> {
	const text = writeChartFile(chart)
	const bytes = new TextEncoder().encode(text)
	return parseChartAndIni([{ fileName: 'notes.chart', data: bytes }])
}

describe('writeChartFile: [Song] section', () => {
	it('emits just resolution when metadata is empty', () => {
		const chart = createEmptyChart({ resolution: 192 })
		const body = sectionBody(writeChartFile(chart), '[Song]')
		expect(body).toEqual(['  Resolution = 192'])
	})

	it('emits string metadata with quotes', () => {
		const chart = createEmptyChart()
		chart.metadata.name = 'My Song'
		chart.metadata.artist = 'Some Band'
		chart.metadata.charter = 'Me'
		const body = sectionBody(writeChartFile(chart), '[Song]')
		expect(body).toContain('  Name = "My Song"')
		expect(body).toContain('  Artist = "Some Band"')
		expect(body).toContain('  Charter = "Me"')
	})

	it('emits Year with the GHTCP-convention leading comma+space', () => {
		const chart = createEmptyChart()
		chart.metadata.year = '2024'
		const body = sectionBody(writeChartFile(chart), '[Song]')
		expect(body).toContain('  Year = ", 2024"')
	})

	it('emits Offset from chart_offset and PreviewStart as seconds when set', () => {
		const chart = createEmptyChart()
		chart.metadata.chart_offset = 250
		chart.metadata.preview_start_time = 30000
		const body = sectionBody(writeChartFile(chart), '[Song]')
		expect(body).toContain('  Offset = 0.25')
		expect(body).toContain('  PreviewStart = 30')
	})

	it('does not use ini `delay` for [Song] Offset (they are distinct fields)', () => {
		// `delay` is an ini-only property; games don't recognize it in [Song].
		// Set a high ini delay and no chart_offset — no Offset line should emit.
		const chart = createEmptyChart()
		chart.metadata.delay = 999
		const body = sectionBody(writeChartFile(chart), '[Song]')
		expect(body.join('\n')).not.toContain('Offset')
	})

	it('skips Offset when chart_offset is 0', () => {
		const chart = createEmptyChart()
		chart.metadata.chart_offset = 0
		const body = sectionBody(writeChartFile(chart), '[Song]')
		expect(body.join('\n')).not.toContain('Offset')
	})

	it('emits Difficulty from diff_guitar', () => {
		const chart = createEmptyChart()
		chart.metadata.diff_guitar = 5
		const body = sectionBody(writeChartFile(chart), '[Song]')
		expect(body).toContain('  Difficulty = 5')
	})

	it('round-trips metadata through parseChartAndIni', () => {
		const chart = createEmptyChart({ resolution: 480 })
		chart.metadata.name = 'Song'
		chart.metadata.artist = 'Artist'
		chart.metadata.album = 'Album'
		chart.metadata.genre = 'Rock'
		chart.metadata.year = '2024'
		chart.metadata.charter = 'Me'
		chart.metadata.chart_offset = 100
		chart.metadata.preview_start_time = 45000
		chart.metadata.diff_guitar = 4

		const re = roundTripThroughParser(chart)
		expect(re.parsedChart!.metadata).toMatchObject({
			name: 'Song',
			artist: 'Artist',
			album: 'Album',
			genre: 'Rock',
			year: '2024',
			charter: 'Me',
			chart_offset: 100,
			preview_start_time: 45000,
			diff_guitar: 4,
		})
		expect(re.parsedChart!.resolution).toBe(480)
	})
})

describe('writeChartFile: [SyncTrack] section', () => {
	it('emits the default 120 BPM + 4/4 events for an empty chart', () => {
		const chart = createEmptyChart()
		const body = sectionBody(writeChartFile(chart), '[SyncTrack]')
		expect(body).toEqual(['  0 = TS 4', '  0 = B 120000'])
	})

	it('emits TS with denominator exponent when not 4/4', () => {
		const chart = createEmptyChart({ timeSignature: { numerator: 6, denominator: 8 } })
		const body = sectionBody(writeChartFile(chart), '[SyncTrack]')
		expect(body).toContain('  0 = TS 6 3')
	})

	it('sorts tempo and TS events by tick, TS before B at same tick', () => {
		const chart = createEmptyChart()
		chart.tempos.push({ tick: 960, beatsPerMinute: 150, msTime: 0 })
		chart.timeSignatures.push({ tick: 960, numerator: 3, denominator: 4, msTime: 0, msLength: 0 })
		const body = sectionBody(writeChartFile(chart), '[SyncTrack]')
		const t960 = body.filter(l => l.startsWith('  960 = '))
		expect(t960).toEqual(['  960 = TS 3', '  960 = B 150000'])
	})

	it('emits BPM as millibeats (×1000)', () => {
		const chart = createEmptyChart({ bpm: 137.5 })
		const body = sectionBody(writeChartFile(chart), '[SyncTrack]')
		expect(body).toContain('  0 = B 137500')
	})

	it('round-trips tempos and time signatures', () => {
		const chart = createEmptyChart({ resolution: 480, bpm: 140 })
		chart.tempos.push({ tick: 1920, beatsPerMinute: 200, msTime: 0 })
		chart.timeSignatures.push({ tick: 3840, numerator: 7, denominator: 8, msTime: 0, msLength: 0 })
		const re = roundTripThroughParser(chart)
		const reChart = re.parsedChart!
		expect(reChart.tempos.map(t => ({ tick: t.tick, bpm: t.beatsPerMinute }))).toEqual([
			{ tick: 0, bpm: 140 },
			{ tick: 1920, bpm: 200 },
		])
		expect(reChart.timeSignatures.map(ts => ({ t: ts.tick, n: ts.numerator, d: ts.denominator }))).toEqual([
			{ t: 0, n: 4, d: 4 },
			{ t: 3840, n: 7, d: 8 },
		])
	})
})

describe('writeChartFile: [Events] section', () => {
	it('emits section markers wrapped in brackets (regex quirk)', () => {
		const chart = createEmptyChart()
		chart.sections.push({ tick: 0, name: 'Intro', msTime: 0, msLength: 0 })
		chart.sections.push({ tick: 1920, name: 'Verse 1', msTime: 0, msLength: 0 })
		const body = sectionBody(writeChartFile(chart), '[Events]')
		expect(body).toContain('  0 = E "[section Intro]"')
		expect(body).toContain('  1920 = E "[section Verse 1]"')
	})

	it('emits end events', () => {
		const chart = createEmptyChart()
		chart.endEvents.push({ tick: 9600, msTime: 0, msLength: 0 })
		const body = sectionBody(writeChartFile(chart), '[Events]')
		expect(body).toContain('  9600 = E "end"')
	})

	it('emits unrecognized global events verbatim when source is .chart', () => {
		const chart = createEmptyChart({ format: 'chart' })
		chart.unrecognizedEvents.push({ tick: 0, text: 'music_start', msTime: 0, msLength: 0 })
		const body = sectionBody(writeChartFile(chart), '[Events]')
		expect(body).toContain('  0 = E "music_start"')
	})

	it('strips bracket wrapping on unrecognized events sourced from .mid', () => {
		const chart = createEmptyChart({ format: 'mid' })
		chart.unrecognizedEvents.push({ tick: 480, text: '[crowd_noclap]', msTime: 0, msLength: 0 })
		const body = sectionBody(writeChartFile(chart), '[Events]')
		expect(body).toContain('  480 = E "crowd_noclap"')
	})

	it('skips duplicate end events in unrecognizedEvents', () => {
		const chart = createEmptyChart()
		chart.endEvents.push({ tick: 1000, msTime: 0, msLength: 0 })
		chart.unrecognizedEvents.push({ tick: 1000, text: 'end', msTime: 0, msLength: 0 })
		const body = sectionBody(writeChartFile(chart), '[Events]')
		expect(body.filter(l => l.endsWith('"end"'))).toHaveLength(1)
	})

	it('round-trips section markers with special characters', () => {
		const chart = createEmptyChart()
		chart.sections.push({ tick: 0, name: '[BREAKDOWN]', msTime: 0, msLength: 0 })
		const re = roundTripThroughParser(chart)
		expect(re.parsedChart!.sections[0].name).toBe('[BREAKDOWN]')
	})
})

describe('writeChartFile: unrecognized chart sections', () => {
	it('re-emits unrecognized sections verbatim (indent added by writer)', () => {
		const chart = createEmptyChart()
		// Parser stores lines without indent (splitTrimmedNonEmptyLines strips it).
		chart.unrecognizedChartSections.push({
			name: 'MysteryBlock',
			lines: ['0 = B 100000', '480 = some_unknown_event'],
		})
		const out = writeChartFile(chart)
		expect(out).toContain('[MysteryBlock]\r\n{\r\n  0 = B 100000\r\n  480 = some_unknown_event\r\n}')
	})

	it('round-trips unrecognized sections through parseChartAndIni', () => {
		const chart = createEmptyChart()
		chart.unrecognizedChartSections.push({
			name: 'MysteryBlock',
			lines: ['0 = foo', '100 = bar'],
		})
		const re = roundTripThroughParser(chart)
		expect(re.parsedChart!.unrecognizedChartSections).toEqual([
			{ name: 'MysteryBlock', lines: ['0 = foo', '100 = bar'] },
		])
	})
})

describe('writeChartFile: output format', () => {
	it('uses CRLF line endings and terminates with newline', () => {
		const chart = createEmptyChart()
		const out = writeChartFile(chart)
		expect(out).toMatch(/\r\n$/)
		expect(out).toContain('[Song]\r\n{\r\n')
	})
})

// ---------------------------------------------------------------------------
// Track section tests
// ---------------------------------------------------------------------------

import { noteFlags, noteTypes } from '../chart/note-parsing-interfaces'

/** Build a drum track and attach it to a chart. */
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

describe('writeChartFile: drum track emission', () => {
	it('emits [ExpertDrums] section when there is an expert drum track', () => {
		const chart = createEmptyChart()
		addDrumTrack(chart, 'expert')
		const out = writeChartFile(chart)
		expect(out).toContain('[ExpertDrums]\r\n{\r\n')
	})

	it('emits [HardDrums] section for hard difficulty', () => {
		const chart = createEmptyChart()
		addDrumTrack(chart, 'hard')
		expect(writeChartFile(chart)).toContain('[HardDrums]\r\n{\r\n')
	})

	it('emits base drum notes with their .chart note numbers', () => {
		const chart = createEmptyChart()
		const track = addDrumTrack(chart)
		track.noteEventGroups.push([note(0, noteTypes.kick)])
		track.noteEventGroups.push([note(480, noteTypes.redDrum, 0, 240)])
		track.noteEventGroups.push([note(960, noteTypes.yellowDrum)])
		track.noteEventGroups.push([note(1440, noteTypes.blueDrum)])
		track.noteEventGroups.push([note(1920, noteTypes.greenDrum)])
		const body = sectionBody(writeChartFile(chart), '[ExpertDrums]')
		expect(body).toContain('  0 = N 0 0')
		expect(body).toContain('  480 = N 1 240')
		expect(body).toContain('  960 = N 2 0')
		expect(body).toContain('  1440 = N 3 0')
		expect(body).toContain('  1920 = N 4 0')
	})

	it('emits double kick as N 32 only (no base N 0)', () => {
		const chart = createEmptyChart()
		const track = addDrumTrack(chart)
		track.noteEventGroups.push([note(0, noteTypes.kick, noteFlags.doubleKick)])
		const body = sectionBody(writeChartFile(chart), '[ExpertDrums]')
		expect(body).toContain('  0 = N 32 0')
		expect(body).not.toContain('  0 = N 0 0')
	})

	it('emits cymbal markers only when drumType is fourLanePro', () => {
		const chart = createEmptyChart()
		const track = addDrumTrack(chart)
		track.noteEventGroups.push([note(0, noteTypes.yellowDrum, noteFlags.cymbal)])
		// fourLane (drumType=0 or null): no cymbal marker
		const plain = sectionBody(writeChartFile(chart), '[ExpertDrums]')
		expect(plain).not.toContain('N 66')

		// fourLanePro (drumType=1): cymbal marker N 66 for yellow
		chart.drumType = 1
		const pro = sectionBody(writeChartFile(chart), '[ExpertDrums]')
		expect(pro).toContain('  0 = N 66 0')
	})

	it('emits accent marker N 34 for red drum with accent flag', () => {
		const chart = createEmptyChart()
		const track = addDrumTrack(chart)
		track.noteEventGroups.push([note(0, noteTypes.redDrum, noteFlags.accent)])
		const body = sectionBody(writeChartFile(chart), '[ExpertDrums]')
		expect(body).toContain('  0 = N 34 0')
	})

	it('emits ghost marker N 40 for red drum with ghost flag', () => {
		const chart = createEmptyChart()
		const track = addDrumTrack(chart)
		track.noteEventGroups.push([note(0, noteTypes.redDrum, noteFlags.ghost)])
		const body = sectionBody(writeChartFile(chart), '[ExpertDrums]')
		expect(body).toContain('  0 = N 40 0')
	})

	it('emits one N 109 (flam) per group regardless of how many notes set the flag', () => {
		const chart = createEmptyChart()
		const track = addDrumTrack(chart)
		track.noteEventGroups.push([
			note(0, noteTypes.redDrum, noteFlags.flam),
			note(0, noteTypes.yellowDrum, noteFlags.flam),
		])
		const body = sectionBody(writeChartFile(chart), '[ExpertDrums]')
		expect(body.filter(l => l.endsWith('N 109 0'))).toHaveLength(1)
	})

	it('emits star power as S 2', () => {
		const chart = createEmptyChart()
		const track = addDrumTrack(chart)
		track.starPowerSections.push({ tick: 0, length: 1920, msTime: 0, msLength: 0 })
		const body = sectionBody(writeChartFile(chart), '[ExpertDrums]')
		expect(body).toContain('  0 = S 2 1920')
	})

	it('emits solo sections with soloend at tick + length - 1', () => {
		const chart = createEmptyChart()
		const track = addDrumTrack(chart)
		track.soloSections.push({ tick: 480, length: 480, msTime: 0, msLength: 0 })
		const body = sectionBody(writeChartFile(chart), '[ExpertDrums]')
		expect(body).toContain('  480 = E solo')
		expect(body).toContain('  959 = E soloend')
	})

	it('emits flex lanes as S 65 (single) or S 66 (double)', () => {
		const chart = createEmptyChart()
		const track = addDrumTrack(chart)
		track.flexLanes.push({ tick: 0, length: 480, isDouble: false, msTime: 0, msLength: 0 })
		track.flexLanes.push({ tick: 480, length: 480, isDouble: true, msTime: 0, msLength: 0 })
		const body = sectionBody(writeChartFile(chart), '[ExpertDrums]')
		expect(body).toContain('  0 = S 65 480')
		expect(body).toContain('  480 = S 66 480')
	})

	it('emits activation lanes as S 64', () => {
		const chart = createEmptyChart()
		const track = addDrumTrack(chart)
		track.drumFreestyleSections.push({ tick: 0, length: 480, isCoda: false, msTime: 0, msLength: 0 })
		const body = sectionBody(writeChartFile(chart), '[ExpertDrums]')
		expect(body).toContain('  0 = S 64 480')
	})
})

describe('writeChartFile: guitar track emission', () => {
	it('emits [ExpertSingle] section name', () => {
		const chart = createEmptyChart()
		addFretTrack(chart)
		expect(writeChartFile(chart)).toContain('[ExpertSingle]\r\n{\r\n')
	})

	it('emits 5-fret notes with their .chart note numbers', () => {
		const chart = createEmptyChart()
		const track = addFretTrack(chart)
		track.noteEventGroups.push([note(0, noteTypes.green)])
		track.noteEventGroups.push([note(100, noteTypes.red)])
		track.noteEventGroups.push([note(200, noteTypes.yellow)])
		track.noteEventGroups.push([note(300, noteTypes.blue)])
		track.noteEventGroups.push([note(400, noteTypes.orange)])
		track.noteEventGroups.push([note(500, noteTypes.open)])
		const body = sectionBody(writeChartFile(chart), '[ExpertSingle]')
		expect(body).toContain('  0 = N 0 0')
		expect(body).toContain('  100 = N 1 0')
		expect(body).toContain('  200 = N 2 0')
		expect(body).toContain('  300 = N 3 0')
		expect(body).toContain('  400 = N 4 0')
		expect(body).toContain('  500 = N 7 0')
	})

	it('emits tap flag as N 6', () => {
		const chart = createEmptyChart()
		const track = addFretTrack(chart)
		track.noteEventGroups.push([note(0, noteTypes.green, noteFlags.tap)])
		const body = sectionBody(writeChartFile(chart), '[ExpertSingle]')
		expect(body).toContain('  0 = N 0 0')
		expect(body).toContain('  0 = N 6 0')
	})

	it('emits forceUnnatural N 5 when hopo flag disagrees with natural state', () => {
		const chart = createEmptyChart({ resolution: 480 })
		const track = addFretTrack(chart)
		// Two isolated greens far apart: neither is natural HOPO (both would be strum).
		// Flag the second as HOPO → mismatch → N 5 should be emitted.
		track.noteEventGroups.push([note(0, noteTypes.green)])
		track.noteEventGroups.push([note(1920, noteTypes.green, noteFlags.hopo)])
		const body = sectionBody(writeChartFile(chart), '[ExpertSingle]')
		expect(body).toContain('  1920 = N 5 0')
	})
})

describe('writeChartFile: round-trip through parseChartAndIni', () => {
	it('round-trips drum notes with cymbal/accent/ghost flags in fourLanePro', () => {
		const chart = createEmptyChart({ resolution: 480 })
		chart.drumType = 1
		chart.iniChartModifiers.pro_drums = true
		const track = addDrumTrack(chart)
		track.noteEventGroups.push([note(0, noteTypes.kick)])
		track.noteEventGroups.push([note(480, noteTypes.redDrum, noteFlags.accent)])
		track.noteEventGroups.push([note(960, noteTypes.yellowDrum, noteFlags.cymbal)])
		track.noteEventGroups.push([note(1440, noteTypes.blueDrum, noteFlags.ghost)])
		track.noteEventGroups.push([note(1920, noteTypes.greenDrum, noteFlags.cymbal)])

		const text = writeChartFile(chart)
		const re = parseChartAndIni([
			{ fileName: 'notes.chart', data: new TextEncoder().encode(text) },
			{ fileName: 'song.ini', data: new TextEncoder().encode('[Song]\npro_drums = True\n') },
		])
		const reTrack = re.parsedChart!.trackData.find(t => t.instrument === 'drums' && t.difficulty === 'expert')!
		const types = reTrack.noteEventGroups.flatMap(g => g.map(n => ({ tick: n.tick, type: n.type, flags: n.flags })))
		expect(types).toEqual([
			{ tick: 0, type: noteTypes.kick, flags: 0 },
			{ tick: 480, type: noteTypes.redDrum, flags: expect.any(Number) },
			{ tick: 960, type: noteTypes.yellowDrum, flags: expect.any(Number) },
			{ tick: 1440, type: noteTypes.blueDrum, flags: expect.any(Number) },
			{ tick: 1920, type: noteTypes.greenDrum, flags: expect.any(Number) },
		])
		// Flag checks: accent/cymbal/ghost round-trip
		expect(types[1].flags & noteFlags.accent).toBeTruthy()
		expect(types[2].flags & noteFlags.cymbal).toBeTruthy()
		expect(types[3].flags & noteFlags.ghost).toBeTruthy()
		expect(types[4].flags & noteFlags.cymbal).toBeTruthy()
	})

	it('round-trips star power + solo + flex lanes on a drum track', () => {
		const chart = createEmptyChart({ resolution: 480 })
		const track = addDrumTrack(chart)
		track.noteEventGroups.push([note(0, noteTypes.kick)])
		track.starPowerSections.push({ tick: 0, length: 960, msTime: 0, msLength: 0 })
		track.soloSections.push({ tick: 480, length: 480, msTime: 0, msLength: 0 })
		track.flexLanes.push({ tick: 960, length: 480, isDouble: true, msTime: 0, msLength: 0 })

		const text = writeChartFile(chart)
		const re = parseChartAndIni([{ fileName: 'notes.chart', data: new TextEncoder().encode(text) }])
		const reTrack = re.parsedChart!.trackData.find(t => t.instrument === 'drums')!
		expect(reTrack.starPowerSections.map(s => ({ t: s.tick, l: s.length }))).toEqual([{ t: 0, l: 960 }])
		expect(reTrack.soloSections.map(s => ({ t: s.tick, l: s.length }))).toEqual([{ t: 480, l: 480 }])
		expect(reTrack.flexLanes.map(f => ({ t: f.tick, l: f.length, d: f.isDouble }))).toEqual([
			{ t: 960, l: 480, d: true },
		])
	})
})
