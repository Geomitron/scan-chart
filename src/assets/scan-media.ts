import type { FolderFinding, MetadataFinding } from '../issues'
import { getBasename, getExtension, hasBackgroundImageName, hasCrowdOrPreviewName, hasGameVideoName, imageExtensions } from '../shared/file-names'
import { readFileBytes, readRange, type SongFile } from '../song-files'
import { type AudioInfo, contentType, type ContentType, readAudioInfo, readWebmVideoCodec } from './media-headers'
import { imageSize } from './scan-image'

// The charting guidelines' audio bitrates, in kbps: Opus at 80, and Ogg Vorbis from 192 to 320. An Opus file's average
// varies around the bitrate it was encoded at, and a stem's is lower where it's quiet, so only a lone audio file's low
// average is reported.
const OPUS_KBPS = 80
const OPUS_MIN_KBPS = 60
const OPUS_MAX_KBPS = 100
const VORBIS_MIN_KBPS = 192
const VORBIS_MAX_KBPS = 320
/** How far song_length can be from the longest audio file's length: encoders pad audio by tens of milliseconds. */
const SONG_LENGTH_TOLERANCE_MS = 1000
const MIN_BACKGROUND = { width: 1280, height: 720 }

/** What each content type is called in a message, and the extension it's written with, when games read it. */
const contentNames: { readonly [type in ContentType]: { readonly name: string; readonly extension: string | null } } = {
	opus: { name: 'Opus audio', extension: 'opus' },
	vorbis: { name: 'Ogg Vorbis audio', extension: 'ogg' },
	ogg: { name: 'Ogg data that isn\'t Opus or Vorbis', extension: null },
	mp3: { name: 'MP3 audio', extension: 'mp3' },
	wav: { name: 'WAV audio', extension: 'wav' },
	flac: { name: 'FLAC audio', extension: null },
	aiff: { name: 'AIFF audio', extension: null },
	png: { name: 'a PNG image', extension: 'png' },
	jpeg: { name: 'a JPEG image', extension: 'jpg' },
	gif: { name: 'a GIF image', extension: null },
	bmp: { name: 'a BMP image', extension: null },
	webp: { name: 'a WebP image', extension: null },
	webm: { name: 'WebM video', extension: null },
	mp4: { name: 'MP4 video', extension: null },
	avi: { name: 'AVI video', extension: null },
}
/** The content each extension names. */
const extensionContent: { readonly [extension: string]: ContentType } = { opus: 'opus', ogg: 'vorbis', mp3: 'mp3', wav: 'wav', png: 'png', jpg: 'jpeg', jpeg: 'jpeg' }

/** What the media checks found: the issues, and the audio files that hold Opus audio whatever their extension. */
export interface MediaScan {
	readonly folderIssues: FolderFinding[]
	readonly metadataIssues: MetadataFinding[]
	readonly opusFiles: readonly string[]
}

/**
 * The issues found reading the media files: an extension that doesn't match the content, audio bitrates, song_length
 * against the longest audio file, background image sizes, and a WebM video's codec. Audio and video files are read only
 * in their headers; background images are read whole.
 *
 * `stemFiles` are the audio files named as stems, `songLength` is song.ini's song_length, or `null` when it isn't set.
 */
export async function scanMedia(files: readonly SongFile[], stemFiles: readonly SongFile[], songLength: number | null): Promise<MediaScan> {
	const folderIssues: FolderFinding[] = []
	const opusFiles: string[] = []
	const mismatch = (fileName: string, content: ContentType | null) => {
		const extension = getExtension(fileName).toLowerCase()
		if (content === null || extensionContent[extension] === content) return
		const { name, extension: proper } = contentNames[content]
		folderIssues.push({
			folderIssue: 'extensionMismatch',
			description: proper === null
				? `"${fileName}" holds ${name}, which games don't read in a .${extension} file. Convert it.`
				: `"${fileName}" holds ${name}. Rename it to "${getBasename(fileName)}.${proper}".`,
			file: fileName,
		})
	}

	const durations: (number | null)[] = []
	const isLone = stemFiles.filter(file => !hasCrowdOrPreviewName(file.fileName)).length === 1
	for (const file of stemFiles) {
		const head = await readRange(file, 0, 64)
		const content = contentType(head)
		mismatch(file.fileName, content)
		if (content === 'opus') opusFiles.push(file.fileName)
		const info = await readAudioInfo(file)
		if (!hasCrowdOrPreviewName(file.fileName)) durations.push(info?.durationMs ?? null)
		const bitrate = info === null ? null : bitrateIssue(file.fileName, info, isLone && !hasCrowdOrPreviewName(file.fileName))
		if (bitrate !== null) folderIssues.push({ folderIssue: 'audioBitrate', description: bitrate, file: file.fileName })
	}

	const metadataIssues: MediaScan['metadataIssues'] = []
	// The longest audio file is known only when every one was read.
	if (songLength !== null && durations.length > 0 && durations.every(duration => duration !== null)) {
		const longest = Math.round(Math.max(...durations as number[]))
		if (Math.abs(songLength - longest) > SONG_LENGTH_TOLERANCE_MS) {
			metadataIssues.push({
				metadataIssue: 'songLengthMismatch',
				description: `The "song_length" value is ${songLength}, but the longest audio file is ${longest} ms long. Set song_length to the longest audio file's length.`,
			})
		}
	}

	for (const file of files) {
		const lowercase = file.fileName.toLowerCase()
		if (getBasename(lowercase) === 'album' && imageExtensions.includes(getExtension(lowercase))) mismatch(file.fileName, contentType(await readRange(file, 0, 64)))
		if (hasBackgroundImageName(file.fileName)) {
			const bytes = await readFileBytes(file)
			mismatch(file.fileName, contentType(bytes.subarray(0, 64)))
			const size = imageSize(bytes)
			if (size !== null && (size.width < MIN_BACKGROUND.width || size.height < MIN_BACKGROUND.height)) {
				folderIssues.push({
					folderIssue: 'backgroundSize',
					description: `"${file.fileName}" is ${size.width}x${size.height}. Background images should be at least ${MIN_BACKGROUND.width}x${MIN_BACKGROUND.height}.`,
					file: file.fileName,
				})
			}
		}
		if (hasGameVideoName(file.fileName) && getExtension(lowercase) === 'webm') {
			const codec = await readWebmVideoCodec(file)
			if (codec !== null && codec !== 'V_VP8') {
				folderIssues.push({
					folderIssue: 'videoCodec',
					description: `"${file.fileName}" uses the ${codec.replace(/^V_/, '')} codec. Clone Hero plays only VP8 in a .webm file: re-encode it with VP8.`,
					file: file.fileName,
				})
			}
		}
	}
	return { folderIssues, metadataIssues, opusFiles }
}

/** An audio file's bitrate against the charting guidelines, as a message, or `null` when it meets them. */
function bitrateIssue(fileName: string, info: AudioInfo, isLone: boolean): string | null {
	if (info.format === 'opus') {
		const kbps = Math.round(info.averageKbps)
		if (kbps <= OPUS_MAX_KBPS && (kbps >= OPUS_MIN_KBPS || !isLone)) return null
		return `"${fileName}" averages ${kbps} kbps. Opus audio should be about ${OPUS_KBPS} kbps.`
	}
	if (info.format === 'vorbis') {
		// A Vorbis header names the bitrate the encoder aimed for, which the guidelines mean.
		const kbps = Math.round(info.nominalKbps ?? info.averageKbps)
		if (kbps >= VORBIS_MIN_KBPS && kbps <= VORBIS_MAX_KBPS) return null
		return `"${fileName}" is encoded at ${kbps} kbps. Ogg Vorbis audio should be ${VORBIS_MIN_KBPS} to ${VORBIS_MAX_KBPS} kbps.`
	}
	return null
}
