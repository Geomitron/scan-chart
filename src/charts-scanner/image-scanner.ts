import { FolderIssueType } from 'dbschema/interfaces'
import { join } from 'path'
import sharp from 'sharp'

import { hasAlbumName } from '../utils'
import { ChartFolder } from '../main'

export class ImageScanner {

	private albumBuffer: Buffer | null = null
	private folderIssues: { folderIssue: FolderIssueType; description: string }[] = []

	static async construct(chartFolder: ChartFolder) {
		const imageScanner = new ImageScanner()
		await imageScanner.scan(chartFolder)
		return {
			albumBuffer: imageScanner.albumBuffer,
			folderIssues: imageScanner.folderIssues,
		}
	}

	private constructor() { }

	private addFolderIssue(folderIssue: FolderIssueType, description: string) {
		this.folderIssues.push({ folderIssue, description })
	}

	private async scan(chartFolder: ChartFolder) {
		const albumFilepath = this.getAlbumFilepath(chartFolder);
		if (!albumFilepath) { return }

		const albumBuffer = await this.getAlbumAtFilepath(albumFilepath)
		if (!albumBuffer) { return }

		this.albumBuffer = albumBuffer
	}

	/**
	 * @returns the path to the .chart/.mid file in this chart, or `null` if one wasn't found.
	 */
	private getAlbumFilepath(chartFolder: ChartFolder) {
		let albumCount = 0
		let lastAlbumPath: string | null = null

		for (const file of chartFolder.files) {
			if (hasAlbumName(file.name)) {
				albumCount++
				lastAlbumPath = join(chartFolder.path, file.name)
			}
		}

		if (albumCount > 1) {
			this.addFolderIssue('multipleAlbumArt', `This chart has multiple album art files`)
		}

		if (lastAlbumPath !== null) {
			return lastAlbumPath
		} else {
			this.addFolderIssue('noAlbumArt', `This chart doesn't have album art`)
			return null
		}
	}

	/**
	 * @returns a `Buffer` of the image data from the .jpg/.png file at `fullPath`.
	 */
	private async getAlbumAtFilepath(fullPath: string) {
		try {
			const image = sharp(fullPath)
			const metadata = await image.metadata()
			const heightWidth = `${metadata.height}x${metadata.width}`
			if (heightWidth != '500x500' && heightWidth != '512x512') {
				this.addFolderIssue('albumArtSize', `This chart's album art is ${heightWidth}, and should be 512x512`)
			}

			return image
				.resize(500, 500)
				.jpeg({ quality: 75 }) // Note: reducing quality is more effective than reducing image size
				.toBuffer()
		} catch (err) {
			this.addFolderIssue('badAlbumArt', `This chart's album art couldn't be parsed`)
		}
	}
}
