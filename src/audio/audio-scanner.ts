import * as _ from 'lodash'
import { parse } from 'path'

import { ChartFile, FolderIssueType } from '../interfaces'
import { hasAudioExtension, hasAudioName } from '../utils'
import { AudioParser } from './audio-parser'

class AudioScanner {

	public audioHash: number[] | null = null
	public audioLength: number | null = null
	public folderIssues: { folderIssue: FolderIssueType; description: string }[] = []

	private addFolderIssue(folderIssue: FolderIssueType, description: string) {
		this.folderIssues.push({ folderIssue, description })
	}

	public async scan(chartFolder: ChartFile[], max_threads: number) {
		const audioFiles = this.getAudioFiles(chartFolder)
		if (audioFiles.length === 0) { return }

		const audioParser = new AudioParser(max_threads)
		const { audioHash, audioLength, errors } = await audioParser.getAudioFingerprint(audioFiles)

		if (errors.length) {
			this.addFolderIssue('badAudio', `This chart's audio couldn't be parsed:\n${errors.join('\n')}`)
		} else {
			this.audioHash = audioHash
			this.audioLength = audioLength
		}
	}

	/**
	 * @returns the audio file(s) in this chart.
	 */
	private getAudioFiles(chartFolder: ChartFile[]) {
		const audioFiles: ChartFile[] = []
		const stemNames: string[] = []

		for (const file of chartFolder) {
			if (hasAudioExtension(file.name)) {
				if (hasAudioName(file.name)) {
					stemNames.push(parse(file.name).name)
					if (!['preview', 'crowd'].includes(parse(file.name.toLowerCase()).name)) {
						audioFiles.push(file)
					}
				} else {
					this.addFolderIssue('invalidAudio', `"${file.name}" is not a valid audio stem name`)
				}
			}
		}

		if (_.uniq(stemNames).length !== stemNames.length) {
			this.addFolderIssue('multipleAudio', `This chart has multiple audio files of the same stem`)
		}

		if (audioFiles.length === 0) {
			this.addFolderIssue('noAudio', `This chart doesn't have an audio file`)
		}

		return audioFiles
	}
}

export async function scanAudio(chartFolder: ChartFile[], max_threads: number) {
	const audioScanner = new AudioScanner()
	await audioScanner.scan(chartFolder, max_threads)
	return {
		audioHash: audioScanner.audioHash,
		audioLength: audioScanner.audioLength,
		folderIssues: audioScanner.folderIssues,
	}
}
