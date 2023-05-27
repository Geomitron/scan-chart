

import { FolderIssueType, MetadataIssueType } from 'dbschema/interfaces'
import { join, parse } from 'path'

import { hasChartExtension, hasChartName } from '../utils'
import { ChartMetadata, ChartParserService } from '../chart-parser/chart-parser'
import { MidiParserService } from '../midi-parser/midi-parser'
import { NotesDataBase } from '../notes-data'
import { ChartFolder } from '../main'

export class ChartScanner {

	private notesData: NotesDataBase | null = null
	private chartMetadata: ChartMetadata | null = null
	private folderIssues: { folderIssue: FolderIssueType; description: string }[] = []

	private chartParser = new ChartParserService()
	private midiParser = new MidiParserService()

	static async construct(chartFolder: ChartFolder) {
		const chartScanner = new ChartScanner()
		await chartScanner.scan(chartFolder)
		const metadataIssues: MetadataIssueType[] = []
		if (chartScanner.chartMetadata?.delay) { metadataIssues.push('nonzeroOffset') }
		return {
			notesData: chartScanner.notesData,
			metadata: chartScanner.chartMetadata,
			folderIssues: chartScanner.folderIssues,
			metadataIssues,
		}
	}

	private constructor() { 
	}

	private addFolderIssue(folderIssue: FolderIssueType, description: string) {
		this.folderIssues.push({ folderIssue, description })
	}
	private logError(description: string, err: Error) {
		throw new Error(description + '\n' + err.message + '\n' + err.stack)
	}

	private async scan(chartFolder: ChartFolder) {
		const chartFilepath = this.getChartFilepath(chartFolder)
		if (!chartFilepath) { return }

		const { notesData, notesMetadata } = await this.getChartAtFilepath(chartFilepath)
		if (!notesData || !notesMetadata) { return }

		this.notesData = notesData
		this.chartMetadata = notesMetadata
	}

	/**
	 * @returns the path to the .chart/.mid file in this chart, or `null` if one wasn't found.
	 */
	private getChartFilepath(chartFolder: ChartFolder) {
		let chartCount = 0
		let bestChartPath: string | null = null
		let lastChartPath: string | null = null

		for (const file of chartFolder.files) {
			if (hasChartExtension(file.name)) {
				chartCount++
				lastChartPath = join(chartFolder.path, file.name)
				if (!hasChartName(file.name)) {
					this.addFolderIssue('invalidChart', `"${file.name}" is not named "notes${parse(file.name).ext.toLowerCase()}"`)
				} else {
					bestChartPath = join(chartFolder.path, file.name)
				}
			}
		}

		if (chartCount > 1) {
			this.addFolderIssue('multipleChart', `This chart has multiple .chart/.mid files`)
		}

		if (bestChartPath !== null) {
			return bestChartPath
		} else if (lastChartPath !== null) {
			return lastChartPath
		} else {
			this.addFolderIssue('noChart', `This chart doesn't have "notes.chart"/"notes.mid"`)
			return null
		}
	}

	/**
	 * @returns an object derived from the .chart/.mid file at `fullPath`.
	 */
	private async getChartAtFilepath(fullPath: string) {
		try {
			if (parse(fullPath).ext.toLowerCase() === '.chart') {
				return await this.chartParser.parse(fullPath)
			} else {
				const notesData = await this.midiParser.parse(fullPath)
				return { notesData, notesMetadata: {} as ChartMetadata }
			}
		} catch (err) {
			this.logError(`Error: Failed to read file at [${fullPath}]`, err)
			return { notesData: null, notesMetadata: null }
		}
	}
}
