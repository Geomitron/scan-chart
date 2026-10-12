import { MidiEvent, writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { authoredSongEvents, midiAuthoredTracks } from 'src/chart/authored-view'
import { recordEdit } from 'src/chart/edit-history'
import { editMidiTrack } from 'src/chart/midi-edit'
import { parseMidiTokens } from 'src/chart/midi-reparse'
import { MidiTokens, readMidiTokens } from 'src/chart/midi-tokens'
import { parseChartSource } from 'src/chart/parse-chart-file'
import { parseRules } from 'src/chart/parse-rules'
import { eventTypes } from 'src/chart/raw-types'
import { editSong, parseSongFiles, SongDocument } from 'src/song-document'

const rules = parseRules.canonical20260801
const on = (deltaTime: number, noteNumber: number): MidiEvent => ({ deltaTime, type: 'noteOn', channel: 0, noteNumber, velocity: 100 })
const off = (deltaTime: number, noteNumber: number): MidiEvent => ({ deltaTime, type: 'noteOff', channel: 0, noteNumber, velocity: 0 })
const track = (name: string, ...events: MidiEvent[]): MidiEvent[] =>
	[{ deltaTime: 0, type: 'trackName', text: name }, ...events, { deltaTime: 0, type: 'endOfTrack' }]
const song = parseSongFiles([{ fileName: 'notes.mid', data: new Uint8Array(writeMidi({
	header: { format: 1, numTracks: 6, ticksPerBeat: 480 },
	tracks: [
		[{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 }, { deltaTime: 0, type: 'endOfTrack' }],
		track('PART GUITAR', on(0, 96), off(240, 96), on(240, 97), off(240, 97), on(0, 84), off(240, 84)),
		track('PART BASS', on(0, 96), off(240, 96)),
		track('PART GUITAR', on(0, 98), off(240, 98)),
		track('EVENTS', { deltaTime: 0, type: 'text', text: '[section Intro]' }),
		track('PART DRUMS', on(0, 96), off(10, 96), on(470, 98), off(10, 98)),
	],
})) }])
const drumsChunk = 5
const tokensOf = (doc: SongDocument) => doc.chart?.format === 'mid' ? doc.chart.tokens! : null!
const reread = (tokens: MidiTokens) => midiAuthoredTracks(readMidiTokens(tokens.data))
const parse = (doc: SongDocument) => parseMidiTokens(tokensOf(doc), {}, rules)
const fullParse = (doc: SongDocument) => parseChartSource({ format: 'mid', bytes: tokensOf(doc).data, tokens: readMidiTokens(tokensOf(doc).data) }, {}, rules)
const trackOf = (parsed: ReturnType<typeof parse>, instrument: string, difficulty: string) =>
	parsed.trackData.find(track => track.instrument === instrument && track.difficulty === difficulty)

describe('reading an edited .mid', () => {
	it('reuses the authored tracks of unchanged chunks, equal to reading the edited file afresh', () => {
		const before = midiAuthoredTracks(tokensOf(song))
		const edited = editSong(song, batch => batch.setLength(before[0].events[0], 480))
		const after = midiAuthoredTracks(tokensOf(edited))
		expect(after).toEqual(reread(tokensOf(edited)))
		expect(after[0]).not.toBe(before[0])
		expect(after[0].events[0].length).toBe(480)
		after.slice(1).forEach((kept, i) => expect(kept).toBe(before[i + 1]))
	})

	it('keeps every authored track after an edit of the events track', () => {
		const before = midiAuthoredTracks(tokensOf(song))
		const [intro] = authoredSongEvents({ format: 'mid', tokens: tokensOf(song) }).textEvents!
		const edited = editSong(song, batch => batch.setText(intro, '[section Verse]'))
		const after = midiAuthoredTracks(tokensOf(edited))
		expect(after).toEqual(reread(tokensOf(edited)))
		after.forEach((kept, i) => expect(kept).toBe(before[i]))
	})

	it('reads every chunk again when an edit changes which chunk holds which instrument', () => {
		const tokens = tokensOf(song)
		midiAuthoredTracks(tokens)
		// Renaming PART BASS to PART GUITAR makes it the second guitar track, and the third chunk the third.
		const renamed = editMidiTrack(tokens, 2, [{ kind: 'replace', event: 0, with: { type: 'meta', metaType: 0x03, data: new TextEncoder().encode('PART GUITAR') } }])
		recordEdit(tokens, renamed)
		const after = midiAuthoredTracks(renamed)
		expect(after).toEqual(reread(renamed))
		expect(after.filter(({ instrument }) => instrument === 'guitar').map(({ chunk, isFirst }) => [chunk, isFirst]))
			.toEqual([[1, true], [2, false], [3, false]])
	})
})

describe('reparsing an edited .mid', () => {
	it('reuses the tracks of every chunk the edit didn\'t change, and equals a full parse', () => {
		const before = parse(song)
		const guitar = midiAuthoredTracks(tokensOf(song))[0]
		const edited = editSong(song, batch => batch.setLength(guitar.events[0], 480))
		const after = parse(edited)
		expect(after).toEqual(fullParse(edited))
		expect(trackOf(after, 'guitar', 'expert')).not.toBe(trackOf(before, 'guitar', 'expert'))
		expect(trackOf(after, 'guitar', 'hard')).not.toBe(trackOf(before, 'guitar', 'hard'))
		expect(trackOf(after, 'bass', 'expert')).toBe(trackOf(before, 'bass', 'expert'))
		expect(trackOf(after, 'drums', 'expert')).toBe(trackOf(before, 'drums', 'expert'))
		// Every other chunk is unchanged, so everything parsed from them is reused.
		expect(after.tempos).toBe(before.tempos)
		expect(after.sections).toBe(before.sections)
		expect(after.vocalTracks).toBe(before.vocalTracks)
	})

	it('parses the other chunks again after an events track edit, keeping the tracks', () => {
		const before = parse(song)
		const [intro] = authoredSongEvents({ format: 'mid', tokens: tokensOf(song) }).textEvents!
		const edited = editSong(song, batch => batch.setText(intro, '[section Verse]'))
		const after = parse(edited)
		expect(after).toEqual(fullParse(edited))
		expect(after.sections).not.toBe(before.sections)
		expect(trackOf(after, 'bass', 'expert')).toBe(trackOf(before, 'bass', 'expert'))
	})

	it('resolves every track again after a tempo edit', () => {
		const before = parse(song)
		const [tempo] = authoredSongEvents({ format: 'mid', tokens: tokensOf(song) }).tempos
		const edited = editSong(song, batch => batch.setTempo(tempo, 150))
		const after = parse(edited)
		expect(after).toEqual(fullParse(edited))
		for (const resolved of after.trackData) expect(resolved).not.toBe(trackOf(before, resolved.instrument, resolved.difficulty))
	})

	it('resolves the drum tracks again when an edit changes the drum type', () => {
		const before = parse(song)
		const edited = editSong(song, batch => batch.addToMidiTrack(drumsChunk, 'instrument', 480, eventTypes.yellowTomMarker, 10))
		const after = parse(edited)
		expect(after).toEqual(fullParse(edited))
		expect(after.drumType).not.toBe(before.drumType)
		expect(trackOf(after, 'guitar', 'expert')).toBe(trackOf(before, 'guitar', 'expert'))
	})

	it('parses every chunk again when an edit changes which chunk holds which instrument', () => {
		const tokens = tokensOf(song)
		parseMidiTokens(tokens, {}, rules)
		const renamed = editMidiTrack(tokens, 2, [{ kind: 'replace', event: 0, with: { type: 'meta', metaType: 0x03, data: new TextEncoder().encode('PART GUITAR') } }])
		recordEdit(tokens, renamed)
		const after = parseMidiTokens(renamed, {}, rules)
		expect(after).toEqual(parseChartSource({ format: 'mid', bytes: renamed.data, tokens: readMidiTokens(renamed.data) }, {}, rules))
		expect(after.trackData.some(resolved => resolved.instrument === 'bass')).toBe(false)
	})

	it('gives back the same result for the same tokens, and parses again with other settings', () => {
		expect(parse(song)).toBe(parse(song))
		const withThreshold = parseMidiTokens(tokensOf(song), { sustain_cutoff_threshold: 50 }, rules)
		expect(withThreshold).toEqual(parseChartSource({ format: 'mid', bytes: tokensOf(song).data, tokens: tokensOf(song) }, { sustain_cutoff_threshold: 50 }, rules))
	})
})
