/**
 * Tests for the MIDI track-name discovery in `getTracks`. Some charts emit
 * multiple `trackName` events at tick 0. As in Clone Hero, the last one names
 * the track (each one replaces the previous in DryWetMidi's TrackChunk), in
 * every profile.
 *
 * Real-world charts that hit this path:
 *   - "Culture Killer - Blindfolded Death" ([ENHANCED_OPENS], PART BASS): bass
 *   - "Periphery - Ji" (TEMPO TRACK, PART DRUMS): drums
 *   - "HEALTH - Isn't Everyone" (PART DRUMS, [ENABLE_CHART_DYNAMICS]): no drums
 *   - "Kristoff Miro - Reflejo" (PART BASS, PART GUITAR): guitar
 */

import { describe, it, expect } from 'vitest'
import { writeMidi, MidiData } from '@geomitron/midi-file'
import { parseNotesFromMidi } from 'src/chart/midi-file-parser'
import { canonical20260801 } from 'src/chart/identity/public'
import { parseChartFile, parseChartFileFrozenLegacyIdentity } from 'src/chart/parse-chart-file'
import { defaultMetadata } from 'src/ini/metadata'

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

/** Build an instrument track whose tick-0 events start with `leadingNames`
 *  (zero or more trackName events) followed by a single noteOn/noteOff pair. */
function trackWithLeadingNames(
	leadingNames: string[],
	noteNumber: number,
	noteLength = 480,
): MidiData['tracks'][number] {
	const events: MidiData['tracks'][number] = []
	for (const text of leadingNames) {
		events.push({ deltaTime: 0, type: 'trackName', text })
	}
	events.push({ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber, velocity: 100 })
	events.push({ deltaTime: noteLength, type: 'noteOff', channel: 0, noteNumber, velocity: 0 })
	events.push({ deltaTime: 0, type: 'endOfTrack' })
	return events
}

describe('MIDI: tick-0 trackName resolution', () => {
	const instruments = (midi: Uint8Array) => {
		const canonical = canonical20260801.parseSource({ source: { format: 'mid', bytes: midi }, modifiers: defaultMetadata })
		return {
			scanner: parseChartFile(midi, 'mid').trackData.map(track => track.instrument),
			legacy: parseChartFileFrozenLegacyIdentity(midi, 'mid').trackData.map(track => track.instrument),
			canonical: canonical.kind === 'accepted' ? canonical.chart.tracks.map(track => track.key.instrument) : null,
		}
	}
	const everyProfile = (instrument: string[]) => ({ scanner: instrument, legacy: instrument, canonical: instrument })

	it('accepts a recognized instrument trackName when a bogus name comes first at tick 0', () => {
		// PART BASS expert green is MIDI note 96. (Same difficulty layout as guitar.)
		const bass = trackWithLeadingNames(['[ENHANCED_OPENS]', 'PART BASS'], 96)
		const midi = buildMidi(480, [tempoTrack(), bass])

		expect(instruments(midi)).toEqual(everyProfile(['bass']))
		expect(parseNotesFromMidi(midi, defaultMetadata).unrecognizedMidiTracks).toHaveLength(0)
	})

	it('accepts PART DRUMS when a descriptive name (e.g. song title) comes first at tick 0', () => {
		// PART DRUMS expert red drum is MIDI note 97.
		const drums = trackWithLeadingNames(['school food punishment - close, down, back to', 'PART DRUMS'], 97)
		const midi = buildMidi(480, [tempoTrack(), drums])

		expect(instruments(midi)).toEqual(everyProfile(['drums']))
		expect(parseNotesFromMidi(midi, defaultMetadata).unrecognizedMidiTracks).toHaveLength(0)
	})

	it('drops the instrument when an unrecognized name follows it at tick 0', () => {
		const drums = trackWithLeadingNames(['PART DRUMS', '[ENABLE_CHART_DYNAMICS]'], 97)
		const midi = buildMidi(480, [tempoTrack(), drums])

		expect(instruments(midi)).toEqual(everyProfile([]))
		const unrecognized = parseNotesFromMidi(midi, defaultMetadata).unrecognizedMidiTracks
		expect(unrecognized.map(track => track.trackName)).toEqual(['[ENABLE_CHART_DYNAMICS]'])
	})

	it('takes the last name when several recognized names appear at tick 0', () => {
		const ambiguous = trackWithLeadingNames(['PART BASS', 'PART GUITAR'], 96)
		const midi = buildMidi(480, [tempoTrack(), ambiguous])

		expect(instruments(midi)).toEqual(everyProfile(['guitar']))
	})

	it('reads the events track only when EVENTS is its last tick-0 name', () => {
		const events = (names: string[]): MidiData['tracks'][number] => [
			...names.map(text => ({ deltaTime: 0, type: 'trackName' as const, text })),
			{ deltaTime: 0, type: 'text', text: '[section intro]' },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const sections = (names: string[]) => {
			const midi = buildMidi(480, [tempoTrack(), events(names), trackWithLeadingNames(['PART BASS'], 96)])
			return parseNotesFromMidi(midi, defaultMetadata).sections.map(section => section.name)
		}

		expect(sections(['TEMPO TRACK', 'EVENTS'])).toEqual(['intro'])
		expect(sections(['EVENTS', "Plato's Tripartite"])).toEqual([])
	})

	it('captures the last tick-0 trackName as unrecognized when it is not a known track', () => {
		// VENUE isn't a recognized instrument track, so it's stored verbatim
		// in unrecognizedMidiTracks for round-trip.
		const venue: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'CUSTOM VENUE LEAD' },
			{ deltaTime: 0, type: 'trackName', text: 'VENUE' },
			{ deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },
			{ deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const midi = buildMidi(480, [tempoTrack(), venue])
		const result = parseNotesFromMidi(midi, defaultMetadata)

		expect(result.trackData).toHaveLength(0)
		expect(result.unrecognizedMidiTracks).toHaveLength(1)
		expect(result.unrecognizedMidiTracks[0].trackName).toBe('VENUE')
	})

	it('ignores trackName events past tick 0', () => {
		// Only tick-0 trackNames count. A trackName event later in the file
		// must not be picked up.
		const malformed: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'NOT_A_REAL_NAME' },
			{ deltaTime: 1, type: 'trackName', text: 'PART BASS' },
			{ deltaTime: 480, type: 'endOfTrack' },
		]
		const midi = buildMidi(480, [tempoTrack(), malformed])
		const result = parseNotesFromMidi(midi, defaultMetadata)

		expect(result.trackData.some(t => t.instrument === 'bass')).toBe(false)
		expect(result.unrecognizedMidiTracks).toHaveLength(1)
		expect(result.unrecognizedMidiTracks[0].trackName).toBe('NOT_A_REAL_NAME')
	})
})

describe('MIDI: track-name letter case', () => {
	it.each([
		['part drums', 97, 'drums'],
		['Part Guitar', 96, 'guitar'],
		['t1 gems', 96, 'guitar'],
		['PART DRUM', 97, 'drums'],
		['part guitar ghl', 95, 'guitarghl'],
	] as const)('recognizes %s in every profile, as Clone Hero lowercases names', (name, noteNumber, instrument) => {
		const midi = buildMidi(480, [tempoTrack(), trackWithLeadingNames([name], noteNumber)])
		expect(parseNotesFromMidi(midi, defaultMetadata).unrecognizedMidiTracks).toHaveLength(0)
		expect(parseChartFile(midi, 'mid').trackData.map(track => track.instrument)).toEqual([instrument])
		expect(parseChartFileFrozenLegacyIdentity(midi, 'mid').trackData.map(track => track.instrument)).toEqual([instrument])
		const canonical = canonical20260801.parseSource({ source: { format: 'mid', bytes: midi }, modifiers: defaultMetadata })
		expect(canonical.kind === 'accepted' && canonical.chart.tracks.map(track => track.key.instrument)).toEqual([instrument])
	})

	it('reads a lowercase events track, including the coda that marks drum freestyle', () => {
		const events: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'events' },
			{ deltaTime: 0, type: 'text', text: '[section intro]' },
			{ deltaTime: 480, type: 'text', text: '[coda]' },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const drums: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'trackName', text: 'part drums' },
			{ deltaTime: 0, type: 'text', text: 'part drums' },
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 97, velocity: 100 },
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 120, velocity: 100 },
			{ deltaTime: 960, type: 'noteOff', channel: 0, noteNumber: 97, velocity: 0 },
			{ deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 120, velocity: 0 },
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 120, velocity: 100 },
			{ deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 120, velocity: 0 },
			{ deltaTime: 0, type: 'endOfTrack' },
		]
		const result = parseNotesFromMidi(buildMidi(480, [tempoTrack(), events, drums]), defaultMetadata)
		expect(result.sections.map(section => section.name)).toEqual(['intro'])
		const expert = result.trackData.find(track => track.instrument === 'drums' && track.difficulty === 'expert')!
		expect(expert.drumFreestyleSections.map(section => section.isCoda)).toEqual([false, true])
		expect(expert.textEvents).toEqual([])
	})
})

describe('MIDI: track 0', () => {
	const conductor = (name: string, extra: MidiData['tracks'][number] = []): MidiData['tracks'][number] => [
		{ deltaTime: 0, type: 'trackName', text: name },
		{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 },
		...extra,
		{ deltaTime: 0, type: 'endOfTrack' },
	]

	it('is never an instrument track, in any profile, as Clone Hero reads instruments from track 1 on', () => {
		const guitarNotes: MidiData['tracks'][number] = [
			{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },
			{ deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
		]
		const midi = buildMidi(480, [conductor('PART GUITAR', guitarNotes), trackWithLeadingNames(['PART BASS'], 96)])
		const instruments = (tracks: readonly { instrument: string }[]) => tracks.map(track => track.instrument)
		expect(instruments(parseChartFile(midi, 'mid').trackData)).toEqual(['bass'])
		expect(instruments(parseChartFileFrozenLegacyIdentity(midi, 'mid').trackData)).toEqual(['bass'])
		const canonical = canonical20260801.parseSource({ source: { format: 'mid', bytes: midi }, modifiers: defaultMetadata })
		expect(canonical.kind === 'accepted' && canonical.chart.tracks.map(track => track.key.instrument)).toEqual(['bass'])
		expect(parseNotesFromMidi(midi, defaultMetadata).unrecognizedMidiTracks).toHaveLength(0)
	})

	it('can still be the events track', () => {
		const midi = buildMidi(480, [conductor('EVENTS', [{ deltaTime: 0, type: 'text', text: '[section intro]' }]), trackWithLeadingNames(['PART BASS'], 96)])
		expect(parseNotesFromMidi(midi, defaultMetadata).sections.map(section => section.name)).toEqual(['intro'])
	})
})
