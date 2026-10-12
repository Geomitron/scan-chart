import { writeMidi } from '@geomitron/midi-file'

import type { ChartFormat } from './gameplay-chart'
import { songIniSection } from './ini/ini-edit'
import { defaultMetadata } from './ini/metadata'
import { parseSongFiles, SongDocument } from './song-document'
import type { SongMetadata } from './song-metadata'
import { songSectionAgreement } from './song-section'

/**
 * A new song: a chart file with a tempo of 120 BPM and a 4/4 time signature at tick 0 and nothing else, and a song.ini
 * holding `metadata`. A `.chart` file's `[Song]` section gets the metadata it has keys for, as saving makes it agree
 * with song.ini; a `.mid` file has an empty events track, for practice sections. The resolution defaults to each
 * format's usual one: 192 ticks per beat in `.chart`, 480 in `.mid`.
 *
 * Throws for a resolution the format can't hold, a metadata value song.ini can't hold, or `chartOffsetMs`: a new
 * song's offset is song.ini's `delay`.
 */
export function createSong(options: {
	readonly format: ChartFormat
	readonly resolution?: number
	readonly metadata?: Partial<SongMetadata>
}): SongDocument {
	const { format, metadata = {} } = options
	const resolution = options.resolution ?? (format === 'chart' ? 192 : 480)
	// A .mid header holds 15 bits of ticks per beat; the top bit means SMPTE timing.
	if (!Number.isInteger(resolution) || resolution <= 0 || (format === 'mid' && resolution >= 0x8000)) {
		throw new RangeError(`A .${format} file can't have a resolution of ${resolution}`)
	}
	if (metadata.chartOffsetMs !== undefined) throw new RangeError('A new song\'s offset is song.ini\'s delay, not chartOffsetMs')

	const entries = (Object.keys(defaultMetadata) as (keyof typeof defaultMetadata)[]).flatMap(key => {
		const value = metadata[key]
		return value === undefined ? [] : [[key, typeof value === 'boolean' ? (value ? 'True' : 'False') : String(value)] as const]
	})
	const chart = format === 'chart'
		? new TextEncoder().encode(['[Song]', '{', `  Resolution = ${resolution}`, '}', '[SyncTrack]', '{', '  0 = TS 4', '  0 = B 120000', '}', '[Events]', '{', '}', ''].join('\r\n'))
		: new Uint8Array(writeMidi({
			header: { format: 1, numTracks: 2, ticksPerBeat: resolution },
			tracks: [
				[
					{ deltaTime: 0, type: 'timeSignature', numerator: 4, denominator: 4, metronome: 24, thirtyseconds: 8 },
					{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 },
					{ deltaTime: 0, type: 'endOfTrack' },
				],
				[{ deltaTime: 0, type: 'trackName', text: 'EVENTS' }, { deltaTime: 0, type: 'endOfTrack' }],
			],
		}))
	const song = parseSongFiles([
		{ fileName: `notes.${format}`, data: chart },
		{ fileName: 'song.ini', data: new TextEncoder().encode(songIniSection(entries)) },
	])
	return songSectionAgreement(song) ?? song
}
