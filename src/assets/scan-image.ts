import { load } from 'exifreader'

import type { FolderFinding } from '../issues'
import { fileBytes, type SongFile } from '../song-files'
import { hasAlbumName } from '../shared/file-names'

/** The 8.x album art scan: the name checks, then the art decoded. Its file must already be bytes. 8.x also accepted 500x500. */
export function scanImage(files: readonly SongFile[]) {
	const album = findAlbumArt(files)
	if (album.file === null) return { albumBuffer: null, folderIssues: album.folderIssues }
	const data = fileBytes(album.file)
	const decoded = decodeAlbumArt(album.file.fileName, data, [500, 512])
	return { albumBuffer: decoded.decoded ? data : null, folderIssues: [...album.folderIssues, ...decoded.folderIssues] }
}

/** The album art file games read, the last one in the list, and the issues with the album art's names. Reads nothing. */
export function findAlbumArt(files: readonly SongFile[]): { file: SongFile | null; folderIssues: FolderFinding[] } {
	const folderIssues: FolderFinding[] = []
	const albumFiles = files.filter(file => hasAlbumName(file.fileName))
	if (albumFiles.length > 1) {
		folderIssues.push({ folderIssue: 'multipleAlbumArt', description: 'This chart has multiple album art files.' })
	}
	if (albumFiles.length === 0) {
		folderIssues.push({ folderIssue: 'noAlbumArt', description: "This chart doesn't have album art." })
	}
	return { file: albumFiles[albumFiles.length - 1] ?? null, folderIssues }
}

/**
 * Decodes the album art's dimensions. It's reported when it can't be decoded, or when it isn't a square of one of
 * `sizes`; an empty list accepts any square.
 */
export function decodeAlbumArt(file: string, data: Uint8Array, sizes: readonly number[]): { decoded: boolean; folderIssues: FolderFinding[] } {
	const size = imageSize(data)
	if (size === null) {
		return { decoded: false, folderIssues: [{ folderIssue: 'badAlbumArt', description: "This chart's album art couldn't be parsed.", file }] }
	}
	const { width, height } = size
	if (width === height && (sizes.length === 0 || sizes.includes(width))) return { decoded: true, folderIssues: [] }
	const accepted = sizes.length === 0 ? 'square' : sizes.map(side => `${side}x${side}`).join(' or ')
	return { decoded: true, folderIssues: [{ folderIssue: 'albumArtSize', description: `This chart's album art is ${width}x${height}, and should be ${accepted}.`, file }] }
}

/** An image's width and height, as exifreader reads them, or `null` when it can't read them. */
export function imageSize(data: Uint8Array): { width: number; height: number } | null {
	try {
		// exifreader reads the whole buffer, so a view into a larger one is copied.
		const image = load(data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : data.slice().buffer)
		const height = image.ImageHeight || image['Image Height']
		const width = image.ImageWidth || image['Image Width']
		const size = { width: Number(width!.value), height: Number(height!.value) }
		return Number.isFinite(size.width) && Number.isFinite(size.height) ? size : null
	} catch {
		return null
	}
}
