import { fork, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { cpus } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Manifest } from '../shared/manifest'
import { finalizeSortedNdjson, type SnapshotRecord } from '../shared/snapshot'

export type AdapterKind = 'baseline' | 'working-tree'

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

interface InflightSlot {
	resolve: (response: WorkerResponse) => void
	reject: (err: Error) => void
}

const HERE = dirname(fileURLToPath(import.meta.url))

/** Default worker count for CPU-heavy corpus scans. */
export function defaultWorkerCount(): number {
	return Math.max(2, Math.min(cpus().length - 1, 12))
}

/** Writes a sorted snapshot by scanning manifest entries in forked worker processes. */
export async function writeSnapshotWithWorkerPool(
	manifest: Manifest,
	inputRoot: string,
	outputPath: string,
	kind: AdapterKind,
	workerCount: number,
): Promise<void> {
	await mkdir(dirname(outputPath), { recursive: true })
	const partialPath = `${outputPath}.partial`
	const stream = createWriteStream(partialPath)
	const writeLine = (line: string) =>
		new Promise<void>((res, rej) => stream.write(line + '\n', (err: Error | null | undefined) => (err ? rej(err) : res())))

	const workerScript = join(HERE, 'scan-worker.ts')
	const slots = new Map<ChildProcess, InflightSlot>()
	let nextId = 0
	let queueIndex = 0
	let completed = 0
	let errors = 0
	let lastLog = Date.now()
	const start = Date.now()
	const resolvedInput = resolve(inputRoot)

	console.log(`[snapshot] Spawning ${workerCount} ${kind} workers for ${manifest.relPaths.length} charts`)

	const spawnChild = (): ChildProcess => {
		const child = fork(workerScript, [], {
			execArgv: ['--import', 'tsx'],
			stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
		})
		child.on('message', (message: WorkerResponse) => {
			const slot = slots.get(child)
			slots.delete(child)
			slot?.resolve(message)
		})
		child.on('error', err => {
			const slot = slots.get(child)
			slots.delete(child)
			slot?.reject(err)
		})
		child.on('exit', code => {
			const slot = slots.get(child)
			if (!slot) return
			slots.delete(child)
			slot.reject(new Error(`worker exited with code ${code}`))
		})
		return child
	}

	const drainOne = async (): Promise<void> => {
		let child = spawnChild()
		try {
			while (queueIndex < manifest.relPaths.length) {
				const relPath = manifest.relPaths[queueIndex++]
				const request: WorkerRequest = { id: nextId++, kind, inputRoot: resolvedInput, relPath }
				let response: WorkerResponse
				try {
					response = await new Promise<WorkerResponse>((res, rej) => {
						slots.set(child, { resolve: res, reject: rej })
						child.send(request, err => {
							if (!err) return
							slots.delete(child)
							rej(err)
						})
					})
				} catch (err) {
					response = {
						id: request.id,
						record: { relPath, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) },
					}
					child.kill()
					child = spawnChild()
				}
				if (response.record.error) errors++
				await writeLine(JSON.stringify(response.record))
				completed++
				const now = Date.now()
				if (now - lastLog > 2_000 || completed === manifest.relPaths.length) {
					console.log(`[snapshot] ${completed}/${manifest.relPaths.length} scanned (${rate(completed, start, now)}/s, ${errors} errors)`)
					lastLog = now
				}
			}
		} finally {
			child.kill()
		}
	}

	await Promise.all(Array.from({ length: workerCount }, () => drainOne()))
	await new Promise<void>((res, rej) => stream.end((err: Error | null | undefined) => (err ? rej(err) : res())))
	await finalizeSortedNdjson(partialPath, outputPath)
}

function rate(completed: number, start: number, now: number): string {
	return (completed / Math.max(1, (now - start) / 1000)).toFixed(1)
}
