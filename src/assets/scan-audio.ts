
import type { FolderFinding } from '../issues'
import type { SongFile } from '../song-files'
import { getBasename, hasAudioExtension, hasAudioName } from '../shared/file-names'

export function scanAudio(files: readonly SongFile[]) {
	const folderIssues: FolderFinding[] = []

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
function findAudioData(files: readonly SongFile[]) {
	const folderIssues: FolderFinding[] = []
	const audioData: SongFile['data'][] = []
	const stemNames: string[] = []

	for (const file of files) {
		if (hasAudioExtension(file.fileName)) {
			if (hasAudioName(file.fileName)) {
				stemNames.push(getBasename(file.fileName))
				if (!['preview', 'crowd'].includes(getBasename(file.fileName).toLowerCase())) {
					audioData.push(file.data)
				}
			} else {
				folderIssues.push({ folderIssue: 'invalidAudio', description: `"${file.fileName}" is not a valid audio stem name.`, file: file.fileName })
			}
		}
	}

	if (new Set(stemNames).size !== stemNames.length) {
		folderIssues.push({ folderIssue: 'multipleAudio', description: 'This chart has multiple audio files of the same stem.' })
	}

	if (audioData.length === 0) {
		folderIssues.push({ folderIssue: 'noAudio', description: "This chart doesn't have an audio file." })
	}

	return { audioData, folderIssues }
}
