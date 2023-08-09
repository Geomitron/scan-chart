import Bottleneck from 'bottleneck'
import { createHash } from 'crypto'
import EventEmitter from 'events'
import { Dirent } from 'fs'
import { readdir } from 'fs/promises'
import * as _ from 'lodash'
import { join, parse, relative } from 'path'

import { CachedFile } from './cached-file'
import { scanChart } from './chart'
import { scanImage } from './image'
import { defaultMetadata, scanIni } from './ini'
import { Chart, EventType, ScannedChart } from './interfaces'
import { appearsToBeChartFolder, RequireMatchingProps, Subset } from './utils'

export * from './interfaces'

interface ScanChartsResultEvents {
	'folder': (folderName: string) => void
	'chart': (chart: ScannedChart, index: number, count: number) => void
	'error': (err: Error) => void
	'end': (result: ScannedChart[]) => void
}
export declare interface ScanChartsResult {
	/**
	 * Registers `listener` to be called when a chart folder has been found.
	 * The name of the chart folder is passed to `listener`. No `chart` events are emitted before this.
	 */
	on(event: 'folder', listener: (folderName: string) => void): void
	/**
	 * Registers `listener` to be called when a chart has been scanned.
	 * The `ScannedChart` is passed to `listener`, along with the index of this chart and the total number of charts to be scanned.
	 * No `folder` events are emitted after this.
	 */
	on(event: 'chart', listener: (chart: ScannedChart, index: number, count: number) => void): void

	/**
	 * Registers `listener` to be called if the filesystem failed to read a file. If this is called, the "end" event won't happen.
	 */
	on(event: 'error', listener: (err: Error) => void): void

	/**
	 * Registers `listener` to be called when all charts in `chartsFolder` have been scanned.
	 * The `ScannedChart[]` is passed to `listener`.
	 * If this is called, the "error" event won't happen.
	 */
	on(event: 'end', listener: (charts: ScannedChart[]) => void): void
}

class ChartsScanner {

	public eventEmitter = new EventEmitter()

	constructor(private chartsFolder: string) { }

	/**
	 * Scans the charts in `chartsFolder` and its subfolders.
	 */
	public async scanChartsFolder() {
		const chartFolders = await this.getChartFolders(this.chartsFolder)

		if (chartFolders.length == 0) {
			this.eventEmitter.emit('end', [])
			return
		}

		const limiter = new Bottleneck({ maxConcurrent: 20 }) // Ensures memory use stays bounded
		let chartCounter = 0

		const charts: ScannedChart[] = []
		for (const chartFolder of chartFolders) {
			limiter.schedule(async () => {
				const chartFiles: CachedFile[] = []
				await Promise.all(chartFolder.files.map(async file => {
					chartFiles.push(await CachedFile.build(join(chartFolder.path, file.name)))
				}))
				const result = {
					chart: await this.scanChartFolder(chartFiles),
					chartPath: relative(this.chartsFolder, chartFolder.path),
				}
				if (result.chart) {
					charts.push(result as ScannedChart)
					this.eventEmitter.emit('chart', result, chartCounter, chartFolders.length)
				}
				chartCounter++
			})
		}

		let emittedError = false
		limiter.on('error', err => {
			this.eventEmitter.emit('error', err)
			emittedError = true
			limiter.stop()
		})
		limiter.on('idle', () => {
			if (!emittedError) {
				this.eventEmitter.emit('end', charts)
			}
		})
	}

	/**
	 * @returns valid chart folders in `path` and all its subdirectories.
	 */
	private async getChartFolders(path: string) {
		const chartFolders: { path: string; files: Dirent[] }[] = []

		const files = await readdir(path, { withFileTypes: true })

		if (appearsToBeChartFolder(files.map(file => parse(file.name).ext.substring(1)))) {
			chartFolders.push({ path, files: files.filter(f => !f.isDirectory()) })
			this.eventEmitter.emit('folder', relative(this.chartsFolder, path))
		}

		const subfolders = _.chain(files)
			.filter(f => f.isDirectory() && f.name !== '__MACOSX') // Apple should follow the principle of least astonishment (smh)
			.map(f => this.getChartFolders(join(path, f.name)))
			.value()

		chartFolders.push(..._.flatMap(await Promise.all(subfolders)))

		return chartFolders
	}

	private async scanChartFolder(chartFolder: CachedFile[]) {
		const chart: RequireMatchingProps<Subset<Chart>, 'folderIssues' | 'metadataIssues' | 'playable'> = {
			folderIssues: [],
			metadataIssues: [],
			playable: true,
		}

		chart.md5 = await this.getChartMD5(chartFolder)

		const iniData = scanIni(chartFolder)
		chart.folderIssues.push(...iniData.folderIssues)
		chart.metadataIssues.push(...iniData.metadataIssues)

		const chartData = scanChart(chartFolder)
		chart.folderIssues.push(...chartData.folderIssues)
		chart.metadataIssues.push(...chartData.metadataIssues)
		if (chartData.notesData) {
			chart.notesData = {
				...chartData.notesData,
				maxNps: chartData.notesData.maxNps.map(item => ({
					...item,
					notes: item.notes.map(note => ({
						...note,
						type: EventType[note.type] as keyof typeof EventType, // Replace enum with string equivalent
					})),
				})),
			}
			const instruments = chartData.notesData.instruments
			if (iniData.metadata && (
				(instruments.includes('guitar') && iniData.metadata.diff_guitar === defaultMetadata.diff_guitar) ||
				(instruments.includes('rhythm') && iniData.metadata.diff_rhythm === defaultMetadata.diff_rhythm) ||
				(instruments.includes('bass') && iniData.metadata.diff_bass === defaultMetadata.diff_bass) ||
				(instruments.includes('drums') && iniData.metadata.diff_drums === defaultMetadata.diff_drums) ||
				(instruments.includes('keys') && iniData.metadata.diff_keys === defaultMetadata.diff_keys) ||
				(instruments.includes('guitarghl') && iniData.metadata.diff_guitarghl === defaultMetadata.diff_guitarghl) ||
				(instruments.includes('bassghl') && iniData.metadata.diff_bassghl === defaultMetadata.diff_bassghl)
			)) { chart.metadataIssues.push('missingInstrumentDiff') }
		}

		if (iniData.metadata) {
			// Use metadata from .ini file if it exists (filled in with defaults for properties that are not included)
			_.assign(chart, iniData.metadata)
		} else if (chartData.metadata) {
			// Use metadata from .chart file if it exists
			_.assign(chart, chartData.metadata)
		}
		chart.chart_offset = chartData.metadata?.delay ?? 0

		const imageData = await scanImage(chartFolder)
		chart.folderIssues.push(...imageData.folderIssues)
		if (imageData.albumBuffer) {
			chart.albumArt = {
				md5: createHash('md5').update(imageData.albumBuffer).digest('hex'),
				data: imageData.albumBuffer,
			}
		}

		// TODO: Implement this when determining the best audio fingerprint algorithm
		// const audioData = await scanAudio(chartFolder, cpus().length - 1)
		// chart.folderIssues.push(...audioData.folderIssues)

		if (!chartData.notesData /* TODO: || !audioData.audioHash */) {
			chart.playable = false
		}

		return chart as Chart
	}

	private async getChartMD5(chartFolder: CachedFile[]) {
		const hash = createHash('md5')
		for (const file of _.orderBy(chartFolder, f => f.name)) {
			hash.update(file.name)
			hash.update(await file.getMD5())
		}
		return hash.digest('hex')
	}
}

/**
 * Scans the charts in the `chartsFolder` directory and returns an event emitter that emits the results.
 */
export function scanCharts(chartsFolder: string) {
	const chartsScanner = new ChartsScanner(chartsFolder)
	chartsScanner.scanChartsFolder()

	return {
		on: <T extends keyof ScanChartsResultEvents>(event: T, listener: ScanChartsResultEvents[T]) => {
			chartsScanner.eventEmitter.on(event, listener)
		},
	}
}
