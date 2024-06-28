import { Dirent } from 'fs'
import { readdir, readFile, writeFile } from 'fs/promises'
import * as _ from 'lodash'
import { join } from 'path'
import sanitize from 'sanitize-filename'
import { scanChartFolder } from 'src'

import { Difficulty, Instrument } from './interfaces'
import { appearsToBeChartFolder, getExtension } from './utils'

// TODO: edit these before running
const SCAN_PATH = 'C:\\Users\\Geo\\Desktop\\CLONE_HERO\\Charts'
const HASHES_JSON_SAVE_PATH = 'C:\\Users\\Geo\\Desktop\\bcharts\\hashes.json'
const BCHART_SAVE_PATH = 'C:\\Users\\Geo\\Desktop\\bcharts'
const GENERATE_BCHART_FILES = true

interface InputHashes {
	[chartHash: string]: {
		song: string
		trackHashes: {
			instrument: Instrument
			difficulty: Difficulty
			trackHash: string
		}[]
	}
}

main()
let scanCount = 0
async function main() {
	const inputHashes: InputHashes = {}
	for (const folder of await getChartFolders(SCAN_PATH)) {
		const files = (
			await Promise.all(
				folder.files.map(async file => {
					if (!file.name.endsWith('mp4') && !file.name.endsWith('webm')) {
						return {
							fileName: file.name,
							data: await readFile(join(folder.path, file.name)),
						}
					}
				}),
			)
		).filter(f => f?.data !== undefined) as { fileName: string; data: Buffer }[]

		const result = scanChartFolder(files)
		scanCount++
		if (scanCount % 100 === 0) {
			console.log(`${scanCount} scanned...`)
		}
		if (result.notesData) {
			const song = `${result.artist} - ${result.name} (${result.charter})`
			inputHashes[result.chartHash] = {
				song,
				trackHashes: result.notesData.trackHashes.map(t => ({
					instrument: t.instrument,
					difficulty: t.difficulty,
					trackHash: t.hash,
				})),
			}
			if (GENERATE_BCHART_FILES) {
				for (const trackHash of result.notesData.trackHashes) {
					await writeFile(
						`${BCHART_SAVE_PATH}\\${sanitizeNonemptyFilename(song)} [${trackHash.instrument}] [${trackHash.difficulty}]`,
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						(trackHash as any).bchart,
					)
				}
			}
		}
	}

	await writeFile(HASHES_JSON_SAVE_PATH, JSON.stringify(inputHashes))
	console.log(`DONE: ${scanCount} matches`)
}

/**
 * @returns valid chart folders in `path` and all its subdirectories.
 */
async function getChartFolders(path: string) {
	const chartFolders: { path: string; files: Dirent[] }[] = []

	const files = await readdir(path, { withFileTypes: true })

	const subfolders = _.chain(files)
		.filter(f => f.isDirectory() && f.name !== '__MACOSX') // Apple should follow the principle of least astonishment (smh)
		.map(f => getChartFolders(join(path, f.name)))
		.value()

	chartFolders.push(..._.flatMap(await Promise.all(subfolders)))

	if (
		appearsToBeChartFolder(files.map(file => getExtension(file.name).substring(1))) &&
		subfolders.length === 0 // Charts won't contain other charts
	) {
		chartFolders.push({ path, files: files.filter(f => !f.isDirectory()) })
	}

	return chartFolders
}

/**
 * @returns `filename` with all invalid filename characters replaced. Assumes `filename` has at least one valid filename character already.
 */
export function sanitizeNonemptyFilename(filename: string) {
	return sanitize(filename, {
		replacement: (invalidChar: string) => {
			switch (invalidChar) {
				case '<':
					return '❮'
				case '>':
					return '❯'
				case ':':
					return '꞉'
				case '"':
					return "'"
				case '/':
					return '／'
				case '\\':
					return '⧵'
				case '|':
					return '⏐'
				case '?':
					return '？'
				case '*':
					return '⁎'
				default:
					return '_'
			}
		},
	})
}
