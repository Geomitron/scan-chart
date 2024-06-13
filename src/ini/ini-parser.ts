import * as _ from 'lodash'

import { getEncoding } from '../utils'

export const $NoSection: unique symbol = Symbol('Lines before any sections')
export interface IniObject {
	[$NoSection]?: { [key: string]: string }
	[section: string]: { [key: string]: string }
}

/**
 * @returns the `IniObject` parsed from `file`.
 */
export function parseIni(file: Uint8Array): { iniObject: IniObject; folderIssues: { folderIssue: 'badIniLine'; description: string }[] } {
	const encoding = getEncoding(file)
	const decoder = new TextDecoder(encoding)
	const iniLines = decoder
		.decode(file)
		.split(/\r?\n/g)
		.map(line => line.trim())

	const iniObject: IniObject = {}
	const folderIssues: { folderIssue: 'badIniLine'; description: string }[] = []
	let currentSection: string | typeof $NoSection = $NoSection

	for (const line of iniLines) {
		if (line.length === 0 || line.startsWith(';')) {
			continue
		}

		if (line[0].startsWith('[')) {
			const match = /\[(.+)]$/.exec(line)
			if (match === null) {
				folderIssues.push({ folderIssue: 'badIniLine', description: `Unsupported type of line: "${_.truncate(line, { length: 200 })}"` })
			} else {
				currentSection = match[1].trim()
			}
		} else if (line.includes('=')) {
			const delimeterPos = line.indexOf('=')
			const key = line.slice(0, delimeterPos).trim()
			const value = line.slice(delimeterPos + 1).trim()

			;(iniObject[currentSection] ??= {})[key] = value
		} else {
			folderIssues.push({ folderIssue: 'badIniLine', description: `Unsupported type of line: "${_.truncate(line, { length: 200 })}"` })
		}
	}

	return { iniObject, folderIssues: folderIssues.slice(-5) }
}
