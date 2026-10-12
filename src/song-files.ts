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
	return {
		size: blob.size,
		read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
	}
}

export function isByteSource(data: Uint8Array | ByteSource): data is ByteSource {
	return !(data instanceof Uint8Array)
}

/** The bytes of a file scan-chart has already read. Parsing reads every chart and .ini file before it starts. */
export function fileBytes(file: SongFile): Uint8Array {
	if (isByteSource(file.data)) throw new Error(`"${file.fileName}" hasn't been read`)
	return file.data
}

const CHUNK_SIZE = 16 * 1024 * 1024

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
