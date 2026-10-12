import * as _ from 'lodash'

import { File, FolderIssueType } from '../types'
import { getBasename, hasAudioExtension, hasAudioName } from '../shared/file-names'

export function scanAudio(files: File[]) {
	const folderIssues: { folderIssue: FolderIssueType; description: string }[] = []

	const findAudioDataResult = findAudioData(files)
	folderIssues.push(...findAudioDataResult.folderIssues)
	if (findAudioDataResult.audioData.length === 0) {
		return { audioHash: null, audioLength: null, folderIssues }
	}

	return { audioHash: null, audioLength: null, folderIssues }
}

/**
 * @returns the audio file(s) in this chart, or `[]` if none were found.
 */
function findAudioData(files: File[]) {
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
