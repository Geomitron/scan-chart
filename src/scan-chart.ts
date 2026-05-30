import { md5 } from 'js-md5'
import * as _ from 'lodash'

import { scanAudio } from './assets/scan-audio'
import { scanImage } from './assets/scan-image'
import { scanVideo } from './assets/scan-video'
import { ParseChartAndIniResult } from './chart/parse-chart-and-ini'
import { scanParsedChart } from './chart/scan-parsed-chart'
import { defaultMetadata } from './ini/metadata'
import { File, Instrument, ScanChartConfig, ScannedChart } from './types'
import { RequireMatchingProps, Subset } from './shared/type-utils'

/**
 * Validate, hash, and asset-scan a parsed chart folder. Pair with `parseChartAndIni()` to get the input.
 */
export function scanChart(
	files: File[],
	parseResult: ParseChartAndIniResult,
	config?: ScanChartConfig,
): ScannedChart {
	const resolvedConfig: Required<ScanChartConfig> = {
		includeMd5: true,
		includeBTrack: false,
		includeAlbumArt: true,
		...config,
	}

	const chart: RequireMatchingProps<Subset<ScannedChart>, 'folderIssues' | 'metadataIssues' | 'playable'> = {
		folderIssues: [],
		metadataIssues: [],
		playable: true,
	}

	chart.md5 = resolvedConfig.includeMd5 ? getChartMD5(files) : 'md5 calculation skipped'

	chart.folderIssues.push(...parseResult.iniFolderIssues)
	chart.metadataIssues.push(...parseResult.iniMetadataIssues)
	chart.folderIssues.push(...parseResult.chartFolderIssues)

	if (parseResult.parsedChart) {
		const chartData = scanParsedChart(parseResult.parsedChart, resolvedConfig.includeBTrack)
		chart.chartHash = chartData.chartHash
		chart.notesData = chartData.notesData
		const instruments = chartData.notesData.instruments
		if (parseResult.hasIni) {
			const metadata = parseResult.parsedChart.metadata
			const checkMissingDifficulty = (instrument: Instrument, diffKey: keyof typeof defaultMetadata) => {
				if (instruments.includes(instrument) && metadata[diffKey] === defaultMetadata[diffKey]) {
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
			if (chartData.notesData.hasVocals && metadata.diff_vocals === defaultMetadata.diff_vocals) {
				chart.metadataIssues.push({ metadataIssue: 'missingValue', description: 'Metadata is missing a "diff_vocals" value.' })
			}

			const checkExtraDifficulty = (instrument: Instrument, diffKey: keyof typeof defaultMetadata) => {
				if (metadata[diffKey] !== defaultMetadata[diffKey] && !instruments.includes(instrument)) {
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
			if (metadata.diff_vocals !== defaultMetadata.diff_vocals && !chartData.notesData.hasVocals) {
				chart.metadataIssues.push({
					metadataIssue: 'extraValue',
					description: 'Metadata contains "diff_vocals", but vocals are not charted.',
				})
			}
		}
	}

	if (parseResult.parsedChart) {
		chart.metadata = {
			..._.omit(parseResult.parsedChart.metadata, 'extraIniFields', 'extraChartSongFields', 'chart_offset'),
			chart_offset: parseResult.parsedChart.metadata.chart_offset ?? 0,
		}
	} else {
		chart.playable = false
		if (parseResult.iniMetadata) {
			chart.metadata = {
				...parseResult.iniMetadata,
				chart_offset: 0,
			}
		} else {
			chart.metadata = {
				chart_offset: 0,
			}
		}
	}

	if (resolvedConfig.includeAlbumArt) {
		const imageData = scanImage(files)
		chart.folderIssues.push(...imageData.folderIssues)
		if (imageData.albumBuffer) {
			chart.albumArt = {
				md5: md5.create().update(imageData.albumBuffer).hex(),
				data: imageData.albumBuffer,
			}
		} else {
			chart.albumArt = null
		}
	} else {
		chart.albumArt = null
	}

	const audioData = scanAudio(files)
	chart.folderIssues.push(...audioData.folderIssues)

	if (!parseResult.parsedChart || chart.folderIssues.find(i => i!.folderIssue === 'noAudio') /* TODO: || !audioData.audioHash */) {
		chart.playable = false
	}

	const videoData = scanVideo(files)
	chart.folderIssues.push(...videoData.folderIssues)
	chart.hasVideoBackground = videoData.hasVideoBackground

	return chart as ScannedChart
}

function getChartMD5(files: File[]) {
	const hash = md5.create()
	for (const file of _.orderBy(files, f => f.fileName)) {
		hash.update(file.fileName)
		hash.update(file.data)
	}
	return hash.hex()
}
