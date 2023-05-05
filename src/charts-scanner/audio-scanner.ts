

import { FolderIssueType } from 'dbschema/interfaces'
import * as _ from 'lodash'
import { join, parse } from 'path'

import { AppRef } from 'src/app.module'
import { hasAudioExtension, hasAudioName } from 'src/utils'
import { AudioParserService } from '../audio-parser/audio-parser.service'
import { ChartFolder } from './charts-scanner.service'

export class AudioScanner {

	private audioParserService = AppRef.get(AudioParserService)

	private audioHash: number[] | null = null
	private audioLength: number | null = null
	private folderIssues: { folderIssue: FolderIssueType; description: string }[] = []

	static async construct(chartFolder: ChartFolder) {
		const audioScanner = new AudioScanner()
		await audioScanner.scan(chartFolder)
		return {
			audioHash: audioScanner.audioHash,
			audioLength: audioScanner.audioLength,
			folderIssues: audioScanner.folderIssues,
		}
	}

	private constructor() { }

	private addFolderIssue(folderIssue: FolderIssueType, description: string) {
		this.folderIssues.push({ folderIssue, description })
	}

	private async scan(chartFolder: ChartFolder) {
		const audioPaths = this.getAudioFilepaths(chartFolder);
		if (audioPaths.length === 0) { return }

		const { audioHash, audioLength, errors } = await this.audioParserService.getAudioFingerprint(audioPaths)

		if (errors.length) {
			this.addFolderIssue('badAudio', `This chart's audio couldn't be parsed:\n${errors.join('\n')}`)
		} else {
			this.audioHash = audioHash
			this.audioLength = audioLength
		}
	}

	/**
	 * @returns the paths to the audio files in this chart.
	 */
	private getAudioFilepaths(chartFolder: ChartFolder) {
		const audioPaths: string[] = []
		const stemNames: string[] = []

		for (const file of chartFolder.files) {
			if (hasAudioExtension(file.name)) {
				if (hasAudioName(file.name)) {
					stemNames.push(parse(file.name).name)
					if (!['preview', 'crowd'].includes(parse(file.name.toLowerCase()).name)) {
						audioPaths.push(join(chartFolder.path, file.name))
					}
				} else {
					this.addFolderIssue('invalidAudio', `"${file.name}" is not a valid audio stem name`)
				}
			}
		}

		if (_.uniq(stemNames).length !== stemNames.length) {
			this.addFolderIssue('multipleAudio', `This chart has multiple audio files of the same stem`)
		}

		if (audioPaths.length === 0) {
			this.addFolderIssue('noAudio', `This chart doesn't have an audio file`)
		}

		return audioPaths
	}
}
