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

export interface ChartAsset {
	fileName: string
	data: Uint8Array
}

export interface ChartDocument {
	/** The parsed chart data. `parsedChart.metadata` carries ini fields. */
	parsedChart: ParsedChart
	/** Non-chart / non-ini files from the source folder — passed through verbatim on write. */
	assets: ChartAsset[]
}

/**
 * Serialize a {@link ChartDocument} back to a flat list of files suitable for
 * writing to disk or packaging into a zip/sng.
 *
 * Output:
 *   - `notes.chart` or `notes.mid`, depending on `parsedChart.format`
 *   - `song.ini` (from `parsedChart.metadata`)
 *   - every entry in `doc.assets`, in order
 *
 * Callers should not include their own `notes.chart` / `notes.mid` /
 * `song.ini` entries in `assets` — those would be additive, producing a
 * malformed folder with two chart files.
 */
export function writeChartFolder(doc: ChartDocument): ChartAsset[] {
	const encoder = new TextEncoder()
	const out: ChartAsset[] = []

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
		out.push(asset)
	}

	return out
}
