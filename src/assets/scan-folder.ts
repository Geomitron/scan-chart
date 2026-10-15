import type { FolderFinding } from '../issues'
import { getBasename, getExtension, hasAlbumName, hasAudioExtension, hasChartExtension, hasIniExtension, hasVideoName } from '../shared/file-names'
import { isByteSource, type SongFile } from '../song-files'

/** Chorus Encore scans a chart folder only up to 3 GB. */
const MAX_FOLDER_BYTES = 3e9

// The names some game reads, matched in any letter case. Clone Hero's and the standard's, then YARG's additions.
const audioStems = [
	'song', 'guitar', 'bass', 'rhythm', 'keys', 'vocals', 'vocals_1', 'vocals_2', 'drums', 'drums_1', 'drums_2', 'drums_3', 'drums_4', 'crowd', 'preview',
	'song_clean', 'vocals_clean', 'vocals_1_clean', 'vocals_2_clean', 'crowd_clean', 'preview_clean',
	'vocals_explicit', 'vocals_1_explicit', 'vocals_2_explicit', 'crowd_explicit',
]
const audioExtensions = ['opus', 'ogg', 'mp3', 'wav', 'aiff']
const chartImageExtensions = ['png', 'jpg', 'jpeg']
const imageExtensions = [...chartImageExtensions, 'tga', 'bmp', 'psd', 'gif', 'pic']
const videoExtensions = ['mp4', 'avi', 'webm', 'vp8', 'ogv', 'mpeg']
const yargVideoExtensions = ['mp4', 'mov', 'webm']
/** Files an operating system makes: Windows' folder settings and thumbnails, and macOS's folder settings and resource forks. */
const systemFiles = ['desktop.ini', 'thumbs.db', '.ds_store']

/**
 * The issues found from the folder's file names and sizes alone: a file no game reads, a name that matches only in
 * lowercase, and a folder too large for Chorus Encore. Reads nothing.
 */
export function scanFolderFiles(files: readonly SongFile[], options: {
	/** The chart file scan-chart reads. */
	readonly chartFile: string | null
	/** The song.ini `[song]` section, whose `background`, `video` and `cover` keys name files YARG reads. */
	readonly songSection: { readonly [key: string]: string } | null
	/** Names or patterns of the files a caller's game reads, besides these. */
	readonly extraFiles: readonly (string | RegExp)[]
}): FolderFinding[] {
	const folderIssues: FolderFinding[] = []
	const keyFiles = ['background', 'video', 'cover'].map(key => options.songSection?.[key]?.toLowerCase()).filter(name => name)
	const isExtra = (name: string) => options.extraFiles.some(extra => typeof extra === 'string' ? extra.toLowerCase() === name.toLowerCase() : extra.test(name))

	for (const { fileName } of files) {
		if (isSystemFile(fileName)) {
			folderIssues.push({
				folderIssue: 'unrecognizedFile',
				description: `"${fileName}" is a file the operating system made, and no program needs it. Remove it from the chart folder.`,
				file: fileName,
			})
			continue
		}
		// Every other chart, .ini or audio file is reported as misnamed.
		const reported = fileName === options.chartFile || hasChartExtension(fileName) || hasIniExtension(fileName) || hasAudioExtension(fileName)
		if (!reported && !isReadByGame(fileName) && !keyFiles.includes(fileName.toLowerCase()) && !isExtra(fileName)) {
			folderIssues.push({
				folderIssue: 'unrecognizedFile',
				description: `"${fileName}" isn't read by the games. Remove it from the chart folder.`,
				file: fileName,
			})
		}
		const lowercase = fileName.toLowerCase()
		if (fileName !== lowercase && (hasAlbumName(lowercase) || hasVideoName(lowercase) || isBackgroundImage(lowercase))) {
			folderIssues.push({
				folderIssue: 'fileNameCase',
				description: `"${fileName}" should be named "${lowercase}". Song folder file names are lowercase, and some games and tools find only lowercase names.`,
				file: fileName,
			})
		}
	}

	const bytes = files.reduce((total, file) => total + (isByteSource(file.data) ? file.data.size : file.data.byteLength), 0)
	if (bytes > MAX_FOLDER_BYTES) {
		folderIssues.push({
			folderIssue: 'folderSize',
			description: `This chart's files total ${(bytes / 1e9).toFixed(1)} GB. Chorus Encore scans charts only up to 3 GB, so also share a smaller version, such as one without the video background.`,
		})
	}
	return folderIssues
}

/** Whether a file is one an operating system made: in any letter case, and in a subfolder, such as `__MACOSX`, too. */
export function isSystemFile(fileName: string) {
	const path = fileName.toLowerCase().split(/[/\\]/)
	const name = path[path.length - 1]
	return systemFiles.includes(name) || name.startsWith('._') || path.includes('__macosx')
}

/** Whether a background image is named so Clone Hero and YARG both read it: `background`, then anything, then .png, .jpg or .jpeg. */
function isBackgroundImage(lowercase: string) {
	return lowercase.startsWith('background') && chartImageExtensions.includes(getExtension(lowercase))
}

/**
 * Whether Clone Hero or YARG reads a file of this name, in any letter case: the chart, song.ini, audio, album art,
 * background images and videos, and Clone Hero's highway image. A `.sng` file is another song both read.
 */
function isReadByGame(fileName: string) {
	const lowercase = fileName.toLowerCase()
	// Of the files in subfolders, only Clone Hero reads one: the first video it finds.
	if (/[/\\]/.test(lowercase)) return /(^|[/\\])video\.(mp4|avi|webm|vp8|ogv|mpeg)$/.test(lowercase)
	const [base, extension] = [getBasename(lowercase), getExtension(lowercase)]
	return (base === 'notes' && ['chart', 'mid', 'midi', 'txt'].includes(extension))
		|| lowercase === 'song.ini'
		|| (audioStems.includes(base) && audioExtensions.includes(extension))
		|| (base === 'album' && imageExtensions.includes(extension))
		// Clone Hero reads every image whose name has "background" in it; YARG reads `bg` and names starting with it.
		|| (lowercase.includes('background') && chartImageExtensions.includes(extension))
		|| ((base.startsWith('background') || ['bg', 'bg_clean', 'bg_explicit'].includes(base)) && imageExtensions.includes(extension))
		|| (base === 'video' && videoExtensions.includes(extension))
		|| (/^(bg|background|video)(_clean|_explicit)?$/.test(base) && yargVideoExtensions.includes(extension))
		|| lowercase === 'bg.yarground'
		|| (base === 'highway' && chartImageExtensions.includes(extension))
		|| extension === 'sng'
}
