import type { FolderFinding } from '../issues'
import { fileBytes, SongFile } from '../song-files'
import { MetadataIssueType } from '../types'
import { hasIniExtension, hasIniName } from '../shared/file-names'
import { removeStyleTags } from '../shared/text'
import { defaultMetadata } from './metadata'
import { parseIni } from './parse-ini'

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

type ScanIniResult = {
	metadata: Metadata | null
	folderIssues: FolderFinding[]
	metadataIssues: { metadataIssue: MetadataIssueType; description: string }[]
	unknownIniValues: { [key: string]: string }
	/**
	 * The `[song]` section as Clone Hero reads it, or `null` when Clone Hero would not load one: it reads only a
	 * file named song.ini (in any letter case) and needs a `[song]` section. Keys are lowercase.
	 */
	songSection: { readonly [key: string]: string } | null
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
	'diff_keys_ghl',
	'diff_guitarghl',
	'diff_guitar_coop_ghl',
	'diff_rhythm_ghl',
	'diff_bassghl',
	'diff_vocals',
	'preview_start_time',
	'preview_end_time',
	'album_track',
	'playlist_track',
	'delay',
	'hopo_frequency',
	'multiplier_note',
	'sustain_cutoff_threshold',
	'chord_snap_threshold',
	'video_start_time',
]
const requiredProperties: MetaStringKey[] = ['name', 'artist', 'album', 'genre', 'year', 'charter']
/** Integer keys that change how notes parse. Clone Hero reads them with `IniFile.GetInt`, so they parse like `int.TryParse`. */
const chartModifierIntegers = ['hopo_frequency', 'multiplier_note', 'sustain_cutoff_threshold', 'chord_snap_threshold'] as const

export function scanIni(files: readonly SongFile[], options: { readonly removeStyleTags?: boolean } = {}): ScanIniResult {
	const folderIssues: FolderFinding[] = []

	const findIniDataResult = findIniData(files)
	folderIssues.push(...findIniDataResult.folderIssues)
	const { iniFile, iniData } = findIniDataResult
	if (iniFile === null || iniData === null) {
		return { metadata: null, folderIssues, metadataIssues: [], unknownIniValues: {}, songSection: null }
	}

	let parseIniResult: ReturnType<typeof parseIni>
	try {
		parseIniResult = parseIni(iniData)
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		folderIssues.push({ folderIssue: 'invalidMetadata', description: `"song.ini" couldn't be decoded: ${reason}`, file: iniFile.fileName })
		return { metadata: null, folderIssues, metadataIssues: [], unknownIniValues: {}, songSection: null }
	}
	folderIssues.push(...parseIniResult.folderIssues.map(issue => ({ ...issue, file: iniFile.fileName })))
	const songSection = parseIniResult.iniObject.song
	if (songSection === undefined) {
		folderIssues.push({ folderIssue: 'invalidMetadata', description: '"song.ini" doesn\'t have a "[Song]" section.', file: iniFile.fileName })
		return { metadata: null, folderIssues, metadataIssues: [], unknownIniValues: {}, songSection: null }
	}

	const { metadata, metadataIssues, unknownIniValues } = extractSongMetadata(songSection, options)

	return {
		metadata,
		folderIssues,
		metadataIssues,
		unknownIniValues,
		songSection: findIniDataResult.isSongIni ? songSection : null,
	}
}

/**
 * @returns the .ini file data in this chart, or `null` if one wasn't found. Prefers "song.ini", then that name in
 * another letter case, then the last other .ini file.
 */
export function findIniData(files: readonly SongFile[]): {
	iniFile: SongFile | null
	iniData: Uint8Array | null
	/** `true` if the chosen file is one Clone Hero reads: song.ini in any letter case. */
	isSongIni: boolean
	folderIssues: FolderFinding[]
} {
	const folderIssues: FolderFinding[] = []
	let iniCount = 0
	let bestIni: SongFile | null = null
	let songIni: SongFile | null = null
	let lastIni: SongFile | null = null

	for (const file of files) {
		if (hasIniExtension(file.fileName)) {
			iniCount++
			lastIni = file
			if (file.fileName.toLowerCase() === 'song.ini') songIni = file
			if (!hasIniName(file.fileName)) {
				folderIssues.push({ folderIssue: 'invalidIni', description: `"${file.fileName}" is not named "song.ini".`, file: file.fileName })
			} else {
				bestIni = file
			}
		}
	}

	if (iniCount > 1) {
		folderIssues.push({ folderIssue: 'multipleIniFiles', description: 'This chart has multiple .ini files.' })
	}

	const ini = bestIni ?? songIni ?? lastIni
	if (ini === null) {
		folderIssues.push({ folderIssue: 'noMetadata', description: 'This chart doesn\'t have "song.ini".' })
	}
	return { iniFile: ini, iniData: ini === null ? null : fileBytes(ini), isSongIni: ini?.fileName.toLowerCase() === 'song.ini', folderIssues }
}

/** All keys that extractSongMetadata reads (primary + legacy aliases). */
export const knownIniKeys = new Set([
	...Object.keys(defaultMetadata),
	'frets', 'track', // legacy aliases
])

/**
 * @returns the chart metadata found in `songSection`, using default values if not found.
 * Also returns all unrecognized key-value pairs for roundtrip preservation.
 * Text values have their style tags removed unless `removeStyleTags` is `false`; 8.x always removed them.
 */
export function extractSongMetadata(songSection: { readonly [key: string]: string }, options: { readonly removeStyleTags?: boolean } = {}): {
	metadata: typeof defaultMetadata
	metadataIssues: { metadataIssue: MetadataIssueType; description: string }[]
	unknownIniValues: { [key: string]: string }
} {
	const metadataIssues: { metadataIssue: MetadataIssueType; description: string }[] = []
	const text = (key: MetaStringKey, legacyKey?: Exclude<InputMetaStringKey, MetaStringKey>) =>
		getIniString(songSection, key, legacyKey, options.removeStyleTags ?? true)

	const metadata: typeof defaultMetadata = {
		name: text('name'),
		artist: text('artist'),
		album: text('album'),
		genre: text('genre'),
		year: text('year'),
		charter: text('charter', 'frets'),
		song_length: getIniInteger(songSection, 'song_length'),
		diff_band: getIniInteger(songSection, 'diff_band'),
		diff_guitar: getIniInteger(songSection, 'diff_guitar'),
		diff_guitar_coop: getIniInteger(songSection, 'diff_guitar_coop'),
		diff_rhythm: getIniInteger(songSection, 'diff_rhythm'),
		diff_bass: getIniInteger(songSection, 'diff_bass'),
		diff_drums: getIniInteger(songSection, 'diff_drums'),
		diff_drums_real: getIniInteger(songSection, 'diff_drums_real'),
		diff_keys: getIniInteger(songSection, 'diff_keys'),
		diff_keys_ghl: getIniInteger(songSection, 'diff_keys_ghl'),
		diff_guitarghl: getIniInteger(songSection, 'diff_guitarghl'),
		diff_guitar_coop_ghl: getIniInteger(songSection, 'diff_guitar_coop_ghl'),
		diff_rhythm_ghl: getIniInteger(songSection, 'diff_rhythm_ghl'),
		diff_bassghl: getIniInteger(songSection, 'diff_bassghl'),
		diff_vocals: getIniInteger(songSection, 'diff_vocals'),
		preview_start_time: getIniInteger(songSection, 'preview_start_time'),
		preview_end_time: getIniInteger(songSection, 'preview_end_time'),
		icon: text('icon'),
		loading_phrase: text('loading_phrase'),
		album_track: getIniInteger(songSection, 'album_track', 'track'),
		playlist_track: getIniInteger(songSection, 'playlist_track'),
		modchart: getIniBoolean(songSection, 'modchart'),
		delay: getIniInteger(songSection, 'delay'),
		// Clone Hero clamps hopo_frequency and reads no legacy alias for it or multiplier_note (SongGameMetadata.ParseFromIni).
		hopo_frequency: Math.min(Math.max(getChartModifierInteger(songSection, 'hopo_frequency'), 0), 65535),
		eighthnote_hopo: getIniBoolean(songSection, 'eighthnote_hopo'),
		multiplier_note: getChartModifierInteger(songSection, 'multiplier_note'),
		sustain_cutoff_threshold: getChartModifierInteger(songSection, 'sustain_cutoff_threshold'),
		chord_snap_threshold: getChartModifierInteger(songSection, 'chord_snap_threshold'),
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
	for (const key of chartModifierIntegers) {
		const value = songSection[key]
		if (value !== undefined && value !== '' && parseDotnetInt(value) === null) {
			metadataIssues.push({
				metadataIssue: 'invalidValue',
				description: `The "${key}" value in "song.ini" is "${value}", which is not an integer.`,
			})
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

	// Collect all unrecognized key-value pairs for roundtrip writing
	const unknownIniValues: { [key: string]: string } = {}
	for (const key of Object.keys(songSection)) {
		if (!knownIniKeys.has(key)) {
			unknownIniValues[key] = songSection[key]
		}
	}

	return { metadata, metadataIssues, unknownIniValues }
}

/**
 * @returns the value in `songSection` at `key`, parsed as a string.
 * Falls back to `legacyKey` if not found or invalid.
 * Then falls back to the default value if `legacyKey` is not found or invalid.
 * Style tags are removed from the string when `removeTags` is set.
 */
function getIniString(
	songSection: { readonly [key: string]: string },
	key: MetaStringKey,
	legacyKey: Exclude<InputMetaStringKey, MetaStringKey> | undefined,
	removeTags: boolean,
) {
	const clean = (value: string) => removeTags ? removeStyleTags(value) : value
	const value = songSection[key]
	if (value && value !== '0' && value !== '-1') {
		return clean(value)
	} else if (legacyKey) {
		const legacyValue = songSection[legacyKey]
		if (legacyValue && legacyValue !== '0' && legacyValue !== '-1') {
			return clean(legacyValue)
		}
	}

	return defaultMetadata[key]
}

/**
 * @returns the value in `songSection` at `key`, parsed as an integer.
 * Falls back to `legacyKey` if not found or invalid.
 * Then falls back to the default value if `legacyKey` is not found or invalid.
 */
function getIniInteger(songSection: { readonly [key: string]: string }, key: MetaNumberKey, legacyKey?: Exclude<InputMetaNumberKey, MetaNumberKey>) {
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
 * @returns the value in `songSection` at `key`, parsed as Clone Hero's `IniFile.GetInt` parses it, or the default.
 */
function getChartModifierInteger(songSection: { readonly [key: string]: string }, key: (typeof chartModifierIntegers)[number]) {
	const value = songSection[key]
	return (value === undefined ? null : parseDotnetInt(value)) ?? defaultMetadata[key]
}

/**
 * Parses `value` as .NET's `int.TryParse` does with the invariant culture: optional ASCII whitespace, an optional
 * sign, ASCII digits, optional whitespace, then optional NUL characters, within the signed 32-bit range.
 * @returns the integer, or `null` if .NET would not parse it.
 */
export function parseDotnetInt(value: string): number | null {
	const match = /^[\x09-\x0d ]*([+-]?[0-9]+)[\x09-\x0d ]*\x00*$/.exec(value)
	if (match === null) return null
	const parsed = Number(match[1])
	if (parsed < -2147483648 || parsed > 2147483647) return null
	return parsed === 0 ? 0 : parsed
}

/**
 * @returns the value in `songSection` at `key`, parsed as a boolean.
 * Falls back to `legacyKey` if not found or invalid.
 * Then falls back to the default value if `legacyKey` is not found or invalid.
 */
function getIniBoolean(songSection: { readonly [key: string]: string }, key: MetaBooleanKey, legacyKey?: Exclude<InputMetaBooleanKey, MetaBooleanKey>) {
	const parsed = parseBoolean(songSection[key])
	if (parsed !== null) {
		return parsed
	} else if (legacyKey) {
		const legacyParsed = parseBoolean(songSection[legacyKey])
		if (legacyParsed !== null) {
			return legacyParsed
		}
	}

	return defaultMetadata[key]
}

/**
 * Parses `value` as Clone Hero's `IniFile.TryGetBool` does: any integer `int.TryParse` accepts is `true` unless it
 * is 0, and "true" or "false" match in any letter case (e.g. "2" and "TRUE" are `true`; "yes" is not a boolean).
 * @returns `true`/`false` if `value` is a recognized boolean, or `null` otherwise.
 */
export function parseBoolean(value: string | undefined): boolean | null {
	if (value === undefined) return null
	const integer = parseDotnetInt(value)
	if (integer !== null) return integer !== 0
	const upper = value.toUpperCase()
	if (upper === 'TRUE') return true
	if (upper === 'FALSE') return false
	return null
}
