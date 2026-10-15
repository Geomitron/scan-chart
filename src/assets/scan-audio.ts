
import type { FolderFinding } from '../issues'
import type { SongFile } from '../song-files'
import { getBasename, getExtension, hasAudioExtension, hasAudioName, hasCrowdOrPreviewName } from '../shared/file-names'

export function scanAudio(files: readonly SongFile[]) {
	const folderIssues: FolderFinding[] = []

	const findAudioDataResult = findAudioData(files)
	folderIssues.push(...findAudioDataResult.folderIssues)
	const { stemFiles } = findAudioDataResult
	if (findAudioDataResult.audioData.length === 0) {
		return { audioHash: null, audioLength: null, stemFiles, folderIssues }
	}

	return { audioHash: null, audioLength: null, stemFiles, folderIssues }
}

/**
 * @returns the audio file(s) in this chart, or `[]` if none were found.
 */
function findAudioData(files: readonly SongFile[]) {
	const folderIssues: FolderFinding[] = []
	const audioData: SongFile['data'][] = []
	const stemNames: string[] = []
	const stemFiles: SongFile[] = []

	for (const file of files) {
		if (hasAudioExtension(file.fileName)) {
			if (hasAudioName(file.fileName)) {
				stemNames.push(getBasename(file.fileName))
				stemFiles.push(file)
				if (!hasCrowdOrPreviewName(file.fileName)) {
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

	return { audioData, stemFiles, folderIssues }
}

/**
 * The charting recommendations about the audio files' names: Opus audio, a lone audio file named "song" or "guitar",
 * and no crowd or preview audio. `stemFiles` are the files named as stems.
 */
export function audioNameRecommendations(stemFiles: readonly SongFile[]): FolderFinding[] {
	const folderIssues: FolderFinding[] = []
	for (const { fileName } of stemFiles) {
		if (getExtension(fileName).toLowerCase() !== 'opus') {
			folderIssues.push({
				folderIssue: 'audioFormat',
				description: `"${fileName}" isn't Opus. .opus is the recommended audio format: it's the smallest at the same quality.`,
				file: fileName,
			})
		}
	}
	// A lone guitar file is accepted too, though "song" is recommended.
	const stem = (fileName: string) => getBasename(fileName).toLowerCase()
	const mainStems = stemFiles.filter(file => !hasCrowdOrPreviewName(file.fileName))
	const only = mainStems[0]
	if (only !== undefined && mainStems.every(file => stem(file.fileName) === stem(only.fileName)) && !['song', 'guitar'].includes(stem(only.fileName))) {
		folderIssues.push({
			folderIssue: 'singleAudioName',
			description: `This chart's only audio file is "${only.fileName}". The audio of a chart without stems is named "song".`,
			file: only.fileName,
		})
	}
	for (const { fileName } of stemFiles) {
		if (stem(fileName) === 'preview') {
			folderIssues.push({
				folderIssue: 'discouragedAudio',
				description: `"${fileName}" is discouraged. Set "preview_start_time" in song.ini instead, so games play the preview from the song's audio.`,
				file: fileName,
			})
		} else if (stem(fileName) === 'crowd') {
			folderIssues.push({ folderIssue: 'discouragedAudio', description: `"${fileName}" is discouraged by the charting guidelines.`, file: fileName })
		}
	}
	return folderIssues
}
