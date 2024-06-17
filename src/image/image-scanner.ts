import { load } from 'exifreader'

import { FolderIssueType } from '../interfaces'
import { hasAlbumName } from '../utils'

export function scanImage(files: { fileName: string; data: Uint8Array }[]) {
	const folderIssues: { folderIssue: FolderIssueType; description: string }[] = []

	const findAlbumDataResult = findAlbumData(files)
	folderIssues.push(...findAlbumDataResult.folderIssues)
	if (!findAlbumDataResult.albumData) {
		return { albumBuffer: null, folderIssues }
	}

	const getAlbumAtFileResult = extractImageMetadata(findAlbumDataResult.albumData)
	folderIssues.push(...getAlbumAtFileResult.folderIssues)

	return { albumBuffer: getAlbumAtFileResult.buffer, folderIssues }
}

/**
 * @returns the album art file data in this chart, or `null` if one wasn't found.
 */
function findAlbumData(files: { fileName: string; data: Uint8Array }[]) {
	const folderIssues: { folderIssue: FolderIssueType; description: string }[] = []
	let albumCount = 0
	let lastAlbumData: Uint8Array | null = null

	for (const file of files) {
		if (hasAlbumName(file.fileName)) {
			albumCount++
			lastAlbumData = file.data
		}
	}

	if (albumCount > 1) {
		folderIssues.push({ folderIssue: 'multipleAlbumArt', description: 'This chart has multiple album art files.' })
	}

	if (lastAlbumData !== null) {
		return { albumData: lastAlbumData, folderIssues }
	} else {
		folderIssues.push({ folderIssue: 'noAlbumArt', description: "This chart doesn't have album art." })
		return { albumData: null, folderIssues }
	}
}

function extractImageMetadata(data: Uint8Array) {
	const folderIssues: { folderIssue: FolderIssueType; description: string }[] = []
	try {
		const image = load(data)
		const height = image.ImageHeight || image['Image Height']
		const width = image.ImageWidth || image['Image Width']
		const heightWidth = `${height!.value}x${width!.value}`
		if (heightWidth !== '500x500' && heightWidth !== '512x512') {
			folderIssues.push({ folderIssue: 'albumArtSize', description: `This chart's album art is ${heightWidth}, and should be 512x512.` })
		}

		return { buffer: data, folderIssues }
	} catch (err) {
		folderIssues.push({ folderIssue: 'badAlbumArt', description: "This chart's album art couldn't be parsed." })
		return { buffer: null, folderIssues }
	}
}
