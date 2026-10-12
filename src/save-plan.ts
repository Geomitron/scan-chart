import { documentFiles, SongDocument, songOrigin } from './song-document'
import { byteSourceBlob, ByteSource, CHUNK_SIZE, isByteSource, SongFile } from './song-files'
import { saveEdited, SaveReport, songHashes } from './song-save'

/** Part of a byte source, written without being read until the file is written. */
export interface ByteRange {
	readonly source: ByteSource
	readonly offset: number
	readonly length: number
}

/** One file of a save plan: its bytes, in pieces, and its size. */
export interface PlannedFile {
	readonly fileName: string
	readonly size: number
	readonly pieces: readonly (Uint8Array | ByteRange)[]
}

/** The files saving a song writes, and what saving did. */
export interface SavePlan {
	readonly files: readonly PlannedFile[]
	readonly report: SaveReport
}

/**
 * Plans saving a song: every file of its folder. A song no edit made comes back byte for byte. An edited song is
 * also normalized wherever that changes no hash its edits didn't (E7), against the hashes of the song its chain of
 * edits started from; the report lists the hashes the edits spent and what was normalized or withheld. Files
 * scan-chart didn't read stay byte sources, read only when the plan is written.
 */
export function serializeSong(song: SongDocument): SavePlan {
	const origin = songOrigin(song)
	if (origin === undefined) return planOf(documentFiles(song), { spentHashes: null, normalized: [], withheld: [] })
	const { files, report } = saveEdited(song, () => {
		if (origin.hashes === undefined) {
			origin.hashes = songHashes(origin.song!)
			origin.song = null
		}
		return origin.hashes
	})
	return planOf(files, report)
}

function planOf(files: readonly SongFile[], report: SaveReport): SavePlan {
	return {
		files: files.map(({ fileName, data }) => isByteSource(data)
			? { fileName, size: data.size, pieces: [{ source: data, offset: 0, length: data.size }] }
			: { fileName, size: data.length, pieces: [data] }),
		report,
	}
}

/**
 * A save plan's files as `Blob`s, such as for a browser download. A byte range is copied from its `Blob` without
 * being read, so it has to come from `byteSourceFromBlob`; throws for another byte source, which
 * `writeSavePlanFile` can write.
 */
export function savePlanToBlobs(plan: SavePlan): readonly { readonly fileName: string; readonly blob: Blob }[] {
	return plan.files.map(file => ({
		fileName: file.fileName,
		blob: new Blob(file.pieces.map(piece => {
			if (piece instanceof Uint8Array) return piece as Uint8Array<ArrayBuffer>
			const blob = byteSourceBlob(piece.source)
			if (blob === undefined) throw new RangeError(`"${file.fileName}" is read from a byte source that isn't a Blob, so write it with writeSavePlanFile`)
			return blob.slice(piece.offset, piece.offset + piece.length)
		})),
	}))
}

/**
 * Writes one file of a save plan to a stream, reading its byte ranges in chunks, then closes the stream. If writing
 * fails, the stream is aborted and the error is thrown.
 */
export async function writeSavePlanFile(file: PlannedFile, stream: WritableStream<Uint8Array>): Promise<void> {
	const writer = stream.getWriter()
	try {
		for (const piece of file.pieces) {
			if (piece instanceof Uint8Array) {
				await writer.write(piece)
				continue
			}
			for (let offset = 0; offset < piece.length; offset += CHUNK_SIZE) {
				await writer.write(await piece.source.read(piece.offset + offset, Math.min(CHUNK_SIZE, piece.length - offset)))
			}
		}
		await writer.close()
	} catch (error) {
		await writer.abort(error).catch(() => undefined)
		throw error
	}
}
