import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import { parseChartAndIni, scanChart } from 'src'
import type { File, ScanChartConfig, ScannedChart } from 'src/types'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import { appearsToBeChartFolder } from './corpus/shared/manifest'
import { getExtension, shouldIgnoreScannerInput, shouldStubFileData } from './corpus/shared/files'

const EMPTY_DATA = new Uint8Array(0)
const SKIPPED_DIRECTORIES = new Set(['__MACOSX', '.git', 'node_modules'])

const config = yargs(hideBin(process.argv))
	.options({
		input: {
			alias: 'i',
			type: 'string',
			describe: 'Chart folder or folder containing charts to scan.',
			demandOption: true,
			normalize: true,
		},
		includeMd5: {
			type: 'boolean',
			default: true,
			describe: 'Calculate the full folder MD5 hash.',
		},
		includeBTrack: {
			type: 'boolean',
			default: false,
			describe: 'Include binary btrack data in track hash entries.',
		},
		includeAlbumArt: {
			type: 'boolean',
			default: true,
			describe: 'Parse album art metadata and include album art hash/data.',
		},
		stubMedia: {
			type: 'boolean',
			default: false,
			describe: 'Load media files as empty buffers for faster corpus scans.',
		},
		pretty: {
			type: 'boolean',
			default: true,
			describe: 'Pretty-print JSON output.',
		},
	})
	.example('npm run scan -- --input "C:\\Charts\\Song"', 'Scan one chart folder')
	.example('npm run scan -- --input "C:\\Charts" --no-includeMd5 --no-includeAlbumArt', 'Scan a chart corpus faster')
	.help()
	.parseSync()

void main()

/** Runs scan-chart against the requested input and prints JSON to stdout. */
async function main(): Promise<void> {
	const inputRoot = resolve(config.input)
	const chartFolders = await discoverChartFolders(inputRoot)
	const scanConfig: ScanChartConfig = {
		includeMd5: config.includeMd5,
		includeBTrack: config.includeBTrack,
		includeAlbumArt: config.includeAlbumArt,
	}

	if (chartFolders.length === 0) {
		console.error(`No chart folders found under ${inputRoot}.`)
		process.exitCode = 1
		return
	}

	const output = chartFolders.length === 1
		? await scanFolder(chartFolders[0], scanConfig, config.stubMedia)
		: await Promise.all(
				chartFolders.map(async folder => ({
					path: relative(inputRoot, folder) || '.',
					result: await scanFolder(folder, scanConfig, config.stubMedia),
				})),
			)

	console.log(JSON.stringify(output, binaryPlaceholderReplacer, config.pretty ? 2 : undefined))
}

/** Scans one chart folder using the same parse-then-scan flow as library consumers. */
async function scanFolder(folder: string, scanConfig: ScanChartConfig, stubMedia: boolean): Promise<ScannedChart> {
	const files = await loadScanFiles(folder, stubMedia)
	return scanChart(files, parseChartAndIni(files), scanConfig)
}

/** Recursively finds chart folders, treating the input itself as a chart when possible. */
async function discoverChartFolders(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true })
	const fileExtensions = entries.filter(entry => entry.isFile()).map(entry => getExtension(entry.name))
	if (appearsToBeChartFolder(fileExtensions)) return [root]

	const chartFolders: string[] = []
	for (const entry of entries) {
		if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue
		chartFolders.push(...await discoverChartFolders(join(root, entry.name)))
	}
	return chartFolders.sort()
}

/** Loads chart files into scan-chart's in-memory file shape. */
async function loadScanFiles(folder: string, stubMedia: boolean): Promise<File[]> {
	const entries = await readdir(folder, { withFileTypes: true })
	const files: File[] = []
	for (const entry of entries) {
		if (!entry.isFile() || shouldIgnoreScannerInput(entry.name)) continue
		if (stubMedia && shouldStubFileData(entry.name)) {
			files.push({ fileName: entry.name, data: EMPTY_DATA })
			continue
		}
		const buffer = await readFile(join(folder, entry.name))
		files.push({ fileName: entry.name, data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) })
	}
	return files.sort((a, b) => a.fileName.localeCompare(b.fileName))
}

/** Replaces binary fields with readable placeholders so console output stays useful. */
function binaryPlaceholderReplacer(_key: string, value: unknown): unknown {
	if (value && typeof value === 'object' && ArrayBuffer.isView(value)) {
		return `<binary length=${value.byteLength}>`
	}
	return value
}
