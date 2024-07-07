import * as _ from 'lodash'

import { FolderIssueType } from '../interfaces'
import { getBasename, hasAudioExtension, hasAudioName } from '../utils'

// TODO: use _max_threads
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function scanAudio(files: { fileName: string; data: Uint8Array }[]) {
	const folderIssues: { folderIssue: FolderIssueType; description: string }[] = []

	const findAudioDataResult = findAudioData(files)
	folderIssues.push(...findAudioDataResult.folderIssues)
	if (findAudioDataResult.audioData.length === 0) {
		return { audioHash: null, audioLength: null, folderIssues }
	}

	// TODO: Implement this when determining the best audio fingerprint algorithm
	// const audioParser = new AudioParser(max_threads)
	// const { audioHash, audioLength, errors } = await audioParser.getAudioFingerprint(audioFiles)

	// if (errors.length) {
	// 	this.addFolderIssue('badAudio', `This chart's audio couldn't be parsed:\n${errors.join('\n')}`)
	// } else {
	// 	this.audioHash = audioHash
	// 	this.audioLength = audioLength
	// }

	return { audioHash: null, audioLength: null, folderIssues }
}

/**
 * @returns the audio file(s) in this chart, or `[]` if none were found.
 */
function findAudioData(files: { fileName: string; data: Uint8Array }[]) {
	const folderIssues: { folderIssue: FolderIssueType; description: string }[] = []
	const audioData: Uint8Array[] = []
	const stemNames: string[] = []

	for (const file of files) {
		if (hasAudioExtension(file.fileName)) {
			if (hasAudioName(file.fileName)) {
				stemNames.push(getBasename(file.fileName))
				if (!['preview', 'crowd'].includes(getBasename(file.fileName).toLowerCase())) {
					audioData.push(file.data)
				}
			} else {
				folderIssues.push({ folderIssue: 'invalidAudio', description: `"${file.fileName}" is not a valid audio stem name.` })
			}
		}
	}

	if (_.uniq(stemNames).length !== stemNames.length) {
		folderIssues.push({ folderIssue: 'multipleAudio', description: 'This chart has multiple audio files of the same stem.' })
	}

	if (audioData.length === 0) {
		folderIssues.push({ folderIssue: 'noAudio', description: "This chart doesn't have an audio file." })
	}

	return { audioData, folderIssues }
}
