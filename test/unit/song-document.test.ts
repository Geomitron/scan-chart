import { writeMidi } from '@geomitron/midi-file'
import { describe, expect, it } from 'vitest'

import { parseSong, serializeSong } from 'src/song-document'

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

	it('have no chart or song.ini when the folder has none', () => {
		const song = parseSong([file('readme.txt', 'hi')])
		expect(song.chart).toBeNull()
		expect(song.ini).toBeNull()
	})
})
