import { parse } from 'path'

import { ChartFile, FolderIssueType, MetadataIssueType, NotesData } from '../interfaces'
import { hasChartExtension, hasChartName } from '../utils'
import { ChartMetadata, parseChart } from './chart-parser'
import { parseMidi } from './midi-parser'

class ChartScanner {

	public notesData: NotesData | null = null
	public chartMetadata: ChartMetadata | null = null
	public folderIssues: { folderIssue: FolderIssueType; description: string }[] = []

	private addFolderIssue(folderIssue: FolderIssueType, description: string) {
		this.folderIssues.push({ folderIssue, description })
	}

	public scan(chartFolder: ChartFile[]) {
		const chartFile = this.getChartFile(chartFolder)
		if (!chartFile) { return }

		const { notesData, notesMetadata } = this.getChartData(chartFile)
		if (!notesData || !notesMetadata) { return }

		this.notesData = notesData
		this.chartMetadata = notesMetadata
	}

	/**
	 * @returns the .chart/.mid file in this chart, or `null` if one wasn't found.
	 */
	private getChartFile(chartFolder: ChartFile[]) {
		let chartCount = 0
		let bestChart: ChartFile | null = null
		let lastChart: ChartFile | null = null

		for (const file of chartFolder) {
			if (hasChartExtension(file.name)) {
				chartCount++
				lastChart = file
				if (!hasChartName(file.name)) {
					this.addFolderIssue('invalidChart', `"${file.name}" is not named "notes${parse(file.name).ext.toLowerCase()}"`)
				} else {
					bestChart = file
				}
			}
		}

		if (chartCount > 1) {
			this.addFolderIssue('multipleChart', `This chart has multiple .chart/.mid files`)
		}

		if (bestChart !== null) {
			return bestChart
		} else if (lastChart !== null) {
			return lastChart
		} else {
			this.addFolderIssue('noChart', `This chart doesn't have "notes.chart"/"notes.mid"`)
			return null
		}
	}

	/**
	 * @returns an object derived from the .chart/.mid `file`.
	 */
	private getChartData(file: ChartFile) {
		try {
			if (parse(file.name).ext.toLowerCase() === '.chart') {
				return parseChart(file.data)
			} else {
				const notesData = parseMidi(file.data)
				return { notesData, notesMetadata: {} as ChartMetadata }
			}
		} catch (err) {
			this.addFolderIssue('badChart', `This chart's .chart/.mid file couldn't be parsed`)
			return { notesData: null, notesMetadata: null }
		}
	}
}

export function scanChart(chartFolder: ChartFile[]) {
	const chartScanner = new ChartScanner()
	chartScanner.scan(chartFolder)
	const metadataIssues: MetadataIssueType[] = []
	if (chartScanner.chartMetadata?.delay) { metadataIssues.push('nonzeroOffset') }
	return {
		notesData: chartScanner.notesData,
		metadata: chartScanner.chartMetadata,
		folderIssues: chartScanner.folderIssues,
		metadataIssues,
	}
}
