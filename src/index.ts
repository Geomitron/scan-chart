import { md5 } from 'js-md5'
import * as _ from 'lodash'
import { cpus } from 'os'

import { scanAudio } from './audio'
import { scanChart } from './chart'
import { scanImage } from './image'
import { defaultMetadata, scanIni } from './ini'
import { Instrument, ScannedChart } from './interfaces'
import { RequireMatchingProps, Subset } from './utils'
import { scanVideo } from './video'

export * from './interfaces'
export { parseChartFile } from './chart/notes-parser'
export { calculateTrackHash } from './chart/track-hasher'

/**
 * Scans `files` as a chart folder, and returns a `ScannedChart` object.
 */
export function scanChartFolder(files: { filename: string; data: Uint8Array }[]): ScannedChart {
	const chart: RequireMatchingProps<Subset<ScannedChart>, 'folderIssues' | 'metadataIssues' | 'playable'> = {
		folderIssues: [],
		metadataIssues: [],
		playable: true,
	}

	chart.md5 = getChartMD5(files)

	const iniData = scanIni(files)
	chart.folderIssues.push(...iniData.folderIssues)
	chart.metadataIssues.push(...iniData.metadataIssues)

	const chartData = scanChart(files, iniData.metadata ?? defaultMetadata)
	chart.chartHash = chartData.chartHash ?? undefined
	chart.folderIssues.push(...chartData.folderIssues)

	if (chartData.notesData) {
		chart.notesData = chartData.notesData
		const instruments = chartData.notesData.instruments
		if (iniData.metadata) {
			const checkMissingDifficulty = (instrument: Instrument, diffKey: keyof typeof defaultMetadata) => {
				if (instruments.includes(instrument) && iniData.metadata[diffKey] === defaultMetadata[diffKey]) {
					chart.metadataIssues.push({ metadataIssue: 'missingValue', description: `Metadata is missing a "${diffKey}" value.` })
				}
			}
			checkMissingDifficulty('guitar', 'diff_guitar')
			checkMissingDifficulty('guitarcoop', 'diff_guitar_coop')
			checkMissingDifficulty('rhythm', 'diff_rhythm')
			checkMissingDifficulty('bass', 'diff_bass')
			checkMissingDifficulty('drums', 'diff_drums')
			checkMissingDifficulty('keys', 'diff_keys')
			checkMissingDifficulty('guitarghl', 'diff_guitarghl')
			checkMissingDifficulty('guitarcoopghl', 'diff_guitar_coop_ghl')
			checkMissingDifficulty('rhythmghl', 'diff_rhythm_ghl')
			checkMissingDifficulty('bassghl', 'diff_bassghl')
			if (chartData.notesData.hasVocals && iniData.metadata.diff_vocals === defaultMetadata.diff_vocals) {
				chart.metadataIssues.push({ metadataIssue: 'missingValue', description: 'Metadata is missing a "diff_vocals" value.' })
			}

			const checkExtraDifficulty = (instrument: Instrument, diffKey: keyof typeof defaultMetadata) => {
				if (iniData.metadata[diffKey] !== defaultMetadata[diffKey] && !instruments.includes(instrument)) {
					chart.metadataIssues.push({
						metadataIssue: 'extraValue',
						description: `Metadata contains "${diffKey}", but ${instrument} is not charted.`,
					})
				}
			}
			checkExtraDifficulty('guitar', 'diff_guitar')
			checkExtraDifficulty('guitarcoop', 'diff_guitar_coop')
			checkExtraDifficulty('rhythm', 'diff_rhythm')
			checkExtraDifficulty('bass', 'diff_bass')
			checkExtraDifficulty('drums', 'diff_drums')
			checkExtraDifficulty('keys', 'diff_keys')
			checkExtraDifficulty('guitarghl', 'diff_guitarghl')
			checkExtraDifficulty('guitarcoopghl', 'diff_guitar_coop_ghl')
			checkExtraDifficulty('rhythmghl', 'diff_rhythm_ghl')
			checkExtraDifficulty('bassghl', 'diff_bassghl')
			if (iniData.metadata.diff_vocals !== defaultMetadata.diff_vocals && !chartData.notesData.hasVocals) {
				chart.metadataIssues.push({
					metadataIssue: 'extraValue',
					description: 'Metadata contains "diff_vocals", but vocals are not charted.',
				})
			}
		}
	}

	if (iniData.metadata) {
		// Use metadata from .ini file if it exists (filled in with defaults for properties that are not included)
		_.assign(chart, iniData.metadata)
	} else if (chartData.metadata) {
		// Use metadata from .chart file if it exists
		_.assign(chart, chartData.metadata)
	} else {
		// No metadata available
		chart.playable = false
	}
	chart.chart_offset = chartData.metadata?.delay ?? 0

	const imageData = scanImage(files)
	chart.folderIssues.push(...imageData.folderIssues)
	if (imageData.albumBuffer) {
		chart.albumArt = {
			md5: md5.create().update(imageData.albumBuffer).hex(),
			data: imageData.albumBuffer,
		}
	}

	const audioData = scanAudio(files, cpus().length - 1)
	chart.folderIssues.push(...audioData.folderIssues)

	if (!chartData.notesData || chart.folderIssues.find(i => i!.folderIssue === 'noAudio') /* TODO: || !audioData.audioHash */) {
		chart.playable = false
	}

	const videoData = scanVideo(files)
	chart.folderIssues.push(...videoData.folderIssues)
	chart.hasVideoBackground = videoData.hasVideoBackground

	return chart as ScannedChart
}

function getChartMD5(files: { filename: string; data: Uint8Array }[]) {
	const hash = md5.create()
	for (const file of _.orderBy(files, f => f.filename)) {
		hash.update(file.filename)
		hash.update(file.data)
	}
	return hash.hex()
}
