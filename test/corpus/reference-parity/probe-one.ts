import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parseChartAndIni } from 'src'
import { calculateTrackHash } from 'src/chart/track-hasher'

import { loadChartFolderFiles } from '../shared/files'

const folder = process.argv[2]
if (!folder) {
	console.error('Usage: probe-one.ts <chart folder>')
	process.exit(1)
}

void main()

/** Scans one chart folder and compares its computed btracks with HashScanTool side files. */
async function main(): Promise<void> {
	const files = await loadChartFolderFiles(folder)
	const parseResult = parseChartAndIni(files)
	if (!parseResult.parsedChart) {
		console.error('Failed to parse chart:', parseResult.chartFolderIssues)
		process.exit(2)
	}

	for (const track of parseResult.parsedChart.trackData) {
		const output = calculateTrackHash(parseResult.parsedChart, track.instrument, track.difficulty)
		const chPath = join(folder, `${track.instrument}_${track.difficulty}.bchart`)
		if (!existsSync(chPath)) {
			console.log(`[no-ch] ${track.instrument} ${track.difficulty}: scan-chart=${output.btrack.byteLength} bytes, hash=${output.hash}`)
			continue
		}
		const ch = new Uint8Array(await readFile(chPath))
		if (Buffer.compare(Buffer.from(output.btrack), Buffer.from(ch)) === 0) {
			console.log(`SAME ${track.instrument} ${track.difficulty} (${output.btrack.byteLength} bytes, hash=${output.hash})`)
		} else {
			console.log(`DIFF ${track.instrument} ${track.difficulty} scan-chart=${output.btrack.byteLength} ch=${ch.byteLength} hash=${output.hash}`)
		}
	}
}
