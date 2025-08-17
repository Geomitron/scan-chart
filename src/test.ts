import { Dirent } from 'fs'
import { readdir, readFile, writeFile } from 'fs/promises'
import * as _ from 'lodash'
import { join } from 'path'
import sanitize from 'sanitize-filename'
import { scanChartFolder } from 'src'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import { Difficulty, Instrument } from './interfaces'
import { appearsToBeChartFolder, getExtension } from './utils'

const argv = yargs(hideBin(process.argv))
	.options({
		inputFolder: {
			alias: 'i',
			type: 'string',
			describe: 'Folder containing charts to scan.',
			demandOption: true,
			normalize: true,
		},
		outputFolder: {
			alias: 'o',
			type: 'string',
			describe: 'Folder to place hashes.json and bchart files.',
			demandOption: true,
			normalize: true,
		},
		createBChartFiles: {
			alias: 'b',
			type: 'boolean',
			default: false,
			describe: 'If bchart files should be generated for each scanned chart.',
		},
		formatHashesJson: {
			alias: 'f',
			type: 'boolean',
			default: false,
			describe: 'Pretty-print json output.',
		},
		silent: {
			alias: 's',
			type: 'boolean',
			default: false,
			describe: 'Suppress all logs.',
		},
	})
	.help()
	.parse()

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
	const config = await argv

	const inputHashes: InputHashes = {}
	for (const folder of await getChartFolders(config.inputFolder)) {
		const files = (
			await Promise.all(
				folder.files.map(async file => {
					if (!file.name.endsWith('mp4') && !file.name.endsWith('webm')) {
						const buffer = await readFile(join(folder.path, file.name))
						return {
							fileName: file.name,
							data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
						}
					}
				}),
			)
		).filter(f => f?.data !== undefined) as { fileName: string; data: Uint8Array<ArrayBufferLike> }[]

		const result = scanChartFolder(files, { includeBChart: config.createBChartFiles, includeMd5: false })
		scanCount++
		if (scanCount % 100 === 0 && !config.silent) {
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
			if (config.createBChartFiles) {
				for (const trackHash of result.notesData.trackHashes) {
					await writeFile(
						join(config.outputFolder, `${sanitizeNonemptyFilename(song)} [${trackHash.instrument}] [${trackHash.difficulty}]`),
						trackHash.bchart!,
					)
				}
			}
		}
	}

	await writeFile(join(config.outputFolder, 'hashes.json'), JSON.stringify(inputHashes, undefined, config.formatHashesJson ? 2 : undefined))
	if (!config.silent) {
		console.log(`DONE: ${scanCount} matches`)
	}
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
		appearsToBeChartFolder(files.map(file => getExtension(file.name))) &&
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
