import { FolderIssueType } from '../interfaces'
import { hasBadVideoName, hasVideoName } from '../utils'

export function scanVideo(files: { fileName: string; data: Uint8Array }[]) {
	const folderIssues: { folderIssue: FolderIssueType; description: string }[] = []

	const findVideoDataResult = findVideoData(files)
	folderIssues.push(...findVideoDataResult.folderIssues)

	return { hasVideoBackground: !!findVideoDataResult.videoData, folderIssues }
}

function findVideoData(files: { fileName: string; data: Uint8Array }[]) {
	const folderIssues: { folderIssue: FolderIssueType; description: string }[] = []
	let videoCount = 0
	let bestVideoData: Uint8Array | null = null
	let lastVideoData: Uint8Array | null = null

	for (const file of files) {
		if (hasVideoName(file.fileName)) {
			videoCount++
			lastVideoData = file.data
			if (hasBadVideoName(file.fileName)) {
				folderIssues.push({
					folderIssue: 'badVideo',
					description: `"${file.fileName}" will not work on Linux and should be converted to .webm.`,
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
