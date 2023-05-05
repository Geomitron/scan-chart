import { Injectable } from '@nestjs/common'

import { createHash } from 'crypto'
import { Chart, FolderIssueType } from 'dbschema/interfaces'
import { Dirent } from 'fs'
import { readdir, readFile } from 'fs/promises'
import * as _ from 'lodash'
import { join, parse, relative } from 'path'

import { Config } from 'src/config'
import { DiscordService } from 'src/discord/discord/discord.service'
import { DriveChartBase } from 'src/drive/drive-scanner/drive-chart'
import { appearsToBeChartFolder, getDriveChartDownloadPath, OptionalMatchingProps, RequireMatchingProps, Subset } from 'src/utils'
import { EventType } from '../notes-data'
import { ChartScanner } from './chart-scanner'
import { ImageScanner } from './image-scanner'
import { defaultMetadata, IniScanner } from './ini-scanner'

export interface ChartFolder {
	path: string
	files: Dirent[]
}

export interface FolderIssue {
	folderIssue: FolderIssueType
	description: string
}

@Injectable()
export class ChartsScannerService {

	constructor(
		private config: Config,
		private discordService: DiscordService,
	) { }

	/**
	 * @returns The `Chart` DB object(s) found in the download directory for `driveChart`.
	 * Note that the resulting data returned will never need to change as long
	 * as `driveChart.filesHash` stays the same.
	 *
	 * The `Chart` properties not populated are `song`, `driveCharts`, `charters`,
	 * and any `folderIssues`/`metadataIssues` that could possibly be
	 * incorrect/removed later without a `filesHash` change.
	 */
	public async scan(applicationDriveId: string, driveChart: DriveChartBase) {
		const driveChartFolder = getDriveChartDownloadPath(this.config.CHARTS_FOLDER, applicationDriveId, driveChart)
		const chartFolders = await this.getChartFolders(driveChartFolder)

		const charts: { chart: OptionalMatchingProps<Chart, 'driveCharts' | 'charters' | 'song'>, driveChartPath: string }[] = []
		for (const chartFolder of chartFolders) {
			const chart = await this.construct(chartFolder)
			if (chart) {
				charts.push({ chart, driveChartPath: relative(driveChartFolder, chartFolder.path) })
			}
		}
		return charts
	}

	private logError(description: string, err: Error) {
		this.discordService.adminLog(description + '\n' + err.message + '\n' + err.stack)
	}

	/**
	 * @returns valid chart folders in `path` and all its subdirectories.
	 */
	private async getChartFolders(path: string) {
		const chartFolders: ChartFolder[] = []

		const files = await readdir(path, { withFileTypes: true })

		if (appearsToBeChartFolder(files.map(file => parse(file.name).ext.substring(1)))) {
			chartFolders.push({ path, files })
		}

		const promises = _.chain(files)
			.filter(f => f.isDirectory() && f.name !== '__MACOSX') // Apple should follow the principle of least astonishment (smh)
			.map(f => this.getChartFolders(join(path, f.name)))
			.value()

		chartFolders.push(..._.flatMap(await Promise.all(promises)))

		return chartFolders
	}

	private async construct(chartFolder: ChartFolder) {
		const chart: RequireMatchingProps<Subset<Chart>, 'folderIssues' | 'metadataIssues' | 'playable'> = {
			folderIssues: [],
			metadataIssues: [],
			playable: true,
		}

		const hash = createHash('md5')
		for (const file of _.orderBy(chartFolder.files, f => f.name)) {
			hash.update(file.name)
			const fullPath = join(chartFolder.path, file.name)
			try {
				hash.update(await readFile(fullPath))
			} catch (err) {
				this.logError(`Error: Failed to read file at [${fullPath}]`, err)
				return null
			}
		}
		chart.md5 = hash.digest('hex')

		const iniData = await IniScanner.construct(chartFolder)
		chart.folderIssues.push(...iniData.folderIssues)
		chart.metadataIssues.push(...iniData.metadataIssues)

		const chartData = await ChartScanner.construct(chartFolder)
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

		const imageData = await ImageScanner.construct(chartFolder)
		chart.folderIssues.push(...imageData.folderIssues)
		if (imageData.albumBuffer) {
			chart.albumArt = {
				md5: createHash('md5').update(imageData.albumBuffer).digest('hex'),
				data: imageData.albumBuffer,
			}
		}

		// TODO: Implement this when determining the best audio fingerprint algorithm
		// const audioData = await AudioScanner.construct(chartFolder)
		// chart.folderIssues.push(...audioData.folderIssues)

		if (!chartData.notesData /* TODO: || !audioData.audioHash */) {
			chart.playable = false
		}

		return chart as OptionalMatchingProps<Chart, 'driveCharts' | 'charters' | 'song'>
	}
}
