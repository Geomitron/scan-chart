import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { constants, readFile, stat } from 'fs/promises'
import { SngHeader, SngStream } from 'parse-sng'
import { basename } from 'path'
import { Readable } from 'stream'

export class CachedFile {

	public name: string

	// eslint-disable-next-line @typescript-eslint/naming-convention
	private constructor(public filepath: string, private _data: Buffer | null = null, private _readStream: Readable | null, name?: string) {
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
			return new CachedFile(filepath, null, createReadStream(filepath))
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

		const sngStream = new SngStream((start, end) => createReadStream(filepath, { start: Number(start), end: Number(end) || undefined }))
		sngStream.on('header', header => sngHeader = header)

		await new Promise<void>((resolve, reject) => {

			sngStream.on('error', err => reject(err))

			sngStream.on('files', files => {
				cachedFiles = Promise.all(files.map(async file => {

					const fileSizeMiB = Number(sngHeader.fileMeta.find(fm => fm.filename === file.fileName)!.contentsLen) / 1024 / 1024

					if (fileSizeMiB < 2048) {
						return new CachedFile(filepath, await new Promise<Buffer>((resolve, reject) => {
							const chunks: Buffer[] = []

							file.fileStream.on('error', reject)
							file.fileStream.on('data', (chunk: Buffer) => {
								chunks.push(chunk)
							})
							file.fileStream.on('end', () => {
								resolve(Buffer.concat(chunks))
							})
						}), null, file.fileName)
					} else {
						return new CachedFile(filepath, null, file.fileStream, file.fileName)
					}
				}))

				resolve()
			})
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
			return Readable.from(this._data)
		} else {
			return this._readStream!
		}
	}

	async getMD5() {
		const hash = createHash('md5')

		const readStream = this.readStream

		readStream.on('data', chunk => {
			hash.update(chunk)
		})

		return new Promise<string>(resolve => {
			readStream.on('end', () => {
				resolve(hash.digest('hex'))
			})
		})
	}
}
