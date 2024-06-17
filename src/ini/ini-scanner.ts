import { FolderIssueType, MetadataIssueType } from '../interfaces'
import { hasIniExtension, hasIniName, removeStyleTags } from '../utils'
import { parseIni } from './ini-parser'

type TypedSubset<O, K extends keyof O, T> = O[K] extends T ? K : never
type StringProperties<O> = { [key in keyof O as TypedSubset<O, key, string>]: string }
type NumberProperties<O> = { [key in keyof O as TypedSubset<O, key, number>]: number }
type BooleanProperties<O> = { [key in keyof O as TypedSubset<O, key, boolean>]: boolean }

type Metadata = typeof defaultMetadata
type InputMetaStringKey = keyof StringProperties<InputMetadata>
type MetaStringKey = keyof StringProperties<Metadata>
type InputMetaNumberKey = keyof NumberProperties<InputMetadata>
type MetaNumberKey = keyof NumberProperties<Metadata>
type InputMetaBooleanKey = keyof BooleanProperties<InputMetadata>
type MetaBooleanKey = keyof BooleanProperties<Metadata>

type InputMetadata = Metadata & {
	frets: string
	track: number
	hopofreq: number
	star_power_note: number
}
export const defaultMetadata = {
	name: 'Unknown Name',
	artist: 'Unknown Artist',
	album: 'Unknown Album',
	genre: 'Unknown Genre',
	year: 'Unknown Year',
	charter: 'Unknown Charter',
	/** Units of ms */ song_length: 0,
	diff_band: -1,
	diff_guitar: -1,
	diff_guitar_coop: -1,
	diff_rhythm: -1,
	diff_bass: -1,
	diff_drums: -1,
	diff_drums_real: -1,
	diff_keys: -1,
	diff_guitarghl: -1,
	diff_guitar_coop_ghl: -1,
	diff_rhythm_ghl: -1,
	diff_bassghl: -1,
	diff_vocals: -1,
	/** Units of ms */ preview_start_time: -1,
	icon: '',
	loading_phrase: '',
	album_track: 16000,
	playlist_track: 16000,
	modchart: false,
	/** Units of ms */ delay: 0,
	hopo_frequency: 0,
	eighthnote_hopo: false,
	multiplier_note: 0,
	sustain_cutoff_threshold: -1,
	video_start_time: 0,
	five_lane_drums: false,
	pro_drums: false,
	end_events: true,
}

const integerProperties: MetaNumberKey[] = [
	'song_length',
	'diff_band',
	'diff_guitar',
	'diff_guitar_coop',
	'diff_rhythm',
	'diff_bass',
	'diff_drums',
	'diff_drums_real',
	'diff_keys',
	'diff_guitarghl',
	'diff_guitar_coop_ghl',
	'diff_rhythm_ghl',
	'diff_bassghl',
	'diff_vocals',
	'preview_start_time',
	'album_track',
	'playlist_track',
	'delay',
	'hopo_frequency',
	'multiplier_note',
	'sustain_cutoff_threshold',
	'video_start_time',
]
const requiredProperties: MetaStringKey[] = ['name', 'artist', 'album', 'genre', 'year', 'charter']

export function scanIni(files: { fileName: string; data: Uint8Array }[]) {
	const folderIssues: { folderIssue: FolderIssueType; description: string }[] = []

	const findIniDataResult = findIniData(files)
	folderIssues.push(...findIniDataResult.folderIssues)
	if (!findIniDataResult.iniData) {
		return { metadata: null, folderIssues, metadataIssues: [] }
	}

	const parseIniResult = parseIni(findIniDataResult.iniData)
	folderIssues.push(...parseIniResult.folderIssues)
	const songSection = parseIniResult.iniObject.song || parseIniResult.iniObject.Song || parseIniResult.iniObject.SONG
	if (songSection === undefined) {
		folderIssues.push({ folderIssue: 'invalidMetadata', description: '"song.ini" doesn\'t have a "[Song]" section.' })
		return { metadata: null, folderIssues, metadataIssues: [] }
	}

	const { metadata, metadataIssues } = extractSongMetadata(songSection)

	return { metadata, folderIssues, metadataIssues }
}

/**
 * @returns the .ini file data in this chart, or `null` if one wasn't found.
 */
function findIniData(files: { fileName: string; data: Uint8Array }[]): {
	iniData: Uint8Array | null
	folderIssues: { folderIssue: FolderIssueType; description: string }[]
} {
	const folderIssues: { folderIssue: FolderIssueType; description: string }[] = []
	let iniCount = 0
	let bestIniData: Uint8Array | null = null
	let lastIniData: Uint8Array | null = null

	for (const file of files) {
		if (hasIniExtension(file.fileName)) {
			iniCount++
			lastIniData = file.data
			if (!hasIniName(file.fileName)) {
				folderIssues.push({ folderIssue: 'invalidIni', description: `"${file.fileName}" is not named "song.ini".` })
			} else {
				bestIniData = file.data
			}
		}
	}

	if (iniCount > 1) {
		folderIssues.push({ folderIssue: 'multipleIniFiles', description: 'This chart has multiple .ini files.' })
	}

	if (bestIniData !== null) {
		return { iniData: bestIniData, folderIssues }
	} else if (lastIniData !== null) {
		return { iniData: lastIniData, folderIssues }
	} else {
		folderIssues.push({ folderIssue: 'noMetadata', description: 'This chart doesn\'t have "song.ini".' })
		return { iniData: null, folderIssues }
	}
}

/**
 * @returns the chart metadata found in `songSection`, using default values if not found.
 */
function extractSongMetadata(songSection: { [key: string]: string }): {
	metadata: typeof defaultMetadata
	metadataIssues: { metadataIssue: MetadataIssueType; description: string }[]
} {
	const metadataIssues: { metadataIssue: MetadataIssueType; description: string }[] = []

	const metadata: typeof defaultMetadata = {
		name: getIniString(songSection, 'name'),
		artist: getIniString(songSection, 'artist'),
		album: getIniString(songSection, 'album'),
		genre: getIniString(songSection, 'genre'),
		year: getIniString(songSection, 'year'),
		charter: getIniString(songSection, 'charter', 'frets'),
		song_length: getIniInteger(songSection, 'song_length'),
		diff_band: getIniInteger(songSection, 'diff_band'),
		diff_guitar: getIniInteger(songSection, 'diff_guitar'),
		diff_guitar_coop: getIniInteger(songSection, 'diff_guitar_coop'),
		diff_rhythm: getIniInteger(songSection, 'diff_rhythm'),
		diff_bass: getIniInteger(songSection, 'diff_bass'),
		diff_drums: getIniInteger(songSection, 'diff_drums'),
		diff_drums_real: getIniInteger(songSection, 'diff_drums_real'),
		diff_keys: getIniInteger(songSection, 'diff_keys'),
		diff_guitarghl: getIniInteger(songSection, 'diff_guitarghl'),
		diff_guitar_coop_ghl: getIniInteger(songSection, 'diff_guitar_coop_ghl'),
		diff_rhythm_ghl: getIniInteger(songSection, 'diff_rhythm_ghl'),
		diff_bassghl: getIniInteger(songSection, 'diff_bassghl'),
		diff_vocals: getIniInteger(songSection, 'diff_vocals'),
		preview_start_time: getIniInteger(songSection, 'preview_start_time'),
		icon: getIniString(songSection, 'icon'),
		loading_phrase: getIniString(songSection, 'loading_phrase'),
		album_track: getIniInteger(songSection, 'album_track', 'track'),
		playlist_track: getIniInteger(songSection, 'playlist_track'),
		modchart: getIniBoolean(songSection, 'modchart'),
		delay: getIniInteger(songSection, 'delay'),
		hopo_frequency: getIniInteger(songSection, 'hopo_frequency', 'hopofreq'),
		eighthnote_hopo: getIniBoolean(songSection, 'eighthnote_hopo'),
		multiplier_note: getIniInteger(songSection, 'multiplier_note', 'star_power_note'),
		sustain_cutoff_threshold: getIniInteger(songSection, 'sustain_cutoff_threshold'),
		video_start_time: getIniInteger(songSection, 'video_start_time'),
		five_lane_drums: getIniBoolean(songSection, 'five_lane_drums'),
		pro_drums: getIniBoolean(songSection, 'pro_drums'),
		end_events: getIniBoolean(songSection, 'end_events'),
	}

	metadata.icon = metadata.icon.toLowerCase() // Icons are interpreted as lowercase in CH
	if (metadata.icon === metadata.charter.toLowerCase()) {
		// Setting `icon` can be redundant
		metadata.icon = ''
	}
	for (const integerProperty of integerProperties) {
		if (!Number.isInteger(metadata[integerProperty])) {
			metadataIssues.push({
				metadataIssue: 'invalidValue',
				description: `The "${integerProperty}" value in "song.ini" is "${metadata[integerProperty]}", which is not an integer.`,
			})
			metadata[integerProperty] = Math.round(metadata[integerProperty])
		}
	}
	for (const requiredProperty of requiredProperties) {
		if (metadata[requiredProperty] === defaultMetadata[requiredProperty]) {
			metadataIssues.push({ metadataIssue: 'missingValue', description: `Metadata is missing the "${requiredProperty}" property.` })
		}
	}
	if (metadata.multiplier_note !== 0 && metadata.multiplier_note !== 103 && metadata.multiplier_note !== 116) {
		metadataIssues.push({
			metadataIssue: 'invalidValue',
			description: `The "multiplier_note" value in "song.ini" is "${metadata.multiplier_note}", which is not a valid value.`,
		})
		metadata.multiplier_note = 0
	}
	if (metadata.pro_drums && metadata.five_lane_drums) {
		metadataIssues.push({
			metadataIssue: 'invalidValue',
			description: 'Metadata contains both the "pro_drums" and "five_lane_drums" properties, which is not supported.',
		})
	}

	return { metadata, metadataIssues }
}

/**
 * @returns the value in `songSection` at `key`, parsed as a string.
 * Falls back to `legacyKey` if not found or invalid.
 * Then falls back to the default value if `legacyKey` is not found or invalid.
 * Any style tags are removed from the string.
 */
function getIniString(songSection: { [key: string]: string }, key: MetaStringKey, legacyKey?: Exclude<InputMetaStringKey, MetaStringKey>) {
	const value = songSection[key]
	if (value && value !== '0' && value !== '-1') {
		return removeStyleTags(value)
	} else if (legacyKey) {
		const legacyValue = songSection[legacyKey]
		if (legacyValue && legacyValue !== '0' && legacyValue !== '-1') {
			return removeStyleTags(legacyValue)
		}
	}

	return defaultMetadata[key]
}

/**
 * @returns the value in `songSection` at `key`, parsed as an integer.
 * Falls back to `legacyKey` if not found or invalid.
 * Then falls back to the default value if `legacyKey` is not found or invalid.
 */
function getIniInteger(songSection: { [key: string]: string }, key: MetaNumberKey, legacyKey?: Exclude<InputMetaNumberKey, MetaNumberKey>) {
	const value = parseFloat(songSection[key])
	if (!isNaN(value) && value !== -1) {
		return value
	} else if (legacyKey) {
		const legacyValue = parseFloat(songSection[legacyKey])
		if (!isNaN(legacyValue) && legacyValue !== -1) {
			return legacyValue
		}
	}

	return defaultMetadata[key]
}

/**
 * @returns the value in `songSection` at `key`, parsed as a boolean.
 * Falls back to `legacyKey` if not found or invalid.
 * Then falls back to the default value if `legacyKey` is not found or invalid.
 */
function getIniBoolean(songSection: { [key: string]: string }, key: MetaBooleanKey, legacyKey?: Exclude<InputMetaBooleanKey, MetaBooleanKey>) {
	const value = songSection[key]
	if (value === 'True' || value === '1') {
		return true
	} else if (value === 'False' || value === '0') {
		return false
	} else if (legacyKey) {
		const legacyValue = songSection[legacyKey]
		if (legacyValue === 'True' || legacyValue === '1') {
			return true
		} else if (legacyValue === 'False' || legacyValue === '0') {
			return false
		}
	}

	return defaultMetadata[key]
}
