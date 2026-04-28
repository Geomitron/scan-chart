/**
 * `ChartDocument` bundles a {@link ParsedChart} with the non-chart files
 * (audio, album art, videos, any unrecognized files) from the source folder.
 *
 * This is the counterpart shape to `parseChartAndIni`'s input: in → raw file
 * list, out → `ChartDocument`; writing the reverse: `ChartDocument` → raw
 * file list via `writeChartFolder`.
 *
 * Metadata lives on `parsedChart.metadata` (the consolidated shape from
 * `parseChartAndIni`) — there is no separate `metadata` field on
 * `ChartDocument`, by design.
 */

import { writeChartFile } from './chart-writer'
import { writeMidiFile } from './midi-writer'
import type { ParsedChart } from './parse-chart-and-ini'
import { writeIniFile } from '../ini/ini-writer'
import type { File } from '../interfaces'

export interface ChartDocument {
	/** The parsed chart data. `parsedChart.metadata` carries ini fields. */
	parsedChart: ParsedChart
	/** Non-chart / non-ini files from the source folder — passed through verbatim on write. */
	assets: File[]
}

/**
 * Serialize a {@link ChartDocument} back to a flat list of files suitable for
 * writing to disk or packaging into a zip/sng.
 *
 * Output:
 *   - `notes.chart` or `notes.mid`, depending on `parsedChart.format`
 *   - `song.ini` (from `parsedChart.metadata`)
 *   - every entry in `doc.assets` that isn't already a chart or ini file, in order
 *
 * If `doc.assets` contains its own `notes.chart` / `notes.mid` / `song.ini`
 * entries (e.g. because the caller kept the full file list from
 * `parseChartAndIni` as-is), those entries are dropped — the fresh
 * serialized versions win. Comparisons are case-insensitive to match the
 * parser's file lookup.
 */
const CHART_FILE_NAMES = new Set(['notes.chart', 'notes.mid', 'song.ini'])

function isChartLikeFile(fileName: string): boolean {
	return CHART_FILE_NAMES.has(fileName.toLowerCase())
}

export function writeChartFolder(doc: ChartDocument): File[] {
	const encoder = new TextEncoder()
	const out: File[] = []

	if (doc.parsedChart.format === 'chart') {
		out.push({
			fileName: 'notes.chart',
			data: encoder.encode(writeChartFile(doc.parsedChart)),
		})
	} else {
		out.push({
			fileName: 'notes.mid',
			data: writeMidiFile(doc.parsedChart),
		})
	}

	out.push({
		fileName: 'song.ini',
		data: encoder.encode(writeIniFile(doc.parsedChart.metadata)),
	})

	for (const asset of doc.assets) {
		if (isChartLikeFile(asset.fileName)) continue
		out.push(asset)
	}

	return out
}
