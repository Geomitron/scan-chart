import { parseMidi, writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { calculateCompetitiveHashes } from 'src/competitive'
import { ConversionError, convertChart } from 'src/convert-chart'
import { resolveChart } from 'src/gameplay-chart'
import { songContext } from 'src/song-context'
import { documentFiles, parseSongFiles, SongDocument } from 'src/song-document'
import { fileBytes } from 'src/song-files'
import { chartSpellingIssues } from 'src/spelling-issues'

import { midiFile, midiNote, midiText, trackTexts } from './helpers/midi-files'

const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const chartSong = (sections: string[], ini: string | null = '[song]\r\nname = Song\r\nartist = Band\r\n', songLines: string[] = []) => parseSongFiles([
	{ fileName: 'notes.chart', data: encode([
		'[Song]', '{', '  Resolution = 192', ...songLines.map(line => `  ${line}`), '}',
		'[SyncTrack]', '{', '  0 = TS 4', '  0 = B 120000', '}',
		'[Events]', '{', '  0 = E "section Intro"', '}',
		...sections,
	].join('\r\n') + '\r\n') },
	...(ini === null ? [] : [{ fileName: 'song.ini', data: encode(ini) }]),
	{ fileName: 'song.ogg', data: encode('ogg') },
])
const expert = (lines: string[]) => ['[ExpertSingle]', '{', ...lines.map(line => `  ${line}`), '}']
const iniText = (song: SongDocument) => song.ini === null ? null : decode(song.ini.tokens.bytes)
const songHash = (song: SongDocument) => {
	const hashes = calculateCompetitiveHashes(song)
	return hashes.accepted ? hashes.songHash : null
}

describe('convertChart', () => {
	it('converts .chart to .mid in a new document, keeping every hash and leaving the song as it was', () => {
		const song = chartSong(expert(['0 = N 0 0', '192 = N 1 0', '384 = N 2 192', '0 = S 2 768']))
		const { song: converted, report } = convertChart(song, 'mid')
		expect(converted.chart?.format).toBe('mid')
		expect(converted.files.map(file => file.fileName)).toEqual(['notes.mid', 'song.ini', 'song.ogg'])
		expect(song.chart?.format).toBe('chart')
		expect(report).toEqual({
			tracks: [{ instrument: 'guitar', difficulty: 'expert', kept: true, causes: [] }],
			songHashKept: true,
			dropped: [],
			settings: [],
			forced: [],
		})
		expect(resolveChart(converted).sections.map(section => section.name)).toEqual(['Intro'])
	})

	it('writes sustain_cutoff_threshold only when .mid would otherwise trim a sustain, as the largest that keeps every one', () => {
		// .mid trims sustains up to a third of a beat and a tick: 65 ticks at 192 per beat.
		const { song: converted, report } = convertChart(chartSong(expert(['0 = N 0 40', '192 = N 1 64', '384 = N 2 0'])), 'mid')
		expect(report.settings).toEqual([{ key: 'sustain_cutoff_threshold', value: '39' }])
		expect(report.tracks.every(track => track.kept)).toBe(true)
		expect(iniText(converted)).toBe('[song]\r\nname = Song\r\nartist = Band\r\nsustain_cutoff_threshold = 39\r\n')
	})

	it('writes sustains of one fret that meet as standard .mid, each note-off before the next note-on', () => {
		const { song: converted, report } = convertChart(chartSong(expert(['0 = N 0 192', '192 = N 0 192', '384 = N 0 40', '424 = N 0 192'])), 'mid')
		expect(report.tracks.every(track => track.kept)).toBe(true)
		const chart = converted.chart!
		if (chart.format !== 'mid') throw new Error('not converted to .mid')
		expect(chartSpellingIssues({ format: 'mid', bytes: chart.bytes, tokens: chart.tokens }, false)).toEqual([])
	})

	it('lowers a cutoff song.ini sets, where the overlap step left a sustain no longer than it', () => {
		// The cutoff keeps the 300-tick sustains, and the overlap step then ends the first at the second, after 50 ticks.
		const song = chartSong(expert(['0 = N 0 300', '50 = N 0 300', '768 = N 1 0']), '[song]\r\nname = Song\r\nsustain_cutoff_threshold = 100\r\n')
		const lengths = (from: SongDocument) => resolveChart(from).tracks[0].noteGroups.map(group => [group[0].tick, group[0].length])
		expect(lengths(song)).toEqual([[0, 50], [50, 300], [768, 0]])
		const { song: converted, report } = convertChart(song, 'mid')
		expect(report.settings).toEqual([{ key: 'sustain_cutoff_threshold', value: '49' }])
		expect(report.tracks.every(track => track.kept)).toBe(true)
		expect(lengths(converted)).toEqual(lengths(song))
		const chart = converted.chart!
		if (chart.format !== 'mid') throw new Error('not converted to .mid')
		expect(chartSpellingIssues({ format: 'mid', bytes: chart.bytes, tokens: chart.tokens }, false)).toEqual([])
	})

	it('keeps the drum stem configuration of disco flip mix events both ways', () => {
		const drums = ['[ExpertDrums]', '{', '  0 = E mix 3 drums2', '  0 = N 1 0', '  480 = E mix 3 drums2d', '  480 = N 1 0', '  480 = N 2 0', '  960 = E mix 3 drums2', '  960 = N 1 0', '}']
		const { song: asMidi, report } = convertChart(chartSong(drums), 'mid')
		expect(report.tracks.every(track => track.kept)).toBe(true)
		const midiFile = fileBytes(documentFiles(asMidi).find(file => file.fileName === 'notes.mid')!)
		const midiMixes = parseMidi(midiFile).tracks.flatMap(track => trackTexts(track).filter(([, text]) => text.startsWith('mix')))
		expect(midiMixes).toEqual([[0, 'mix 3 drums2'], [480, 'mix 3 drums2d'], [960, 'mix 3 drums2']])
		const { song: asChart } = convertChart(asMidi, 'chart')
		const chartText = decode(fileBytes(documentFiles(asChart).find(file => file.fileName === 'notes.chart')!))
		expect(chartText.split('\r\n').filter(line => line.includes('mix '))).toEqual(['  0 = E mix 3 drums2', '  480 = E mix 3 drums2d', '  960 = E mix 3 drums2'])
	})

	it('turns a d flip off before a dnoflip both ways, keeping every TrackHash', () => {
		const drums = ['[ExpertDrums]', '{', '  480 = E mix 3 drums1d', '  480 = N 1 0', '  600 = N 2 0', '  960 = E mix 3 drums0dnoflip', '  960 = N 1 0', '}']
		const { song: asMidi, report } = convertChart(chartSong(drums), 'mid')
		expect(report.tracks.every(track => track.kept)).toBe(true)
		const midiFile = fileBytes(documentFiles(asMidi).find(file => file.fileName === 'notes.mid')!)
		const midiMixes = parseMidi(midiFile).tracks.flatMap(track => trackTexts(track).filter(([, text]) => text.startsWith('mix')))
		expect(midiMixes).toEqual([[480, 'mix 3 drums1d'], [959, 'mix 3 drums1'], [960, 'mix 3 drums0dnoflip']])
		const { song: asChart, report: back } = convertChart(asMidi, 'chart')
		expect(back.tracks.every(track => track.kept)).toBe(true)
		const chartText = decode(fileBytes(documentFiles(asChart).find(file => file.fileName === 'notes.chart')!))
		expect(chartText.split('\r\n').filter(line => line.includes('mix '))).toEqual(['  480 = E mix 3 drums1d', '  959 = E mix 3 drums1', '  960 = E mix 3 drums0dnoflip'])
	})

	it('gives a .chart song without song.ini one, so its [Song] metadata and offset read the same from a .mid', () => {
		const song = chartSong(expert(['0 = N 0 0']), null, ['Name = "From Song"', 'Offset = 0.25'])
		const { song: converted, report } = convertChart(song, 'mid')
		expect(iniText(converted)).toBe('[song]\r\nname = From Song\r\ndelay = 250\r\n')
		expect(report.songHashKept).toBe(true)
		expect(songHash(converted)).toBe(songHash(song))
	})

	it('copies a [Song] Offset into song.ini when it doesn\'t set delay, which only a .chart reads from [Song]', () => {
		const { report } = convertChart(chartSong(expert(['0 = N 0 0']), '[song]\r\nname = Song\r\ndelay = 0\r\n', ['Offset = 0.5']), 'mid')
		expect(report.settings).toEqual([{ key: 'delay', value: '500' }])
	})

	it('copies [Song] preview times into song.ini when it doesn\'t set them, but not Moonscraper\'s PreviewEnd = 0', () => {
		const previews = (end: string) => convertChart(chartSong(expert(['0 = N 0 0']), '[song]\r\nname = Song\r\n', ['PreviewStart = 30', `PreviewEnd = ${end}`]), 'mid').report.settings
		expect(previews('60')).toEqual([{ key: 'preview_start_time', value: '30000' }, { key: 'preview_end_time', value: '60000' }])
		expect(previews('0')).toEqual([{ key: 'preview_start_time', value: '30000' }])
		const iniEndZero = convertChart(chartSong(expert(['0 = N 0 0']), '[song]\r\nname = Song\r\npreview_end_time = 0\r\n', ['PreviewEnd = 60']), 'mid')
		expect(iniEndZero.report.settings).toEqual([{ key: 'preview_end_time', value: '60000' }])
	})

	it('writes multiplier_note when .mid would read solos as star power', () => {
		const solos = ['0 = E solo', '0 = N 0 0', '96 = E soloend', '192 = E solo', '192 = N 1 0', '288 = E soloend']
		const { report } = convertChart(chartSong(expert(solos)), 'mid')
		expect(report.settings).toEqual([{ key: 'multiplier_note', value: '116' }])
		expect(report.tracks.every(track => track.kept)).toBe(true)
	})

	it('takes each instrument\'s phrases from Expert, and reports the difficulties that differed', () => {
		const hard = ['[HardSingle]', '{', '  0 = N 0 0', '  192 = N 1 0', '  0 = S 2 96', '}']
		const { report } = convertChart(chartSong([...expert(['0 = N 0 0', '192 = N 1 0', '0 = S 2 384']), ...hard]), 'mid')
		expect(report.tracks).toEqual([
			{ instrument: 'guitar', difficulty: 'hard', kept: false, causes: ['starPower'] },
			{ instrument: 'guitar', difficulty: 'expert', kept: true, causes: [] },
		])
	})

	it('converts .mid to .chart, with [Song] agreeing with song.ini, and reports what .chart can\'t hold', () => {
		const midi = writeMidi({
			header: { format: 1, numTracks: 3, ticksPerBeat: 480 },
			tracks: [
				[{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 }, { deltaTime: 0, type: 'endOfTrack' }],
				[
					{ deltaTime: 0, type: 'trackName', text: 'PART GUITAR' },
					{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },
					{ deltaTime: 10, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
					{ deltaTime: 470, type: 'noteOn', channel: 0, noteNumber: 97, velocity: 100 },
					{ deltaTime: 10, type: 'noteOff', channel: 0, noteNumber: 97, velocity: 0 },
					{ deltaTime: 0, type: 'endOfTrack' },
				],
				[{ deltaTime: 0, type: 'trackName', text: 'VENUE' }, { deltaTime: 0, type: 'text', text: '[lighting (verse)]' }, { deltaTime: 0, type: 'endOfTrack' }],
			],
		})
		const song = parseSongFiles([{ fileName: 'notes.mid', data: new Uint8Array(midi) }, { fileName: 'song.ini', data: encode('[song]\r\nname = Midi Song\r\n') }])
		const { song: converted, report } = convertChart(song, 'chart')
		expect(converted.files.map(file => file.fileName)).toEqual(['notes.chart', 'song.ini'])
		expect(report.tracks).toEqual([{ instrument: 'guitar', difficulty: 'expert', kept: true, causes: [] }])
		expect(report.dropped).toEqual([{ content: 'MIDI track VENUE', count: 1 }])
		expect(decode(fileBytes(documentFiles(converted)[0])).split('}')[0]).toBe('[Song]\r\n{\r\n  Resolution = 480\r\n  Name = "Midi Song"\r\n')
		expect(iniText(converted)).toBe('[song]\r\nname = Midi Song\r\n')
	})

	it('reports EVENTS text that [Events] would read as a coda, and a coda in a lyric event, as dropped from .chart', () => {
		const midi = midiFile([
			{ name: 'EVENTS', events: [midiText(0, '[coda'), midiText(0, '[coda]', 'lyrics'), midiText(0, '[crowd_clap]')] },
			{ name: 'PART GUITAR', events: midiNote(0, 96) },
		])
		const { song: converted, report } = convertChart(parseSongFiles([{ fileName: 'notes.mid', data: midi }]), 'chart')
		expect(report.dropped).toEqual([
			{ content: 'events track MIDI events', count: 1 },
			{ content: 'events track text that [Events] would read as an event', count: 1 },
		])
		expect(decode(fileBytes(documentFiles(converted)[0]))).toContain('[Events]\r\n{\r\n  0 = E "crowd_clap"\r\n}')
	})

	it('keeps a lyric on a vocal phrase\'s end tick in that phrase both ways', () => {
		const events = [
			'0 = E "phrase_start"', '0 = E "lyric Hel-"', '192 = E "phrase_end"', '192 = E "lyric lo"',
			'768 = E "phrase_start"', '768 = E "lyric la"', '960 = E "phrase_end"',
		]
		const song = parseSongFiles([{ fileName: 'notes.chart', data: encode([
			'[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = B 120000', '}',
			'[Events]', '{', ...events.map(line => `  ${line}`), '}', ...expert(['0 = N 0 0']),
		].join('\r\n') + '\r\n') }])
		const phrases = (converted: SongDocument) => {
			const { chart } = songContext(converted)
			return chart.kind === 'parsed' ? chart.parsed.vocalTracks.parts.vocals.notePhrases.map(phrase => [phrase.tick, phrase.length, phrase.lyrics.map(lyric => lyric.text)]) : null
		}
		expect(phrases(song)).toEqual([[0, 192, ['Hel-', 'lo']], [768, 192, ['la']]])
		const asMidi = convertChart(song, 'mid').song
		expect(phrases(asMidi)).toEqual(phrases(song))
		expect(phrases(convertChart(asMidi, 'chart').song)).toEqual(phrases(song))
	})

	it('refuses a value .mid can\'t store unless forced, and then writes the nearest', () => {
		const slow = parseSongFiles([{ fileName: 'notes.chart', data: encode(['[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = B 2000', '}', ...expert(['0 = N 0 0']), ''].join('\r\n')) }])
		expect(() => convertChart(slow, 'mid')).toThrow(ConversionError)
		const { song: converted, report } = convertChart(slow, 'mid', { force: true })
		expect(report.forced).toEqual([{ kind: 'tempo', tick: 0, value: 2, nearest: 60_000_000 / 0xffffff }])
		expect(resolveChart(converted).tempos[0].beatsPerMinute).toBeCloseTo(3.5763, 3)
	})

	it('refuses a song already in the format, or without a chart', () => {
		expect(() => convertChart(chartSong(expert(['0 = N 0 0'])), 'chart')).toThrow('already')
		expect(() => convertChart(parseSongFiles([{ fileName: 'song.ini', data: encode('[song]\n') }]), 'mid')).toThrow('no chart')
	})
})
