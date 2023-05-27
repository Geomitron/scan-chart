import { readFile } from 'fs/promises'

import { getEncoding } from '../utils'

export const $NoSection: unique symbol = Symbol('Lines before any sections')
export interface IniObject {
	[$NoSection]?: { [key: string]: string }
	[section: string]: { [key: string]: string }
}

export class IniParserService {

	/**
	 * @throws an exception if the file failed to be read.
	 * @returns the `IIniObject` object corresponding with the ".ini" file at `filepath`.
	 */
	async parse(filepath: string) {
		const buffer = await readFile(filepath)
		const encoding = getEncoding(buffer)
		const iniText = buffer.toString(encoding)
		return this.decode(iniText)
	}

	private decode(data: string) {
		const iniObject: IniObject = {}
		const iniErrors: string[] = []

		let currentSection = ''

		const lines = data.split(/\r?\n/g).map(line => line.trim())
		for (const line of lines) {
			if ((line.length === 0) || (line.startsWith(';'))) { continue }

			if (line[0].startsWith('[')) {
				const match = /\[(.+)]$/.exec(line)
				if (match === null) {
					iniErrors.push(this.createParseError(line))
				} else {
					currentSection = match[1].trim()
				}
			} else if (line.includes('=')) {
				const delimeterPos = line.indexOf('=')
				const key = line.slice(0, delimeterPos).trim()
				let value = line.slice(delimeterPos + 1).trim()

				if (currentSection === '') {
					(iniObject[$NoSection] ??= {})[key] = value
				} else {
					(iniObject[currentSection] ??= {})[key] = value
				}
			} else {
				iniErrors.push(this.createParseError(line))
			}
		}

		return { iniObject, iniErrors }
	}

	private createParseError(line: string) {
		return `Unsupported type of line: "${line}"`
	}
}
