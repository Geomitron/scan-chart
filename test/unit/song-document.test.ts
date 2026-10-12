import { writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { chartAuthoredTracks, midiAuthoredTracks } from 'src/chart/authored-view'
import { eventTypes } from 'src/chart/raw-types'
import { editSong, parseSong, serializeSong } from 'src/song-document'

const encode = (text: string) => new TextEncoder().encode(text)
const file = (fileName: string, text: string) => ({ fileName, data: encode(text) })

describe('song documents', () => {
	it('hold the chart and song.ini Clone Hero reads, preferring notes.mid', () => {
		const files = [file('notes.chart', '[Song]\n{\n}\n'), file('song.ini', '[song]\n'), file('notes.mid', 'MThd'), file('album.png', 'png')]
		const song = parseSong(files)
		expect(song.chart).toMatchObject({ format: 'mid', fileName: 'notes.mid' })
		expect(song.ini?.fileName).toBe('song.ini')
		expect(song.files).toBe(files)
	})

	it('give back every file byte for byte when unedited, even a malformed chart', () => {
		const files = [file('notes.chart', '}\n[Song'), file('song.ini', '+/v8'), file('guitar.ogg', 'ogg')]
		const song = parseSong(files)
		expect(song.chart).toMatchObject({ format: 'chart', fileName: 'notes.chart' })
		expect(serializeSong(song)).toEqual(files)
	})

	it('keep a .mid file\'s unknown chunks and trailing bytes, and give it back byte for byte', () => {
		const midi = writeMidi({
			header: { format: 1, numTracks: 1, ticksPerBeat: 480 },
			tracks: [[{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 }, { deltaTime: 0, type: 'endOfTrack' }]],
		})
		const unknownChunk = [...encode('XTRA'), 0, 0, 0, 2, 0xab, 0xcd]
		const bytes = new Uint8Array([...midi, ...unknownChunk, 0x00])
		const files = [{ fileName: 'notes.mid', data: bytes }]
		const song = parseSong(files)
		expect(song.chart).toMatchObject({ format: 'mid', readError: null })
		expect(song.chart?.format === 'mid' && song.chart.tokens?.chunks.map(chunk => chunk.id)).toEqual(['MTrk', 'XTRA'])
		expect(serializeSong(song)).toEqual(files)
	})

	it('apply a batch of edits as one new document, leaving the earlier one as it was', () => {
		const chart = '[Song]\r\n{\r\n  Resolution = 192\r\n}\r\n[ExpertDrums]\r\n{\r\n  0 = N 0 0\r\n  384 = N 2 0\r\n}\r\n'
		const files = [file('notes.chart', chart), file('song.ini', '[song]\r\nname = Song\r\n')]
		const song = parseSong(files)
		const [kick] = song.chart?.format === 'chart' ? chartAuthoredTracks(song.chart.tokens)[0].events : []
		const edited = editSong(song, batch => {
			batch.setLength(kick, 96)
			batch.addToChartSection(1, 192, eventTypes.redDrum, 0)
		})
		const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
		expect(decode(serializeSong(edited)[0].data)).toBe('[Song]\r\n{\r\n  Resolution = 192\r\n}\r\n[ExpertDrums]\r\n{\r\n  0 = N 0 96\r\n  192 = N 1 0\r\n  384 = N 2 0\r\n}\r\n')
		expect(serializeSong(edited)[1]).toEqual(files[1])
		expect(serializeSong(song)).toEqual(files)
	})

	it('edit a .mid chart through the same batch', () => {
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
		const song = parseSong([{ fileName: 'notes.mid', data: new Uint8Array(midi) }])
		const [green] = song.chart?.format === 'mid' && song.chart.tokens ? midiAuthoredTracks(song.chart.tokens)[0].events : []
		const edited = editSong(song, batch => batch.setLength(green, 240))
		const reread = parseSong(serializeSong(edited))
		expect(reread.chart?.format === 'mid' && reread.chart.tokens ? midiAuthoredTracks(reread.chart.tokens)[0].events.map(event => event.length) : []).toEqual([240])
	})

	it('apply a tick and a length set on one event in one batch, in either format', () => {
		const chart = '[Song]\n{\n  Resolution = 192\n}\n[ExpertSingle]\n{\n  0 = N 0 0\n}\n'
		const chartSong = parseSong([file('notes.chart', chart)])
		const [note] = chartSong.chart?.format === 'chart' ? chartAuthoredTracks(chartSong.chart.tokens)[0].events : []
		const editedChart = editSong(chartSong, batch => { batch.setTick(note, 96); batch.setLength(note, 48) })
		expect(new TextDecoder().decode(serializeSong(editedChart)[0].data)).toBe('[Song]\n{\n  Resolution = 192\n}\n[ExpertSingle]\n{\n  96 = N 0 48\n}\n')

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
		const midSong = parseSong([{ fileName: 'notes.mid', data: new Uint8Array(midi) }])
		const [green] = midSong.chart?.format === 'mid' && midSong.chart.tokens ? midiAuthoredTracks(midSong.chart.tokens)[0].events : []
		const editedMid = parseSong(serializeSong(editSong(midSong, batch => { batch.setTick(green, 480); batch.setLength(green, 240) })))
		expect(editedMid.chart?.format === 'mid' && editedMid.chart.tokens
			? midiAuthoredTracks(editedMid.chart.tokens)[0].events.map(event => [event.tick, event.length]) : []).toEqual([[480, 240]])
	})

	it('have no chart or song.ini when the folder has none', () => {
		const song = parseSong([file('readme.txt', 'hi')])
		expect(song.chart).toBeNull()
		expect(song.ini).toBeNull()
	})
})
