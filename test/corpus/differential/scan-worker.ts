import { scanBaselineSnapshot } from './adapter-baseline'
import { scanWorkingTreeSnapshot } from './adapter-working-tree'
import type { SnapshotRecord } from '../shared/snapshot'
import { errorToString } from '../shared/snapshot'

type AdapterKind = 'baseline' | 'working-tree'

interface WorkerRequest {
	id: number
	kind: AdapterKind
	inputRoot: string
	relPath: string
}

interface WorkerResponse {
	id: number
	record: SnapshotRecord
}

if (typeof process.send !== 'function') {
	throw new Error('scan-worker.ts must be loaded via child_process.fork()')
}

process.on('message', async (request: WorkerRequest) => {
	const response: WorkerResponse = {
		id: request.id,
		record: await scanOne(request),
	}
	process.send!(response)
})

async function scanOne(request: WorkerRequest): Promise<SnapshotRecord> {
	try {
		return request.kind === 'baseline' ?
			await scanBaselineSnapshot(request.inputRoot, request.relPath) :
			await scanWorkingTreeSnapshot(request.inputRoot, request.relPath)
	} catch (err) {
		return { relPath: request.relPath, error: errorToString(err) }
	}
}
