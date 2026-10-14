import { describe, expect, it } from 'vitest'

import { chartAuthoredTracks } from 'src/chart/authored-view'
import { createSong } from 'src/create-song'
import { resolveChart } from 'src/gameplay-chart'
import { PlannedFile, savePlanToBlobs, serializeSong, writeSavePlanFile } from 'src/save-plan'
import { editSong, parseSongFiles, SongDocument, songOrigin } from 'src/song-document'
import { byteSourceFromBlob, ByteSource } from 'src/song-files'

const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const chartText = ['[Song]', '{', '  Resolution = 192', '  Name = "Song"', '}', '[SyncTrack]', '{', '  0 = B 120000', '}', '[Events]', '{', '}',
	'[ExpertSingle]', '{', '  0 = N 0 0', '  192 = N 1 0', '}', '[HardSingle]', '{', '  0 = N 0 0', '}', ''].join('\n')
const audio = byteSourceFromBlob(new Blob([encode('audio bytes')]))
const files = () => [
	{ fileName: 'notes.chart', data: encode(chartText) },
	{ fileName: 'song.ini', data: encode('[song]\nname = Song\n') },
	{ fileName: 'song.ogg', data: audio },
]
const bytesOf = (file: PlannedFile) => {
	const piece = file.pieces[0]
	return piece instanceof Uint8Array ? decode(piece) : null
}
const lengthenExpertNote = (song: SongDocument) => {
	const expert = chartAuthoredTracks(song.chart?.format === 'chart' ? song.chart.tokens : null!).find(track => track.sectionName === 'ExpertSingle')!
	return editSong(song, batch => batch.setLength(expert.events.find(event => event.tick === 192)!, 96))
}

describe('save plans', () => {
	it('give back a song no edit made byte for byte, leaving byte sources unread', () => {
		const plan = serializeSong(parseSongFiles(files()))
		expect(plan.report).toEqual({ spentHashes: null, normalized: [], withheld: [] })
		expect(plan.files.map(file => [file.fileName, file.size])).toEqual([['notes.chart', chartText.length], ['song.ini', 19], ['song.ogg', 11]])
		expect(bytesOf(plan.files[0])).toBe(chartText)
		expect(plan.files[2].pieces).toEqual([{ source: audio, offset: 0, length: 11 }])
	})

	it('normalize an edited song against the song its chain of edits started from', () => {
		const original = parseSongFiles(files())
		const once = lengthenExpertNote(original)
		const twice = editSong(once, batch => batch.setMetadata('artist', 'Band'))
		expect(songOrigin(twice)).toBe(songOrigin(once))
		expect(songOrigin(once)?.song).toBe(original)

		const plan = serializeSong(twice)
		expect(plan.report.spentHashes).toEqual(['canonical:guitar:expert', 'canonical:song'])
		expect(plan.report.normalized).toEqual([{ kind: 'lineEndings', section: null }, { kind: 'songSection', section: 'Song' }])
		expect(bytesOf(plan.files[0])).toBe(chartText.replace('  192 = N 1 0', '  192 = N 1 96').replace('  Name = "Song"', '  Name = "Song"\n  Artist = "Band"').replace(/\n/g, '\r\n'))
		// The original's hashes are kept and the original is let go.
		expect(songOrigin(twice)?.song).toBeNull()
		expect(songOrigin(twice)?.hashes?.get('canonical:guitar:hard')).toMatch(/./)
		expect(serializeSong(twice).report).toEqual(plan.report)
	})

	it('become Blobs, copying a Blob byte source without reading it', async () => {
		const blobs = savePlanToBlobs(serializeSong(parseSongFiles(files())))
		expect(await Promise.all(blobs.map(async ({ fileName, blob }) => [fileName, await blob.text()])))
			.toEqual([['notes.chart', chartText], ['song.ini', '[song]\nname = Song\n'], ['song.ogg', 'audio bytes']])
		const other: ByteSource = { size: 1, read: async () => new Uint8Array([1]) }
		expect(() => savePlanToBlobs(serializeSong(parseSongFiles([{ fileName: 'song.ogg', data: other }])))).toThrow('writeSavePlanFile')
	})

	it('write a file to a stream, reading its byte ranges, then close it', async () => {
		const reads: [number, number][] = []
		const source: ByteSource = { size: 5, read: async (offset, length) => { reads.push([offset, length]); return encode('hello').subarray(offset, offset + length) } }
		const chunks: Uint8Array[] = []
		let closed = false
		const stream = new WritableStream<Uint8Array>({ write: chunk => { chunks.push(chunk) }, close: () => { closed = true } })
		await writeSavePlanFile({ fileName: 'a', size: 8, pieces: [encode('>> '), { source, offset: 0, length: 5 }] }, stream)
		expect(chunks.map(decode).join('')).toBe('>> hello')
		expect(reads).toEqual([[0, 5]])
		expect(closed).toBe(true)
	})
})

describe('createSong', () => {
	it('makes a .chart song whose [Song] section agrees with its song.ini', () => {
		const song = createSong({ format: 'chart', metadata: { name: 'New Song', artist: 'Band', delay: 250, pro_drums: true } })
		const [chart, ini] = serializeSong(song).files
		expect(bytesOf(ini)).toBe('[song]\r\nname = New Song\r\nartist = Band\r\ndelay = 250\r\npro_drums = True\r\n')
		expect(bytesOf(chart)).toBe(['[Song]', '{', '  Resolution = 192', '  Name = "New Song"', '  Artist = "Band"', '  Offset = 0.25', '}',
			'[SyncTrack]', '{', '  0 = TS 4', '  0 = B 120000', '}', '[Events]', '{', '}', ''].join('\r\n'))
		expect(resolveChart(song)).toMatchObject({ format: 'chart', resolution: 192, tempos: [{ tick: 0, beatsPerMinute: 120 }], tracks: [] })
	})

	it('makes a .mid song with an events track for practice sections', () => {
		const song = createSong({ format: 'mid', resolution: 960 })
		const edited = editSong(song, batch => batch.addTextEvent(0, '[section Intro]'))
		expect(resolveChart(edited)).toMatchObject({ format: 'mid', resolution: 960, sections: [{ tick: 0, name: 'Intro' }] })
		expect(bytesOf(serializeSong(song).files[1])).toBe('[song]\r\n')
	})

	it('refuses a resolution the format can\'t hold, and chartOffsetMs', () => {
		expect(() => createSong({ format: 'mid', resolution: 0x8000 })).toThrow('resolution')
		expect(() => createSong({ format: 'chart', resolution: 1.5 })).toThrow('resolution')
		expect(() => createSong({ format: 'chart', metadata: { chartOffsetMs: 10 } })).toThrow('delay')
	})
})
