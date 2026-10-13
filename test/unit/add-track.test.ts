import { writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { authoredTracks } from 'src/authored'
import { noteTypes } from 'src/chart/types'
import { calculateCompetitiveHashes } from 'src/competitive'
import { createSong } from 'src/create-song'
import { resolveChart } from 'src/gameplay-chart'
import { documentFiles, editSong, parseSongFiles, SongDocument } from 'src/song-document'
import { fileBytes } from 'src/song-files'

const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
/** The song's notes by track, as resolved from the edited document and from its saved files read again. */
const notes = (song: SongDocument) => resolveChart(song).tracks.map(track => [track.instrument, track.difficulty, track.noteGroups.map(group => group.map(note => [note.tick, note.type]))])
const expectSavedSame = (song: SongDocument) => {
	const reread = parseSongFiles(documentFiles(song))
	expect(notes(song)).toEqual(notes(reread))
	expect(calculateCompetitiveHashes(song)).toEqual(calculateCompetitiveHashes(reread))
}

describe('addTrack', () => {
	it('adds a .chart section that addEvent fills in the same batch', () => {
		const song = createSong({ format: 'chart', metadata: { name: 'New' } })
		const edited = editSong(song, batch => {
			const expert = batch.addTrack('guitar', 'expert')
			batch.addEvent(expert, 0, 'green', 0)
			batch.addEvent(expert, 192, 'red', 96)
			const drums = batch.addTrack('drums', 'hard')
			batch.addEvent(drums, 0, 'kick', 0)
		})
		expect(decode(fileBytes(documentFiles(edited)[0])).split('[Events]')[1]).toBe(
			'\r\n{\r\n}\r\n[ExpertSingle]\r\n{\r\n  0 = N 0 0\r\n  192 = N 1 96\r\n}\r\n[HardDrums]\r\n{\r\n  0 = N 0 0\r\n}\r\n')
		expect(notes(edited)).toEqual([['guitar', 'expert', [[[0, noteTypes.green]], [[192, noteTypes.red]]]], ['drums', 'hard', [[[0, noteTypes.kick]]]]])
		expectSavedSame(edited)
	})

	it('returns the same track when asked twice in a batch, and reuses an empty section Clone Hero reads', () => {
		const song = parseSongFiles([{ fileName: 'notes.chart', data: encode('[Song]\n{\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = B 120000\n}\n[ExpertSingle]\n{\n}\n') }])
		const edited = editSong(song, batch => {
			const track = batch.addTrack('guitar', 'expert')
			expect(batch.addTrack('guitar', 'expert')).toBe(track)
			expect(track.location).toEqual({ format: 'chart', section: 2 })
			batch.addEvent(track, 0, 'yellow', 0)
		})
		expect(decode(fileBytes(documentFiles(edited)[0]))).toBe('[Song]\n{\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  0 = N 2 0\n}\n')
	})

	it('refuses a track Clone Hero already reads events for', () => {
		const song = parseSongFiles([{ fileName: 'notes.chart', data: encode('[Song]\n{\n  Resolution = 192\n}\n[ExpertSingle]\n{\n  0 = N 0 0\n}\n') }])
		expect(() => editSong(song, batch => batch.addTrack('guitar', 'expert'))).toThrow('already has expert guitar events')
	})

	it('adds a .mid track after the last track, raising the track count, with the asked difficulty', () => {
		const song = createSong({ format: 'mid' })
		const edited = editSong(song, batch => {
			const guitar = batch.addTrack('guitar', 'hard')
			expect(guitar).toMatchObject({ instrument: 'guitar', difficulty: 'hard', location: { format: 'mid', chunk: 2 } })
			batch.addEvent(guitar, 0, 'green', 0)
			batch.addEvent(guitar, 480, 'starPower', 480)
		})
		const midi = edited.chart?.format === 'mid' ? edited.chart.tokens! : null
		expect(midi?.header.header.numTracks).toBe(3)
		expect(authoredTracks(edited.chart!).map(track => [track.instrument, track.events.map(event => [event.tick, event.type, event.scope])]))
			.toEqual([['guitar', [[0, 'green', 'hard'], [480, 'starPower', 'instrument']]]])
		expectSavedSame(edited)
	})

	it('adds a difficulty to an existing .mid track, and refuses one that has events', () => {
		const midi = writeMidi({
			header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
			tracks: [
				[{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 }, { deltaTime: 0, type: 'endOfTrack' }],
				[
					{ deltaTime: 0, type: 'trackName', text: 'PART GUITAR' },
					{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },
					{ deltaTime: 10, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
					{ deltaTime: 0, type: 'endOfTrack' },
				],
			],
		})
		const song = parseSongFiles([{ fileName: 'notes.mid', data: new Uint8Array(midi) }])
		expect(() => editSong(song, batch => batch.addTrack('guitar', 'expert'))).toThrow('already has expert guitar events')
		const edited = editSong(song, batch => batch.addEvent(batch.addTrack('guitar', 'easy'), 0, 'red', 0))
		expect(edited.chart?.format === 'mid' && edited.chart.tokens?.header.header.numTracks).toBe(2)
		expect(notes(edited)).toEqual([['guitar', 'expert', [[[0, noteTypes.green]]]], ['guitar', 'easy', [[[0, noteTypes.red]]]]])
		expectSavedSame(edited)
	})
})
