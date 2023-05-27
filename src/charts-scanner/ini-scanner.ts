

import { FolderIssueType, MetadataIssueType } from 'dbschema/interfaces'
import * as _ from 'lodash'
import { join } from 'path'

import { hasIniExtension, hasIniName, isArray, removeStyleTags } from '../utils'
import { IniObject, IniParserService } from '../ini-parser/ini-parser'
import { ChartFolder } from '../main'

type TypedSubset<O, K extends keyof O, T> = O[K] extends T ? K : never
type StringProperties<O> = { [key in keyof O as TypedSubset<O, key, string>]: string }
type NumberProperties<O> = { [key in keyof O as TypedSubset<O, key, number>]: number }
type BooleanProperties<O> = { [key in keyof O as TypedSubset<O, key, boolean>]: boolean }

export type Metadata = typeof defaultMetadata
export type CInputMetaStringKey = keyof StringProperties<InputMetadata>
export type CMetaStringKey = keyof StringProperties<Metadata>
export type CInputMetaNumberKey = keyof NumberProperties<InputMetadata>
export type CMetaNumberKey = keyof NumberProperties<Metadata>
export type CInputMetaBooleanKey = keyof BooleanProperties<InputMetadata>
export type CMetaBooleanKey = keyof BooleanProperties<Metadata>

export type InputMetadata = Metadata & {
	'frets': string
	'track': number
}
export const defaultMetadata = {
	'name': 'Unknown Name',
	'artist': 'Unknown Artist',
	'album': 'Unknown Album',
	'genre': 'Unknown Genre',
	'year': 'Unknown Year',
	'charter': 'Unknown Charter',
	/** Units of ms */ 'song_length': 0,
	'diff_band': -1,
	'diff_guitar': -1,
	'diff_rhythm': -1,
	'diff_bass': -1,
	'diff_drums': -1,
	'diff_drums_real': -1,
	'diff_keys': -1,
	'diff_guitarghl': -1,
	'diff_bassghl': -1,
	/** Units of ms */ 'preview_start_time': -1,
	'icon': '',
	'loading_phrase': '',
	'album_track': 16000,
	'playlist_track': 16000,
	'modchart': false,
	/** Units of ms */ 'delay': 0,
	'hopo_frequency': 0,
	'eighthnote_hopo': false,
	'multiplier_note': 0,
	'video_start_time': 0,
	'five_lane_drums': false,
	'pro_drums': false,
	'end_events': true,
}

export class IniScanner {

	//private iniParserService: IniParserService
	private metadata: Metadata | null = null
	private folderIssues: { folderIssue: FolderIssueType; description: string }[] = []
	private metadataIssues: MetadataIssueType[] = []

	/** The ini object with parsed data from the song.ini file, or the notes.chart file if an ini doesn't exist */
	private iniObject: IniObject

	private iniParser = new IniParserService()

	static async construct(chartFolder: ChartFolder) {
		const iniScanner = new IniScanner()
		await iniScanner.scan(chartFolder)
		return {
			metadata: iniScanner.metadata,
			folderIssues: iniScanner.folderIssues,
			metadataIssues: iniScanner.metadataIssues,
		}
	}

	private constructor() {}

	private addFolderIssue(folderIssue: FolderIssueType, description: string) {
		this.folderIssues.push({ folderIssue, description })
	}
	private logError(description: string, err: Error) {
		throw new Error(description + '\n' + err.message + '\n' + err.stack)
	}

	/**
	 * Sets `this.metadata` to the ini metadata provided in `this.chartFolder`.
	 */
	private async scan(chartFolder: ChartFolder) {
		const iniFilepath = this.getIniFilepath(chartFolder)
		if (!iniFilepath) { return }

		const iniFile = await this.getIniAtFilepath(iniFilepath)
		if (!iniFile) { return }

		this.iniObject = iniFile
		this.iniObject.song = iniFile.song || iniFile.Song || iniFile.SONG

		if (iniFile.song === undefined) {
			this.addFolderIssue('invalidMetadata', `"song.ini" doesn't have a "[Song]" section`)
			return
		}

		this.extractIniMetadata()
		this.findMetadataIssues()
	}

	/**
	 * @returns the path to the .ini file in this chart, or `null` if one wasn't found.
	 */
	private getIniFilepath(chartFolder: ChartFolder) {
		let iniCount = 0
		let bestIniPath: string | null = null
		let lastIniPath: string | null = null

		for (const file of chartFolder.files) {
			if (hasIniExtension(file.name)) {
				iniCount++
				lastIniPath = join(chartFolder.path, file.name)
				if (!hasIniName(file.name)) {
					this.addFolderIssue('invalidIni', `"${file.name}" is not named "song.ini"`)
				} else {
					bestIniPath = join(chartFolder.path, file.name)
				}
			}
		}

		if (iniCount > 1) {
			this.addFolderIssue('multipleIniFiles', `This chart has multiple .ini files`)
		}

		if (bestIniPath !== null) {
			return bestIniPath
		} else if (lastIniPath !== null) {
			return lastIniPath
		} else {
			this.addFolderIssue('noMetadata', `This chart doesn't have "song.ini"`)
			return null
		}
	}

	/**
	 * @returns an `IIniObject` derived from the .ini file at `fullPath`, or `null` if the file couldn't be read.
	 */
	private async getIniAtFilepath(fullPath: string) {
		try {
			const { iniObject, iniErrors } = await this.iniParser.parse(fullPath)

			for (const iniError of iniErrors.slice(-5)) { // Limit this if there are too many errors
				this.addFolderIssue('badIniLine', _.truncate(iniError, { length: 200 }))
			}

			return iniObject
		} catch (err) {
			this.logError(`Error: Failed to read file at [${fullPath}]`, err)
			return null
		}
	}

	/**
	 * Stores all the metadata found in `this.iniFile.song` into `this.metadata` (uses default values if not found).
	 */
	private extractIniMetadata() {
		this.metadata = Object.assign({}, defaultMetadata)

		// Charter may be stored in `this.iniFile.song.frets`
		const strings = ['name', 'artist', 'album', 'genre', 'year', ['frets', 'charter'], 'icon', 'loading_phrase'] as const
		this.extractMetadataField<CInputMetaStringKey, CMetaStringKey>(this.extractMetadataString.bind(this), strings)
		this.metadata.icon = this.metadata.icon?.toLowerCase() // Icons are interpreted as lowercase in CH
		if (this.metadata.icon === this.metadata.charter?.toLowerCase()) { this.metadata.icon = '' } // Setting `icon` can be redundant

		// album_track may be stored in `this.iniFile.song.track`
		const integers = ['song_length', 'diff_band', 'diff_guitar', 'diff_rhythm', 'diff_bass', 'diff_drums', 'diff_drums_real',
			'diff_keys', 'diff_guitarghl', 'diff_bassghl', 'preview_start_time', ['track', 'album_track'], 'playlist_track',
			'delay', 'hopo_frequency', 'multiplier_note', 'video_start_time'] as const
		this.extractMetadataField<CInputMetaNumberKey, CMetaNumberKey>(this.extractMetadataInteger.bind(this), integers)

		const booleans = ['modchart', 'eighthnote_hopo', 'five_lane_drums', 'pro_drums', 'end_events'] as const
		this.extractMetadataField<CInputMetaBooleanKey, CMetaBooleanKey>(this.extractMetadataBoolean.bind(this), booleans)
	}

	/**
	 * Extracts `fields` from `this.metadata` using `extractFunction`.
	 * @param fields
	 * An array of single keys and two key tuple arrays.
	 * With a single key, the field will be extracted from the ini file at that key. It will then be saved in the metadata object at the same key.
	 * With an array of two keys, the field will be extracted from the ini file at both keys. (If both are defined, the second field is used)
	 * It will then be saved in the metadata object at the second key.
	 */
	private extractMetadataField<I, K extends I>(
		extractFunction: ((metadataField: K, iniField?: Exclude<I, K>) => void),
		fields: readonly (K | readonly [Exclude<I, K>, K])[]
	) {
		fields.forEach(value => {
			if (isArray(value)) {
				extractFunction(value[1], value[0])
				extractFunction(value[1])
			} else {
				extractFunction(value)
			}
		})
	}

	/**
	 * Stores `this.iniFile.song[iniField ?? metadataField]` into `this.metadata[metadataField]` if that field has an actual string value.
	 * Any style tags are removed from the string.
	 */
	private extractMetadataString(metadataField: CMetaStringKey, iniField?: Exclude<CInputMetaStringKey, CMetaStringKey>): void {
		const value = this.iniObject.song[iniField ?? metadataField]
		if (value && !['', '0', '-1'].includes(value)) {
			this.metadata![metadataField] = removeStyleTags(value)
		}
	}

	/**
	 * Stores `this.iniFile.song[iniField ?? metadataField]` into `this.metadata[metadataField]` if that field has an actual number value.
	 * All numbers are rounded to the nearest integer.
	 */
	private extractMetadataInteger(metadataField: CMetaNumberKey, iniField?: Exclude<CInputMetaNumberKey, CMetaNumberKey>): void {
		const value = parseFloat(this.iniObject.song[iniField ?? metadataField])
		if (!isNaN(value) && value !== -1) {
			const int = Math.round(value)
			if (int !== value) {
				this.addFolderIssue('badIniLine', `The "${iniField}" value in "song.ini" is "${value}", which is not an integer.`)
			}
			this.metadata![metadataField] = int
		}
	}

	/**
	 * Stores `this.iniFile.song[iniField ?? metadataField]` into `this.metadata[metadataField]` if that field has an actual boolean value.
	 */
	private extractMetadataBoolean(metadataField: CMetaBooleanKey, iniField?: Exclude<CInputMetaBooleanKey, CMetaBooleanKey>): void {
		const value = this.iniObject.song[iniField ?? metadataField]
		if (value === 'True' || value === '1') {
			this.metadata![metadataField] = true
		} else if (value === 'False' || value === '0') {
			this.metadata![metadataField] = false
		}
	}

	private findMetadataIssues() {
		if (this.metadata!.name === defaultMetadata.name) { this.metadataIssues.push('noName') }
		if (this.metadata!.artist === defaultMetadata.artist) { this.metadataIssues.push('noArtist') }
		if (this.metadata!.album === defaultMetadata.album) { this.metadataIssues.push('noAlbum') }
		if (this.metadata!.genre === defaultMetadata.genre) { this.metadataIssues.push('noGenre') }
		if (this.metadata!.year === defaultMetadata.year) { this.metadataIssues.push('noYear') }
		if (this.metadata!.charter === defaultMetadata.charter) { this.metadataIssues.push('noCharter') }
		if (this.metadata!.delay !== 0) { this.metadataIssues.push('nonzeroDelay') }
	}
}
