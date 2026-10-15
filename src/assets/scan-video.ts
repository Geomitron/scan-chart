import type { FolderFinding } from '../issues'
import type { SongFile } from '../song-files'
import { hasBadVideoName, hasVideoName } from '../shared/file-names'

export function scanVideo(files: readonly SongFile[]) {
	const folderIssues: FolderFinding[] = []

	const findVideoDataResult = findVideoData(files)
	folderIssues.push(...findVideoDataResult.folderIssues)

	return { hasVideoBackground: !!findVideoDataResult.videoData, folderIssues }
}

function findVideoData(files: readonly SongFile[]) {
	const folderIssues: FolderFinding[] = []
	let videoCount = 0
	let bestVideoData: SongFile['data'] | null = null
	let lastVideoData: SongFile['data'] | null = null

	for (const file of files) {
		if (hasVideoName(file.fileName)) {
			videoCount++
			lastVideoData = file.data
			if (hasBadVideoName(file.fileName)) {
				folderIssues.push({
					folderIssue: 'badVideo',
					description: `"${file.fileName}" will not work on Linux and should be converted to .webm.`,
					file: file.fileName,
				})
			} else {
				bestVideoData = file.data
			}
		}
	}

	if (videoCount > 1) {
		folderIssues.push({ folderIssue: 'multipleVideo', description: 'This chart has multiple video background files.' })
	}

	if (bestVideoData !== null) {
		return { videoData: bestVideoData, folderIssues }
	} else if (lastVideoData !== null) {
		return { videoData: lastVideoData, folderIssues }
	} else {
		return { videoData: null, folderIssues }
	}
}
