import { join } from 'node:path'

import { parseChartAndIni, scanChart } from 'src'

import { SNAPSHOT_SCAN_CONFIG } from '../shared/constants'
import { loadChartFolderFiles } from '../shared/files'
import { normalizeSnapshot } from '../shared/normalize'
import type { SnapshotRecord } from '../shared/snapshot'

/** Scans one corpus folder through the working-tree source API. */
export async function scanWorkingTreeSnapshot(inputRoot: string, relPath: string): Promise<SnapshotRecord> {
	const files = await loadChartFolderFiles(join(inputRoot, relPath))
	const scanned = scanChart(files, parseChartAndIni(files), SNAPSHOT_SCAN_CONFIG)
	return { relPath, snapshot: normalizeSnapshot(scanned) }
}
