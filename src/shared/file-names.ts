
/**
 * @returns extension of a file, excluding the dot. (e.g. "song.ogg" -> "ogg")
 */
export function getExtension(fileName: string) {
	return fileName.split('.').pop() ?? ''
}

/**
 * @returns basename of a file, excluding the dot. (e.g. "song.ogg" -> "song")
 */
export function getBasename(fileName: string) {
	const parts = fileName.split('.')
	return parts.length > 1 ? parts.slice(0, -1).join('.') : fileName
}

/**
 * @returns true if the list of fileName `extensions` appears to be intended as a chart folder.
 */
export function appearsToBeChartFolder(extensions: string[]) {
	const ext = extensions.map(extension => extension.toLowerCase())
	const containsNotes = ext.includes('chart') || ext.includes('mid')
	const containsAudio = ext.includes('ogg') || ext.includes('mp3') || ext.includes('wav') || ext.includes('opus')
	return containsNotes || containsAudio
}

/**
 * @returns `true` if `fileName` has a valid ini file extension.
 */
export function hasIniExtension(fileName: string) {
	return 'ini' === getExtension(fileName).toLowerCase()
}

/**
 * @returns `true` if `fileName` is a valid ini fileName.
 */
export function hasIniName(fileName: string) {
	return fileName === 'song.ini'
}

/**
 * @returns `true` if `fileName` has a valid chart file extension.
 */
export function hasChartExtension(fileName: string) {
	return ['chart', 'mid'].includes(getExtension(fileName).toLowerCase())
}

/**
 * @returns `true` if `fileName` is a valid chart fileName.
 */
export function hasChartName(fileName: string) {
	return ['notes.chart', 'notes.mid'].includes(fileName)
}

/**
 * @returns `true` if `fileName` has a valid chart audio file extension.
 */
export function hasAudioExtension(fileName: string) {
	return ['ogg', 'mp3', 'wav', 'opus'].includes(getExtension(fileName).toLowerCase())
}

const audioStemNames = ['song', 'guitar', 'bass', 'rhythm', 'keys', 'vocals', 'vocals_1', 'vocals_2', 'drums', 'drums_1', 'drums_2', 'drums_3', 'drums_4', 'crowd', 'preview']
/** The clean and explicit versions of stems that YARG reads, which the standard doesn't name. */
const extraAudioStemNames = [
	'song_clean', 'vocals_clean', 'vocals_1_clean', 'vocals_2_clean', 'crowd_clean', 'preview_clean',
	'vocals_explicit', 'vocals_1_explicit', 'vocals_2_explicit', 'crowd_explicit',
]

/**
 * @returns `true` if `fileName` has a valid chart audio fileName.
 */
export function hasAudioName(fileName: string) {
	return audioStemNames.includes(getBasename(fileName)) && ['ogg', 'mp3', 'wav', 'opus'].includes(getExtension(fileName))
}

/**
 * @returns `true` if `fileName` is a clean or explicit stem that YARG reads, which the standard doesn't name.
 */
export function hasExtraAudioName(fileName: string) {
	return extraAudioStemNames.includes(getBasename(fileName)) && ['ogg', 'mp3', 'wav', 'opus'].includes(getExtension(fileName))
}

/**
 * @returns `true` if `fileName`, in any letter case, is audio some game reads: a stem the standard or YARG names, with
 * one of the standard's extensions or YARG's `.aiff`.
 */
export function hasGameAudioName(fileName: string) {
	const lowercase = fileName.toLowerCase()
	return [...audioStemNames, ...extraAudioStemNames].includes(getBasename(lowercase)) && ['ogg', 'mp3', 'wav', 'opus', 'aiff'].includes(getExtension(lowercase))
}

/**
 * @returns `true` if `fileName`, in any letter case, is crowd or preview audio, which isn't the song's own audio.
 */
export function hasCrowdOrPreviewName(fileName: string) {
	return ['crowd', 'preview'].includes(getBasename(fileName).toLowerCase())
}

/** The image formats Clone Hero reads; YARG reads them too. */
export const imageExtensions = ['png', 'jpg', 'jpeg']

/**
 * @returns `true` if `fileName`, in any letter case, is a background image a game reads in a format both read:
 * `background`, then anything, or YARG's `bg`, `bg_clean` and `bg_explicit`.
 */
export function hasBackgroundImageName(fileName: string) {
	const base = getBasename(fileName.toLowerCase())
	return (base.startsWith('background') || ['bg', 'bg_clean', 'bg_explicit'].includes(base)) && imageExtensions.includes(getExtension(fileName).toLowerCase())
}

/**
 * @returns `true` if `fileName`, in any letter case, is a background video a game reads: Clone Hero's `video`, which
 * it also finds in a subfolder, and YARG's `bg`, `background` and `video` with their clean and explicit versions.
 */
export function hasGameVideoName(fileName: string) {
	const lowercase = fileName.toLowerCase()
	if (/[/\\]/.test(lowercase)) return /[/\\]video\.(mp4|avi|webm|vp8|ogv|mpeg)$/.test(lowercase)
	const [base, extension] = [getBasename(lowercase), getExtension(lowercase)]
	return (base === 'video' && ['mp4', 'avi', 'webm', 'vp8', 'ogv', 'mpeg'].includes(extension))
		|| (/^(bg|background|video)(_clean|_explicit)?$/.test(base) && ['mp4', 'mov', 'webm'].includes(extension))
}

/**
 * @returns `true` if `fileName` is a valid album fileName.
 */
export function hasAlbumName(fileName: string) {
	return ['album.jpg', 'album.jpeg', 'album.png'].includes(fileName)
}

/**
 * @returns `true` if `fileName` is a valid video fileName.
 */
export function hasVideoName(fileName: string) {
	return getBasename(fileName) === 'video' && ['mp4', 'avi', 'webm', 'vp8', 'ogv', 'mpeg'].includes(getExtension(fileName))
}

/**
 * @returns `true` if `fileName` is a video fileName that is not supported on Linux.
 */
export function hasBadVideoName(fileName: string) {
	return getBasename(fileName) === 'video' && ['mp4', 'avi', 'mpeg'].includes(getExtension(fileName))
}
