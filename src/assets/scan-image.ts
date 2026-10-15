import { load } from 'exifreader'

import type { FolderFinding } from '../issues'
import { fileBytes, type SongFile } from '../song-files'
import { hasAlbumName } from '../shared/file-names'

/** Scans the album art. Its file must already be bytes; the other files are only looked at by name. */
export function scanImage(files: readonly SongFile[]) {
	const folderIssues: FolderFinding[] = []

	const findAlbumDataResult = findAlbumData(files)
	folderIssues.push(...findAlbumDataResult.folderIssues)
	if (!findAlbumDataResult.albumData) {
		return { albumBuffer: null, folderIssues }
	}

	const getAlbumAtFileResult = extractImageMetadata(findAlbumDataResult.albumData, findAlbumDataResult.fileName)
	folderIssues.push(...getAlbumAtFileResult.folderIssues)

	return { albumBuffer: getAlbumAtFileResult.buffer, folderIssues }
}

/**
 * @returns the album art file data in this chart, or `null` if one wasn't found.
 */
function findAlbumData(files: readonly SongFile[]) {
	const folderIssues: FolderFinding[] = []
	let albumCount = 0
	let lastAlbumFile: SongFile | null = null

	for (const file of files) {
		if (hasAlbumName(file.fileName)) {
			albumCount++
			lastAlbumFile = file
		}
	}

	if (albumCount > 1) {
		folderIssues.push({ folderIssue: 'multipleAlbumArt', description: 'This chart has multiple album art files.' })
	}

	if (lastAlbumFile !== null) {
		return { albumData: fileBytes(lastAlbumFile), fileName: lastAlbumFile.fileName, folderIssues }
	} else {
		folderIssues.push({ folderIssue: 'noAlbumArt', description: "This chart doesn't have album art." })
		return { albumData: null, fileName: null, folderIssues }
	}
}

function extractImageMetadata(data: Uint8Array, file: string) {
	const folderIssues: FolderFinding[] = []
	try {
		const image = load(data.buffer)
		const height = image.ImageHeight || image['Image Height']
		const width = image.ImageWidth || image['Image Width']
		const heightWidth = `${height!.value}x${width!.value}`
		if (heightWidth !== '500x500' && heightWidth !== '512x512') {
			folderIssues.push({ folderIssue: 'albumArtSize', description: `This chart's album art is ${heightWidth}, and should be 512x512.`, file })
		}

		return { buffer: data, folderIssues }
	} catch (err) {
		folderIssues.push({ folderIssue: 'badAlbumArt', description: "This chart's album art couldn't be parsed.", file })
		return { buffer: null, folderIssues }
	}
}
