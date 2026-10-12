import * as _ from 'lodash'

import { toLowerInvariant, trimDotnet } from '../shared/text'
import { decodeCloneHeroText } from '../shared/decode-text'

export const $NoSection: unique symbol = Symbol('Lines before any sections')
export interface IniObject {
	[$NoSection]?: { [key: string]: string }
	[section: string]: { [key: string]: string }
}

/** A song.ini file as read, kept whole so an unedited file is written back byte for byte. */
export interface IniTokens {
	readonly bytes: Uint8Array
	/** The decoded text, or `null` when the file can't be decoded; `decodeError` then says why. */
	readonly text: string | null
	readonly decodeError: Error | null
}

/** Tokenizes a song.ini file. Never throws: a file that can't be decoded keeps its error for parsing to report. */
export function tokenizeIni(bytes: Uint8Array): IniTokens {
	try {
		return { bytes, text: decodeCloneHeroText(bytes), decodeError: null }
	} catch (error) {
		return { bytes, text: null, decodeError: error instanceof Error ? error : new Error(String(error)) }
	}
}

/**
 * @returns the `IniObject` parsed from `file`.
 */
export function parseIni(file: Uint8Array): { iniObject: IniObject; folderIssues: { folderIssue: 'badIniLine'; description: string }[] } {
	return parseIniTokens(tokenizeIni(file))
}

/**
 * @returns the `IniObject` parsed from a tokenized song.ini.
 *
 * Throws the decoding error if the file couldn't be decoded.
 */
export function parseIniTokens(tokens: IniTokens): { iniObject: IniObject; folderIssues: { folderIssue: 'badIniLine'; description: string }[] } {
	if (tokens.text === null) throw tokens.decodeError
	const iniLines = tokens.text
		.replace(/^\uFEFF/, '') // CH IniFile.Load removes one leading byte order mark
		.split(/\r?\n/g)
		.map(trimDotnet)

	const iniObject: IniObject = Object.create(null)
	const folderIssues: { folderIssue: 'badIniLine'; description: string }[] = []
	let currentSection: string | typeof $NoSection = $NoSection

	for (const line of iniLines) {
		if (line.length === 0 || line.startsWith(';') || line.startsWith('#')) {
			continue
		}

		// Like CH IniFile.Load: "[]" starts a section named "", and "[name=value" is a key.
		if (line.startsWith('[') && line.endsWith(']')) {
			currentSection = toLowerInvariant(line.slice(1, -1))
		} else if (line.includes('=')) {
			const delimeterPos = line.indexOf('=')
			const key = toLowerInvariant(trimDotnet(line.slice(0, delimeterPos)))
			const value = trimDotnet(line.slice(delimeterPos + 1))

			;(iniObject[currentSection] ??= Object.create(null))[key] = value
		} else {
			folderIssues.push({ folderIssue: 'badIniLine', description: `Unsupported type of line: "${_.truncate(line, { length: 200 })}"` })
		}
	}

	return { iniObject, folderIssues: folderIssues.slice(-5) }
}
