import * as _ from 'lodash'

declare global {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	interface ReadonlyArray<T> {
		includes<S, R extends `${Extract<S, string>}`>(this: ReadonlyArray<R>, searchElement: S, fromIndex?: number): searchElement is R & S
	}
}

/** Overwrites the type of a nested property in `T` with `U`. */
export type Overwrite<T, U> =
	U extends object ?
		T extends object ?
			{
				[K in keyof T]: K extends keyof U ? Overwrite<T[K], U[K]> : T[K]
			}
		:	U
	:	U
export type Subset<K> = {
	[attr in keyof K]?: NonNullable<K[attr]> extends object ? Subset<K[attr]> : K[attr]
}
export type RequireMatchingProps<T, K extends keyof T> = T & { [P in K]-?: NonNullable<T[P]> }
export type OptionalMatchingProps<T, K extends keyof T> = Omit<T, K> & { [P in K]?: T[P] }
export type ObjectValues<T> = T[keyof T]

/**
 * @returns the most likely text encoding for text in `buffer`.
 */
export function getEncoding(buffer: Uint8Array) {
	if (buffer.length < 2) {
		return 'utf-8'
	}

	if (buffer[0] === 0xff && buffer[1] === 0xfe) {
		return 'utf-16le'
	}

	if (buffer[0] === 0xfe && buffer[1] === 0xff) {
		return 'utf-16be'
	}

	return 'utf-8'
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
 * @returns extension of a file, excluding the dot. (e.g. "song.ogg" -> "ogg")
 */
export function getExtension(fileName: string) {
	return _.last(fileName.split('.')) ?? ''
}

/**
 * @returns basename of a file, excluding the dot. (e.g. "song.ogg" -> "song")
 */
export function getBasename(fileName: string) {
	const parts = fileName.split('.')
	return parts.length > 1 ? parts.slice(0, -1).join('.') : fileName
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

/**
 * @returns `true` if `fileName` has a valid chart audio fileName.
 */
export function hasAudioName(fileName: string) {
	return (
		[
			'song',
			'guitar',
			'bass',
			'rhythm',
			'keys',
			'vocals',
			'vocals_1',
			'vocals_2',
			'drums',
			'drums_1',
			'drums_2',
			'drums_3',
			'drums_4',
			'crowd',
			'preview',
		].includes(getBasename(fileName)) && ['ogg', 'mp3', 'wav', 'opus'].includes(getExtension(fileName))
	)
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

const allowedTags = [
	'align',
	'allcaps',
	'alpha',
	'b',
	'br',
	'color',
	'cspace',
	'font',
	'font-weight',
	'gradient',
	'i',
	'indent',
	'line-height',
	'line-indent',
	'link',
	'lowercase',
	'margin',
	'mark',
	'mspace',
	'nobr',
	'noparse',
	'page',
	'pos',
	'rotate',
	's',
	'size',
	'smallcaps',
	'space',
	'sprite',
	'strikethrough',
	'style',
	'sub',
	'sup',
	'u',
	'uppercase',
	'voffset',
	'width',
]
const tagPattern = allowedTags.map(tag => `\\b${tag}\\b`).join('|')
/**
 * @returns `text` with all style tags removed. (e.g. "<color=#AEFFFF>Aren Eternal</color> & Geo" -> "Aren Eternal & Geo")
 */
export function removeStyleTags(text: string) {
	let oldText = text
	let newText = text
	do {
		oldText = newText
		newText = newText.replace(new RegExp(`<\\s*\\/?\\s*(?:#|${tagPattern})[^>]*>`, 'gi'), '').trim()
	} while (newText !== oldText)
	return newText
}

/**
 * @returns `true` if `value` is an array of `T` items.
 */
export function isArray<T>(value: T | readonly T[]): value is readonly T[] {
	return Array.isArray(value)
}

/**
 * Converts `val` from the range (`fromStart`, `fromEnd`) to the range (`toStart`, `toEnd`).
 */
export function interpolate(val: number, fromStart: number, fromEnd: number, toStart: number, toEnd: number) {
	return ((val - fromStart) / (fromEnd - fromStart)) * (toEnd - toStart) + toStart
}

/**
 * @returns an string representation of `ms` that looks like HH:MM:SS.mm
 */
export function msToExactTime(ms: number) {
	const seconds = _.floor((ms / 1000) % 60, 2)
	const minutes = _.floor((ms / 1000 / 60) % 60)
	const hours = _.floor((ms / 1000 / 60 / 60) % 24)
	return `${hours ? `${hours}:` : ''}${_.padStart(minutes + '', 2, '0')}:${_.padStart(seconds.toFixed(2), 5, '0')}`
}

/**
 * @returns a string representation of `ms` that looks like HH:MM:SS
 */
export function msToRoughTime(ms: number) {
	const seconds = _.floor((ms / 1000) % 60)
	const minutes = _.floor((ms / 1000 / 60) % 60)
	const hours = _.floor((ms / 1000 / 60 / 60) % 24)
	return `${hours ? `${hours}:` : ''}${minutes}:${_.padStart(String(seconds), 2, '0')}`
}
