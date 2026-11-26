import { parseMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { authoredTracks } from 'src/authored'
import { writeMidiFile } from 'src/chart/midi-writer'
import { parseChartAndIni } from 'src/chart/parse-chart-and-ini'
import { parseChartFile, parseChartFileCanonicalIdentity, parseChartFileFrozenLegacyIdentity } from 'src/chart/parse-chart-file'
import { noteFlags } from 'src/chart/types'
import { calculateCompetitiveHashes, frozenLegacy6142 } from 'src/competitive'
import { convertChart } from 'src/convert-chart'
import { defaultMetadata } from 'src/ini/metadata'
import { documentFiles, editSong, parseSongFiles, type SongDocument } from 'src/song-document'
import { fileBytes } from 'src/song-files'

import { midiFile, midiNote, midiText, type TimedMidiEvent } from './helpers/midi-files'

const parsers = { scanner: parseChartFile, canonical: parseChartFileCanonicalIdentity, legacy: parseChartFileFrozenLegacyIdentity }
type Parse = typeof parseChartFile
const drumsMidi = (events: readonly TimedMidiEvent[]) => midiFile([{ name: 'PART DRUMS', events }])
/** A flip from 0 to 960 over red notes at 480 and 1440, its mix events written as `type` events, or left out. */
const flipped = (type: 'text' | 'lyrics' | null) => drumsMidi([
	...(type === null ? [] : [midiText(0, '[mix 3 drums0d]', type), midiText(960, '[mix 3 drums0]', type)]),
	...midiNote(480, 97), ...midiNote(1440, 97),
])
/** [ENABLE_CHART_DYNAMICS] and the flip in lyric events, over a red accent at 480 and a red ghost at 1440. */
const dynamicFlip = drumsMidi([
	midiText(0, '[ENABLE_CHART_DYNAMICS]', 'lyrics'), midiText(0, '[mix 3 drums0d]', 'lyrics'), midiText(960, '[mix 3 drums0]', 'lyrics'),
	...midiNote(480, 97, 0, { velocity: 127 }), ...midiNote(1440, 97, 0, { velocity: 1 }),
])
const expertDrums = (data: Uint8Array, parse: Parse) => parse(data, 'mid').trackData.find(track => track.instrument === 'drums' && track.difficulty === 'expert')!
/** Each Expert drum note's tick and its disco, accent and ghost flags, or `-` without one. */
const expertFlags = (data: Uint8Array, parse: Parse) => expertDrums(data, parse).noteEventGroups.flat().map(({ tick, flags }) =>
	[tick, (['disco', 'accent', 'ghost'] as const).filter(flag => flags & noteFlags[flag]).join('+') || '-'])
/** A track's events kept as written, each as its type and text. */
const keptEvents = (data: Uint8Array, instrument: 'drums' | 'guitar') => parsers.scanner(data, 'mid').trackData
	.find(track => track.instrument === instrument)!.unrecognizedMidiEvents.map(event => [event.type, 'text' in event ? event.text : null])
const song = (data: Uint8Array) => parseSongFiles([{ fileName: 'notes.mid', data }])
const songMidi = (song: SongDocument) => fileBytes(documentFiles(song).find(file => file.fileName === 'notes.mid')!)
/** Each of the drums track's text and lyric events, as its tick, type and text. */
const drumsTexts = (data: Uint8Array) => {
	const track = parseMidi(data).tracks.find(events => events.some(event => event.type === 'trackName' && event.text === 'PART DRUMS'))!
	let tick = 0
	return track.flatMap(event => {
		tick += event.deltaTime
		return event.type === 'text' || event.type === 'lyrics' ? [[tick, event.type, event.text]] : []
	})
}
const canonicalDrumsHash = (data: Uint8Array) => {
	const hashes = calculateCompetitiveHashes(song(data))
	return hashes.accepted ? hashes.tracks.find(track => track.instrument === 'drums' && track.difficulty === 'expert')?.trackHash : null
}
const legacyDrumsHash = (data: Uint8Array) => {
	const parsed = frozenLegacy6142.parseSource({ source: { format: 'mid', bytes: data }, modifiers: defaultMetadata })
	if (parsed.kind !== 'accepted') throw new Error('Expected the frozen profile to accept the file')
	return frozenLegacy6142.calculateTrackIdentity({ chart: parsed.chart, instrument: 'drums', difficulty: 'expert' }).trackHash.value
}

describe('a .mid drums track\'s mix events and [ENABLE_CHART_DYNAMICS] in lyric events (FF 05)', () => {
	it('flips with mix events in lyric events in the scanner and canonical profiles, and not in the frozen one, as Clone Hero 1.1', () => {
		for (const parse of [parsers.scanner, parsers.canonical]) {
			expect(expertDrums(flipped('lyrics'), parse).drumMixes).toEqual([{ tick: 0, configuration: 0, flag: 'd' }, { tick: 960, configuration: 0, flag: '' }])
			expect(expertFlags(flipped('lyrics'), parse)).toEqual([[480, 'disco'], [1440, '-']])
		}
		expect(expertDrums(flipped('lyrics'), parsers.legacy).drumMixes).toEqual([])
		expect(expertFlags(flipped('lyrics'), parsers.legacy)).toEqual([[480, '-'], [1440, '-']])
	})

	it('applies [ENABLE_CHART_DYNAMICS] in a lyric event in the scanner and canonical profiles, and not in the frozen one', () => {
		for (const text of ['[ENABLE_CHART_DYNAMICS]', 'ENABLE_CHART_DYNAMICS']) {
			const data = drumsMidi([midiText(0, text, 'lyrics'), ...midiNote(0, 97, 0, { velocity: 127 }), ...midiNote(480, 97, 0, { velocity: 1 })])
			for (const parse of [parsers.scanner, parsers.canonical]) expect(expertFlags(data, parse), text).toEqual([[0, 'accent'], [480, 'ghost']])
			expect(expertFlags(data, parsers.legacy), text).toEqual([[0, '-'], [480, '-']])
		}
	})

	it('gives the drums the TrackHash of text events, and the frozen one of no mix events', () => {
		expect(canonicalDrumsHash(flipped('lyrics'))).toBe(canonicalDrumsHash(flipped('text')))
		expect(canonicalDrumsHash(flipped('lyrics'))).not.toBe(canonicalDrumsHash(flipped(null)))
		expect(legacyDrumsHash(flipped('lyrics'))).toBe(legacyDrumsHash(flipped(null)))
		expect(legacyDrumsHash(flipped('text'))).not.toBe(legacyDrumsHash(flipped(null)))
	})

	it('keeps any other lyric event as written, and these in a track other than drums', () => {
		const data = midiFile([
			{ name: 'PART DRUMS', events: [midiText(0, 'Hello', 'lyrics'), midiText(0, ' [mix 3 drums0d]', 'lyrics'), midiText(0, '[ENHANCED_OPENS]', 'lyrics'), ...midiNote(480, 97)] },
			{ name: 'PART GUITAR', events: [midiText(0, '[mix 3 drums0d]', 'lyrics'), midiText(0, '[ENABLE_CHART_DYNAMICS]', 'lyrics'), ...midiNote(480, 96)] },
		])
		expect(keptEvents(data, 'drums')).toEqual([['lyrics', 'Hello'], ['lyrics', ' [mix 3 drums0d]'], ['lyrics', '[ENHANCED_OPENS]']])
		expect(keptEvents(data, 'guitar')).toEqual([['lyrics', '[mix 3 drums0d]'], ['lyrics', '[ENABLE_CHART_DYNAMICS]']])
		expect(expertDrums(data, parsers.scanner).drumMixes).toEqual([])
	})

	it('shows the flip as authored disco flip events, and an edit moves the lyric event', () => {
		const data = flipped('lyrics')
		const unedited = song(data)
		expect(songMidi(unedited)).toEqual(data)
		const drums = authoredTracks(unedited.chart!).find(track => track.instrument === 'drums')!
		const flips = drums.events.filter(event => event.type.startsWith('disco'))
		expect(flips.map(({ tick, type, scope }) => [tick, type, scope])).toEqual([[0, 'discoFlipOn', 'expert'], [960, 'discoFlipOff', 'expert']])
		const edited = editSong(unedited, batch => batch.setTick(flips[0], 240))
		expect(drumsTexts(songMidi(edited))).toEqual([[240, 'lyrics', '[mix 3 drums0d]'], [960, 'lyrics', '[mix 3 drums0]']])
	})

	it('writes them as text events in the .mid export, which reads back the same', () => {
		const written = writeMidiFile(parseChartAndIni([{ fileName: 'notes.mid', data: dynamicFlip }]).parsedChart!)
		expect(drumsTexts(written)).toEqual([[0, 'text', 'ENABLE_CHART_DYNAMICS'], [0, 'text', 'mix 3 drums0d'], [960, 'text', 'mix 3 drums0']])
		expect(expertFlags(written, parsers.canonical)).toEqual([[480, 'disco+accent'], [1440, 'ghost']])
	})

	it('writes the flip as .chart mix events, and the dynamics as accents and ghosts, keeping every TrackHash', () => {
		const { song: asChart, report } = convertChart(song(dynamicFlip), 'chart')
		expect(report.tracks).toEqual([{ instrument: 'drums', difficulty: 'expert', kept: true, causes: [] }])
		expect(report.dropped).toEqual([])
		const chartText = new TextDecoder().decode(fileBytes(documentFiles(asChart).find(file => file.fileName === 'notes.chart')!))
		const drums = chartText.split('[ExpertDrums]\r\n{\r\n')[1].split('}')[0].split('\r\n').filter(line => line !== '')
		expect(drums).toEqual(['  0 = E mix 3 drums0d', '  480 = N 1 0', '  480 = N 34 0', '  960 = E mix 3 drums0', '  1440 = N 1 0', '  1440 = N 40 0'])
	})
})
