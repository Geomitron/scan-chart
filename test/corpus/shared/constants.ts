import { dirname, resolve } from 'node:path'

export const DOCS_URL = 'https://thenathannator.github.io/GuitarGame_ChartFormats/'

export const BASELINE_LABEL = 'v8.0.1'

export const REPO_ROOT = resolve(dirname(process.argv[1]), '..', '..', '..')

export const DEFAULT_SNAPSHOTS_DIR = resolve(REPO_ROOT, 'test', 'corpus', 'snapshots')

export const SNAPSHOT_SCAN_CONFIG = {
	includeMd5: false,
	includeBTrack: false,
} as const

export const BTRACK_SCAN_CONFIG = {
	includeMd5: false,
	includeBTrack: true,
} as const
