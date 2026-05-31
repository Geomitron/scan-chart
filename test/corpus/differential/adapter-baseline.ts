import { join } from 'node:path'

import { scanChartFolder } from 'scan-chart-baseline'

import { SNAPSHOT_SCAN_CONFIG } from '../shared/constants'
import { loadChartFolderFiles } from '../shared/files'
import { normalizeSnapshot } from '../shared/normalize'
import type { SnapshotRecord } from '../shared/snapshot'

/** Scans one corpus folder through the published baseline package. */
export async function scanBaselineSnapshot(inputRoot: string, relPath: string): Promise<SnapshotRecord> {
	const files = await loadChartFolderFiles(join(inputRoot, relPath))
	const scanned = scanChartFolder(files, SNAPSHOT_SCAN_CONFIG)
	return { relPath, snapshot: normalizeSnapshot(scanned) }
}
