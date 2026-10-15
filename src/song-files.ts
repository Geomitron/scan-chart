import { ObjectCache } from './shared/object-cache'

/** A file read on demand, such as a browser `File` or Node's `fs.openAsBlob`, so large files never have to be loaded. */
export interface ByteSource {
	readonly size: number
	read(offset: number, length: number): Promise<Uint8Array>
}

/** One file of a song folder, as the caller has it: its bytes, or a byte source. scan-chart never reads the disk. */
export interface SongFile {
	readonly fileName: string
	readonly data: Uint8Array | ByteSource
}

/** A byte source over a `Blob`, which includes a browser `File` and the result of Node's `fs.openAsBlob`. */
export function byteSourceFromBlob(blob: Blob): ByteSource {
	const source: ByteSource = {
		size: blob.size,
		read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
	}
	sourceBlobs.set(source, blob)
	return source
}

/** The `Blob` each `byteSourceFromBlob` source reads, so saving can copy it without reading it. */
const sourceBlobs = new ObjectCache<ByteSource, Blob>('blob')

/** The `Blob` a byte source reads, or `undefined` for a source `byteSourceFromBlob` didn't make. */
export function byteSourceBlob(source: ByteSource): Blob | undefined {
	return sourceBlobs.get(source)
}

export function isByteSource(data: Uint8Array | ByteSource): data is ByteSource {
	return !(data instanceof Uint8Array)
}

/** The bytes of a file scan-chart has already read. Parsing reads every chart and .ini file before it starts. */
export function fileBytes(file: SongFile): Uint8Array {
	if (isByteSource(file.data)) throw new Error(`"${file.fileName}" hasn't been read`)
	return file.data
}

export const CHUNK_SIZE = 16 * 1024 * 1024

/** A file's bytes, read in chunks from a byte source. */
export async function readFileBytes(file: SongFile): Promise<Uint8Array> {
	const { data } = file
	if (!isByteSource(data)) return data
	const bytes = new Uint8Array(data.size)
	for (let offset = 0; offset < data.size; offset += CHUNK_SIZE) {
		bytes.set(await data.read(offset, Math.min(CHUNK_SIZE, data.size - offset)), offset)
	}
	return bytes
}

/** A file's size in bytes, without reading it. */
export function fileSize(file: SongFile): number {
	return isByteSource(file.data) ? file.data.size : file.data.byteLength
}

/** The bytes of a file from `offset`, up to `length` and the file's end, read from a byte source or sliced from bytes. */
export async function readRange(file: SongFile, offset: number, length: number): Promise<Uint8Array> {
	const size = fileSize(file)
	const start = Math.max(0, Math.min(offset, size))
	const end = Math.max(start, Math.min(offset + length, size))
	return isByteSource(file.data) ? file.data.read(start, end - start) : file.data.subarray(start, end)
}

/** Calls `consume` with each chunk of a file in order, reading a byte source in chunks so it's never held whole. */
export async function forEachChunk(file: SongFile, consume: (chunk: Uint8Array) => void): Promise<void> {
	const { data } = file
	if (!isByteSource(data)) {
		consume(data)
		return
	}
	for (let offset = 0; offset < data.size; offset += CHUNK_SIZE) {
		consume(await data.read(offset, Math.min(CHUNK_SIZE, data.size - offset)))
	}
}
