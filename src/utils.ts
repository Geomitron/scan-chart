import detect from 'charset-detector'
import { createHash } from 'crypto'
import * as _ from 'lodash'
import { join, parse } from 'path'
import sanitize from 'sanitize-filename'

import { usernameExceptions } from './constants/username-exceptions'
import { DriveChartBase } from './drive-chart'

/** Overwrites the type of a nested property in `T` with `U`. */
export type Overwrite<T, U> = U extends object ? (
	T extends object ? {
		[K in keyof T]: K extends keyof U ? Overwrite<T[K], U[K]> : T[K];
	} : U
) : U;
export type Subset<K> = {
	[attr in keyof K]?: NonNullable<K[attr]> extends object ? Subset<K[attr]> : K[attr]
}
export type RequireMatchingProps<T, K extends keyof T> = T & { [P in K]-?: NonNullable<T[P]> }
export type OptionalMatchingProps<T, K extends keyof T> = Omit<T, K> & { [P in K]?: T[P] }
export type AsyncReturnType<T extends (...args: any[]) => Promise<any>> =
	T extends (...args: any[]) => Promise<infer R> ? R : never

/**
 * @returns the most likely text encoding for text in `buffer`.
 */
export function getEncoding(buffer: Buffer) {
	const matchingCharset = detect(buffer)[0]
	switch (matchingCharset.charsetName) {
		case 'UTF-8': return 'utf8'
		case 'ISO-8859-1': return 'latin1'
		case 'ISO-8859-2': return 'latin1'
		case 'ISO-8859-9': return 'utf8'
		case 'windows-1252': return 'utf8'
		case 'UTF-16LE': return 'utf16le'
		default: return 'utf8'
	}
}

/**
 * @returns the Drive ID in `link`, or `null` if `link` wasn't a valid Google Drive link.
 */
export function parseDriveLink(link: string) {
	const result = (link.match(/(?:\/|\?id=)[01][a-zA-Z0-9_-]{10,}/ug) ?? [])[0]
	if (result) {
		return result.startsWith('?id=') ? result.substring(4) : result.substring(1)
	} else {
		return null
	}
}

/**
 * @returns `https://drive.google.com/open?id=${fileID}`
 */
export function driveLink(fileID: string) {
	return `https://drive.google.com/open?id=${fileID}`
}

export function getDriveChartDownloadPath(chartsFolder: string, applicationDriveId: string, driveChart: DriveChartBase) {
	const containingDriveFolder = _.last(driveChart.chartBreadcrumbs.split('/'))
	const shortHash = _.take(driveChart.filesHash, 8).join('')
	return join(chartsFolder, sanitizeFilename(applicationDriveId), sanitizeFilename(`${containingDriveFolder} ${shortHash}`))
}

/**
 * @returns `filename` with all invalid filename characters replaced.
 */
export function sanitizeFilename(filename: string): string {
	const newFilename = sanitize(filename, {
		replacement: ((invalidChar: string) => {
			switch (invalidChar) {
				case '<': return '❮'
				case '>': return '❯'
				case ':': return '꞉'
				case '"': return "'"
				case '/': return '／'
				case '\\': return '⧵'
				case '|': return '⏐'
				case '?': return '？'
				case '*': return '⁎'
				default: return '_'
			}
		})
	})
	return (newFilename == '' ? createHash(filename).digest('hex').substr(0, 5) : newFilename)
}

/**
 * @returns true if the list of filename `extensions` appears to be intended as a chart folder.
 */
export function appearsToBeChartFolder(extensions: string[]) {
	const ext = extensions.map(extension => extension.toLowerCase())
	const containsNotes = (ext.includes('chart') || ext.includes('mid'))
	const containsAudio = (ext.includes('ogg') || ext.includes('mp3') || ext.includes('wav') || ext.includes('opus'))
	return (containsNotes || containsAudio)
}

/**
 * @returns `true` if `name` has a valid ini file extension.
 */
export function hasIniExtension(name: string) {
	return ('.ini' == parse(name.toLowerCase()).ext)
}

/**
 * @returns `true` if `name` is a valid ini filename.
 */
export function hasIniName(name: string) {
	return name == 'song.ini'
}

/**
 * @returns `true` if `name` has a valid chart file extension.
 */
export function hasChartExtension(name: string) {
	return (['.chart', '.mid'].includes(parse(name.toLowerCase()).ext))
}

/**
 * @returns `true` if `name` is a valid chart filename.
 */
export function hasChartName(name: string) {
	return ['notes.chart', 'notes.mid'].includes(name)
}

/**
 * @returns `true` if `name` has a valid chart audio file extension.
 */
export function hasAudioExtension(name: string) {
	return (['.ogg', '.mp3', '.wav', '.opus'].includes(parse(name.toLowerCase()).ext))
}

/**
 * @returns `true` if `name` has a valid chart audio filename.
 */
export function hasAudioName(name: string) {
	return (['song', 'guitar', 'bass', 'rhythm', 'keys', 'vocals', 'vocals_1', 'vocals_2',
		'drums', 'drums_1', 'drums_2', 'drums_3', 'drums_4', 'crowd', 'preview'].includes(parse(name).name))
		&& (['.ogg', '.mp3', '.wav', '.opus'].includes(parse(name).ext))
}

/**
 * @returns `true` if `name` has a valid image file extension.
 */
export function hasImageExtension(name: string) {
	return (['.jpg', '.png'].includes(parse(name.toLowerCase()).ext))
}

/**
 * @returns `true` if `name` is a valid album filename.
 */
export function hasAlbumName(name: string) {
	return ['album.jpg', 'album.png'].includes(name)
}

/**
 * @returns `true` if `name` is a valid background filename.
 */
export function hasBackgroundName(name: string) {
	return (parse(name).name).startsWith('background') && (['.jpg', '.png'].includes(parse(name).ext))
}

/**
 * @returns `text` with all style tags removed. (e.g. "<color=#AEFFFF>Aren Eternal</color> & Geo" -> "Aren Eternal & Geo")
 */
export function removeStyleTags(text: string) {
	let oldText = text
	let newText = text
	do {
		oldText = newText
		newText = newText.replace(/<\s*[^>]+>(.*?)<\s*\/\s*[^>]+>/g, '$1')
		newText = newText.replace(/<\s*\/\s*[^>]+>(.*?)<\s*[^>]+>/g, '$1')
	} while (newText != oldText)
	return newText
}

/**
 * @returns `charters` split into an array of individual charter names.
 */
export function splitCharterName(charters: string) {

	let shouldConfirm = false
	if (hasNestedParentheses(charters)) {
		shouldConfirm = true
	}

	let chartersArr = charters.replace(
		getCharterFieldSeparatorRegex(),
		(str, group1) => {
			return group1 ? '^`*~<&*' : str // replace real delimiters with text that will never normally appear
		}).split('^`*~<&*').map(str => str.trim()).filter(str => str.length > 0)

	for (const charter of chartersArr) {
		const trimCharter = trimNameTags(charter)
		if (trimCharter.length === 0 || /[^\w\s\d'\.()]/ug.test(trimCharter) && !usernameExceptions.includes(trimCharter)) {
			shouldConfirm = true
		}
	}

	return { chartersArr, shouldConfirm }
}

/**
 * @returns `false` if `text` does not contain any nested parentheses or brackets, or a description text if it does.
 */
export function hasNestedParentheses(text: string) {
	if (/(?:\([^)]*|\[[^\]]*)[\(\[]/u.test(text)) {
		return 'contains nested parentheses'
	} else {
		return false
	}
}

let charterFieldRegex: RegExp
/**
 * @returns a Regular Expression that will find all the charter name separators in the first capturing group.
 * (note: the returned regex can only be used once; call the function again to use it again)
 */
function getCharterFieldSeparatorRegex() {
	if (!charterFieldRegex) {
		let usernameExceptionRegex: string
		if (usernameExceptions.length == 0) {
			usernameExceptionRegex = '|'
		} else {
			usernameExceptionRegex = '|\\b' + usernameExceptions.map(name => name.replace(/[.*+?^${}()|[\]\\]/ug, '\\$&')).join('|\\b') + '|'
		}

		// Ignore delimiters inside parentheses or brackets, and ignore delimiters if they are in a username exception
		charterFieldRegex = new RegExp(`\\([^)]+\\)|\\[[^\\]]+\\]${usernameExceptionRegex
			}([\\\\\\/&;|,]|\\band\\b| - |\\bft\\.|\\bfeat\\.|\\bft\\b|\\bfeat\\b|\\bvs\\b|\\bx\\b|\\+)`, 'ugi')
	}

	charterFieldRegex.lastIndex = 0
	return charterFieldRegex
}

/**
 * @returns `name` with anything in parentheses/brackets from the end of the string removed (unless that would remove the entire string).
 */
export function trimNameTags(name: string) {
	const tagMatch = name.trim().slice(1).match(/(?:\([^)]+\)\s*|\[[^\]]+\]\s*)*$/ug)
	if (tagMatch != null) {
		return name.slice(0, name.length - tagMatch[0].length).trim()
	} else {
		return name.trim()
	}
}

/**
 * @returns a string representation of `ms` that looks like HH:MM:SS.mm
 */
export function msToTime(ms: number) {
	const seconds = _.round((ms / 1000) % 60, 2)
	const minutes = Math.floor((ms / 1000 / 60) % 60)
	const hours = Math.floor((ms / 1000 / 60 / 60) % 24)
	return `${hours ? `${hours}:` : ''}${_.padStart(minutes + '', 2, '0')}:${_.padStart(seconds.toFixed(2), 5, '0')}`
}

/**
 * @returns `true` if `value` is an array of `T` items.
 */
export function isArray<T>(value: T | readonly T[]): value is readonly T[] {
	return Array.isArray(value)
}
