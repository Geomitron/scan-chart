import { readFile } from 'node:fs/promises'

export interface DecodedBTrack {
	magic: number
	version: number
	resolution: number
	tempos: { tick: number; bpm: number }[]
	timeSigs: { tick: number; numerator: number; denominator: number }[]
	starPower: { tick: number; length: number }[]
	solo: { tick: number; length: number }[]
	flexLanes: { tick: number; length: number; isDouble: boolean }[]
	drumFreestyle: { tick: number; length: number; isCoda: boolean }[]
	notes: { tick: number; length: number; type: number; flags: number }[]
}

export interface BTrackElementDiff {
	section: keyof Omit<DecodedBTrack, 'magic' | 'version' | 'resolution'>
	index: number
	tick?: number
	baseline?: unknown
	working?: unknown
}

const SECTION_KEYS = ['tempos', 'timeSigs', 'starPower', 'solo', 'flexLanes', 'drumFreestyle', 'notes'] as const

/** Decodes scan-chart's btrack binary format into structural sections. */
export function decodeBTrack(buf: Uint8Array): DecodedBTrack {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
	let offset = 0
	const magic = view.getUint32(offset, false); offset += 4
	const version = view.getUint32(offset, true); offset += 4
	const resolution = view.getUint32(offset, true); offset += 4

	const tempos: DecodedBTrack['tempos'] = []
	const tempoCount = view.getUint32(offset, true); offset += 4
	for (let i = 0; i < tempoCount; i++) {
		tempos.push({ tick: Number(view.getBigInt64(offset, true)), bpm: view.getFloat64(offset + 8, true) })
		offset += 16
	}

	const timeSigs: DecodedBTrack['timeSigs'] = []
	const timeSigCount = view.getUint32(offset, true); offset += 4
	for (let i = 0; i < timeSigCount; i++) {
		timeSigs.push({
			tick: Number(view.getBigInt64(offset, true)),
			numerator: view.getUint32(offset + 8, true),
			denominator: view.getUint32(offset + 12, true),
		})
		offset += 16
	}

	const starPower = readPhrases(view, () => offset, next => { offset = next })
	const solo = readPhrases(view, () => offset, next => { offset = next })

	const flexLanes: DecodedBTrack['flexLanes'] = []
	const flexLaneCount = view.getUint32(offset, true); offset += 4
	for (let i = 0; i < flexLaneCount; i++) {
		flexLanes.push({
			tick: Number(view.getBigInt64(offset, true)),
			length: Number(view.getBigInt64(offset + 8, true)),
			isDouble: view.getUint8(offset + 16) !== 0,
		})
		offset += 17
	}

	const drumFreestyle: DecodedBTrack['drumFreestyle'] = []
	const freestyleCount = view.getInt32(offset, true); offset += 4
	for (let i = 0; i < freestyleCount; i++) {
		drumFreestyle.push({
			tick: Number(view.getBigInt64(offset, true)),
			length: Number(view.getBigInt64(offset + 8, true)),
			isCoda: view.getUint8(offset + 16) !== 0,
		})
		offset += 17
	}

	const notes: DecodedBTrack['notes'] = []
	const noteCount = view.getInt32(offset, true); offset += 4
	for (let i = 0; i < noteCount; i++) {
		notes.push({
			tick: Number(view.getBigInt64(offset, true)),
			length: Number(view.getBigInt64(offset + 8, true)),
			type: view.getUint32(offset + 16, true),
			flags: view.getUint32(offset + 20, true),
		})
		offset += 24
	}

	return { magic, version, resolution, tempos, timeSigs, starPower, solo, flexLanes, drumFreestyle, notes }
}

/** Produces structural btrack differences, including the first differing tick where available. */
export function diffBTracks(baseline: Uint8Array, working: Uint8Array, limit = 50): BTrackElementDiff[] {
	const left = decodeBTrack(baseline)
	const right = decodeBTrack(working)
	const diffs: BTrackElementDiff[] = []

	if (left.magic !== right.magic) diffs.push({ section: 'tempos', index: -1, baseline: left.magic, working: right.magic })
	if (left.version !== right.version) diffs.push({ section: 'tempos', index: -1, baseline: left.version, working: right.version })
	if (left.resolution !== right.resolution) diffs.push({ section: 'tempos', index: -1, baseline: left.resolution, working: right.resolution })

	for (const section of SECTION_KEYS) {
		const a = left[section]
		const b = right[section]
		const max = Math.min(Math.max(a.length, b.length), limit)
		for (let i = 0; i < max; i++) {
			if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
				diffs.push({
					section,
					index: i,
					tick: getTick(a[i]) ?? getTick(b[i]),
					baseline: a[i],
					working: b[i],
				})
			}
		}
	}
	return diffs
}

/** Reads and structurally diffs two btrack files from disk. */
export async function diffBTrackFiles(pathA: string, pathB: string, limit = 50): Promise<BTrackElementDiff[]> {
	return diffBTracks(new Uint8Array(await readFile(pathA)), new Uint8Array(await readFile(pathB)), limit)
}

function readPhrases(
	view: DataView,
	getOffset: () => number,
	setOffset: (offset: number) => void,
): { tick: number; length: number }[] {
	let offset = getOffset()
	const out: { tick: number; length: number }[] = []
	const count = view.getUint32(offset, true); offset += 4
	for (let i = 0; i < count; i++) {
		out.push({ tick: Number(view.getBigInt64(offset, true)), length: Number(view.getBigInt64(offset + 8, true)) })
		offset += 16
	}
	setOffset(offset)
	return out
}

function getTick(value: unknown): number | undefined {
	return value && typeof value === 'object' && 'tick' in value && typeof value.tick === 'number' ? value.tick : undefined
}
