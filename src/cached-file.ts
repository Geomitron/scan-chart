import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { constants, readFile, stat } from 'fs/promises'
import { SngHeader, SngStream } from 'parse-sng'
import { basename } from 'path'
import { Readable } from 'stream'

export class CachedFile {

	public name: string

	private constructor(
		public filepath: string,
		// eslint-disable-next-line @typescript-eslint/naming-convention
		private _data: Buffer | null = null,
		// eslint-disable-next-line @typescript-eslint/naming-convention
		private _readStream: ReadableStream<Uint8Array> | null,
		name?: string,
	) {
		this.name = name ?? basename(filepath)
	}

	static async build(filepath: string) {

		const stats = await stat(filepath)
		if (!stats.isFile()) {
			throw new Error(`Can't read file at ${filepath}; not a file`)
		}
		if ((stats.mode & constants.S_IRUSR) === 0) {
			throw new Error(`Can't read file at ${filepath}; permission denied`)
		}

		const fileSizeMiB = stats.size / 1024 / 1024
		if (fileSizeMiB < 2048) {
			return new CachedFile(filepath, await readFile(filepath), null)
		} else {
			return new CachedFile(filepath, null, Readable.toWeb(createReadStream(filepath)) as ReadableStream<Uint8Array>)
		}
	}

	static async buildFromSng(filepath: string) {

		const stats = await stat(filepath)
		if (!stats.isFile()) {
			throw new Error(`Can't read file at ${filepath}; not a file`)
		}
		if ((stats.mode & constants.S_IRUSR) === 0) {
			throw new Error(`Can't read file at ${filepath}; permission denied`)
		}

		let sngHeader: SngHeader
		let cachedFiles: Promise<CachedFile[]>

		const sngStream = new SngStream(
			(start, end) => Readable.toWeb(
				createReadStream(filepath, { start: Number(start), end: Number(end) || undefined })
			) as ReadableStream<Uint8Array>
		)
		sngStream.on('header', header => sngHeader = header)

		await new Promise<void>((resolve, reject) => {

			sngStream.on('error', err => reject(err))

			sngStream.on('files', files => {
				cachedFiles = Promise.all(files.map(async ({ fileName, fileStream }) => {

					const fileSizeMiB = Number(sngHeader.fileMeta.find(fm => fm.filename === fileName)!.contentsLen) / 1024 / 1024

					if (fileSizeMiB < 2048) {
						const chunks: Uint8Array[] = []
						const reader = fileStream.getReader()

						// eslint-disable-next-line no-constant-condition
						while (true) {
							try {
								const result = await reader.read()
								if (result.done) { break }
								chunks.push(result.value)
							} catch (err) {
								reject(err)
								return new CachedFile(filepath, null, null)
							}
						}

						return new CachedFile(filepath, Buffer.concat(chunks), null, fileName)
					} else {
						return new CachedFile(filepath, null, fileStream, fileName)
					}
				}))

				resolve()
			})

			sngStream.start()
		})

		return {
			sngMetadata: sngHeader!.metadata,
			files: await cachedFiles!,
		}
	}

	/**
	 * This will throw an exception if the file is over 2 GiB.
	 */
	get data() {
		if (!this._data) {
			throw new Error(`Can't store full file in a buffer; larger than 2 GiB.`)
		}
		return this._data
	}

	/**
	 * A stream for the file's data. Creats a read stream of the cached data if the file is less than 2 GiB.
	 */
	get readStream() {
		if (this._data) {
			return Readable.toWeb(Readable.from(this._data)) as ReadableStream<Uint8Array>
		} else {
			return this._readStream!
		}
	}

	async getMD5() {
		const hash = createHash('md5')

		const reader = this.readStream.getReader()

		// eslint-disable-next-line no-constant-condition
		while (true) {
			const result = await reader.read()
			if (result.done) { break }
			hash.update(result.value)
		}

		return hash.digest('hex')
	}
}
