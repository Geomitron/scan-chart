import sharp from 'sharp'

import { CachedFile } from 'src/cached-file'
import { FolderIssueType } from '../interfaces'
import { hasAlbumName } from '../utils'

class ImageScanner {

	public albumBuffer: Buffer | null = null
	public folderIssues: { folderIssue: FolderIssueType; description: string }[] = []

	private addFolderIssue(folderIssue: FolderIssueType, description: string) {
		this.folderIssues.push({ folderIssue, description })
	}

	public async scan(chartFolder: CachedFile[]) {
		const albumFile = this.getAlbumFile(chartFolder)
		if (!albumFile) { return }

		const albumBuffer = await this.getAlbumAtFile(albumFile)
		if (!albumBuffer) { return }

		this.albumBuffer = albumBuffer
	}

	/**
	 * @returns the album art file in this chart, or `null` if one wasn't found.
	 */
	private getAlbumFile(chartFolder: CachedFile[]) {
		let albumCount = 0
		let lastAlbum: CachedFile | null = null

		for (const file of chartFolder) {
			if (hasAlbumName(file.name)) {
				albumCount++
				lastAlbum = file
			}
		}

		if (albumCount > 1) {
			this.addFolderIssue('multipleAlbumArt', `This chart has multiple album art files.`)
		}

		if (lastAlbum !== null) {
			return lastAlbum
		} else {
			this.addFolderIssue('noAlbumArt', `This chart doesn't have album art.`)
			return null
		}
	}

	/**
	 * @returns a `Buffer` of the image data from the .jpg/.png file at `file`.
	 */
	private async getAlbumAtFile(file: CachedFile) {
		try {
			const image = sharp(file.data)
			const metadata = await image.metadata()
			const heightWidth = `${metadata.height}x${metadata.width}`
			if (heightWidth != '500x500' && heightWidth != '512x512') {
				this.addFolderIssue('albumArtSize', `This chart's album art is ${heightWidth}, and should be 512x512.`)
			}

			return await image
				.resize(512, 512)
				.jpeg({ quality: 75 }) // Note: reducing quality is more effective than reducing image size
				.toBuffer()
		} catch (err) {
			this.addFolderIssue('badAlbumArt', `This chart's album art couldn't be parsed.`)
		}
	}
}

export async function scanImage(chartFolder: CachedFile[]) {
	const imageScanner = new ImageScanner()
	await imageScanner.scan(chartFolder)
	return {
		albumBuffer: imageScanner.albumBuffer,
		folderIssues: imageScanner.folderIssues,
	}
}
