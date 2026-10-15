import { describe, expect, it } from 'vitest'

import { scanSongFolder, type ScanOptions } from 'src/scan-song-folder'
import type { SongFile } from 'src/song-files'

import { byteSourceFile, jpeg, opus } from './helpers/media-files'

const encode = (text: string) => new TextEncoder().encode(text)
const chart = encode(['[Song]', '{', '  Resolution = 192', '}', '[SyncTrack]', '{', '  0 = TS 4', '  0 = B 120000', '}', '[Events]', '{', '}',
	'[ExpertSingle]', '{', '  768 = N 0 0', '}'].join('\r\n') + '\r\n')
const named = (...names: string[]) => names.map(fileName => ({ fileName, data: new Uint8Array(1) }))

/** Each code found in a scan of a chart, song.ini and `files`, with its severity. */
async function severities(ini: string[], files: SongFile[], options: ScanOptions = {}) {
	const scanned = await scanSongFolder([{ fileName: 'notes.chart', data: chart }, { fileName: 'song.ini', data: encode(ini.join('\r\n') + '\r\n') }, ...files], options)
	return Object.fromEntries(scanned.issues.map(issue => [issue.code, issue.severity]))
}

describe('the severities of the charting recommendations', () => {
	it('report the folder and song.ini checks at their severities', async () => {
		const ini = ['# old comment', '[song]', 'artist = Band', 'name = Song', 'album = Album', 'loading_phrase = "Hi"', 'icon = Geo', 'custom = 1',
			'diff_guitar = 12', 'delay = 90', 'modchart = False', 'pro_drums = True', 'year =']
		const files = [...named('ch.dat', 'Album.png', 'drums.ogg', 'preview.opus'), { fileName: 'video.webm', data: { size: 3.2e9, read: () => Promise.reject(new Error('read')) } }]
		expect(await severities(ini, files)).toMatchObject({
			unrecognizedFile: 'recommendation',
			fileNameCase: 'warning',
			folderSize: 'recommendation',
			audioFormat: 'recommendation',
			singleAudioName: 'recommendation',
			discouragedAudio: 'recommendation',
			iniLayout: 'recommendation',
			iniTagOrder: 'recommendation',
			blankIniValue: 'recommendation',
			quotedIniValue: 'warning',
			unknownIniTag: 'recommendation',
			missingSongLength: 'recommendation',
			missingAlbumTrack: 'recommendation',
			difficultyRange: 'recommendation',
			iconName: 'recommendation',
			deprecatedIniTag: 'recommendation',
			redundantDrumType: 'recommendation',
			defaultIniValue: 'recommendation',
		})
	})

	it('report the media checks at their severities', async () => {
		const files = [byteSourceFile('album.png', jpeg(512, 512)), byteSourceFile('song.opus', opus(120)), byteSourceFile('background.jpg', jpeg(800, 450))]
		expect(await severities(['[song]', 'song_length = 5000'], files, { mediaIssues: true })).toMatchObject({
			extensionMismatch: 'recommendation',
			audioBitrate: 'recommendation',
			backgroundSize: 'recommendation',
			songLengthMismatch: 'recommendation',
		})
	})
})
