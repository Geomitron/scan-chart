import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'

import ffmpeg from 'fluent-ffmpeg'
import { pool, WorkerPool } from 'workerpool'

import { Config } from 'src/config'
import { calculateFingerprint } from './audio-fingerprint'

/** Maximum number of seconds of audio to analyze per stem */
const STREAM_DURATION = 100

@Injectable()
export class AudioParserService implements OnModuleInit, OnModuleDestroy {

	private pool: WorkerPool

	constructor(private config: Config) { }

	async onModuleInit() {
		this.pool = pool(undefined, { maxWorkers: this.config.MAX_THREADS })
	}

	onModuleDestroy() {
		this.pool.terminate(true)
	}

	/**
	 * Sets the `audioHash` array for each version in `unknownVersions`.
	 * If any of a version's audio files fail to scan, the version is removed from the array.
	 */
	async getAudioFingerprint(audioPaths: string[]) {
		let audioLengths: number[]
		try {
			audioLengths = await Promise.all(audioPaths.map(p => this.getAudioLength(p)))
		} catch (err) {
			return { audioHash: [] as number[], audioLength: null, errors: [err as string] }
		}

		const audioLength = Math.round(Math.max.apply(null, audioLengths))
		const minLength = Math.round(Math.min.apply(null, audioLengths))

		// FFMPEG's "amerge" filter output length is always the shortest input length
		// If the shortest input length is too short, use the "amix" filter instead
		const audioFilter = (audioPaths.length > 1 && minLength < STREAM_DURATION ? 'amix' : 'amerge')

		const { audioHash, errors } = await this.pool.exec(calculateFingerprint, [audioPaths, audioFilter])

		return {
			audioHash,
			audioLength,
			errors,
		}
	}

	/**
	 * @returns the length of the audio file at `folderPath/filepath` (in seconds).
	 * @throws an exception if the audio file could not be parsed.
	 */
	private async getAudioLength(audioPath: string) {
		return new Promise<number>((resolve, reject) => {
			ffmpeg(audioPath).ffprobe((err, metadata) => {
				if (err) {
					reject(`Failed to read audio file (${audioPath}):\n${err}`)
				} else if (!metadata) {
					reject(`Failed to read metadata from audio file (${audioPath}):\n${err}`)
				} else {
					if (metadata.format.duration) {
						resolve(metadata.format.duration)
					} else {
						reject(`Failed to read duration from audio file (${audioPath})`)
					}
				}
			})
		})
	}
}
