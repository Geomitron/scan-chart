import { toLowerInvariant, trimDotnet } from '../shared/text'
import { type DrumType, drumTypes, type MetadataIssueType } from '../types'
import { defaultMetadata } from './metadata'
import type { IniTokens } from './parse-ini'
import { knownIniKeys, parseBoolean, parseDotnetInt } from './scan-ini'

type MetadataFinding = { metadataIssue: MetadataIssueType; description: string }
type SongSection = { readonly [key: string]: string }

/** What the song.ini checks read. */
export interface SongIniInput {
	readonly tokens: IniTokens
	/** The `[song]` section as read. */
	readonly songSection: SongSection
	/** The metadata read from it. */
	readonly metadata: typeof defaultMetadata
	/** Keys another issue asks to set, such as a charted instrument's difficulty, which aren't reported as blank. */
	readonly requiredKeys: readonly string[]
	/** The chart's format and drum type, or `null` when it didn't parse. `detectedDrumType` reads it without song.ini's drum flags. */
	readonly chart: { readonly format: 'chart' | 'mid'; readonly drumType: DrumType | null; readonly detectedDrumType: () => DrumType | null } | null
	/** Tags a caller's game reads. */
	readonly extraIniKeys: readonly (string | RegExp)[]
}

/** The tags of GuitarGame_ChartFormats' song.ini standard, besides the ones scan-chart reads. */
const standardTags = [
	'name', 'artist', 'album', 'genre', 'year', 'rating', 'charter', 'frets', 'version', 'preview_start_time', 'preview_end_time', 'playlist',
	'sub_playlist', 'album_track', 'track', 'playlist_track', 'song_length', 'modchart', 'loading_phrase', 'diff_band', 'diff_guitar', 'diff_guitarghl',
	'diff_guitar_coop', 'diff_guitar_coop_ghl', 'diff_guitar_real', 'diff_guitar_real_22', 'diff_rhythm', 'diff_rhythm_ghl', 'diff_bass', 'diff_bassghl',
	'diff_bass_real', 'diff_bass_real_22', 'diff_drums', 'diff_drums_real', 'diff_drums_real_ps', 'diff_keys', 'diff_keys_real', 'diff_keys_real_ps',
	'diff_vocals', 'diff_vocals_harm', 'diff_dance', 'pro_drums', 'five_lane_drums', 'vocal_gender', 'real_guitar_tuning', 'real_guitar_22_tuning',
	'real_bass_tuning', 'real_bass_22_tuning', 'vocal_scroll_speed', 'tuning_offset_cents', 'lyrics', 'delay', 'sustain_cutoff_threshold',
	'hopo_frequency', 'eighthnote_hopo', 'multiplier_note', 'star_power_note', 'icon', 'background', 'video', 'video_loop', 'video_start_time',
	'video_end_time', 'cover',
]
/** The tags a reader documents: the standard's, scan-chart's, and `explicit_lyrics`, which Clone Hero reads and the charting guidelines describe. */
export const knownIniTags = new Set([...standardTags, ...knownIniKeys, 'explicit_lyrics'])
/** The order the charting guidelines list tags in, which scan-chart writes them in. */
const tagOrder = Object.keys(defaultMetadata)

/**
 * The charting recommendations about song.ini: how it's written (its layout, its tags' order, blank and quoted values,
 * and tags no reader documents), then its values.
 */
export function songIniIssues(input: SongIniInput): MetadataFinding[] {
	const { tokens, songSection, extraIniKeys } = input
	const isExtra = (key: string) => extraIniKeys.some(extra => typeof extra === 'string' ? toLowerInvariant(extra) === key : extra.test(key))
	// A line starting with "//" is reported as a comment, though readers read one with "=" in it as a key.
	const keys = Object.keys(songSection).filter(key => !key.startsWith('//'))
	const known = keys.filter(key => knownIniTags.has(key) || isExtra(key))
	const unknown = keys.filter(key => !known.includes(key))
	const issues = layoutIssues(tokens)

	const ranked = known.filter(key => tagOrder.includes(key))
	for (let index = 1; index < ranked.length; index++) {
		const later = ranked.slice(0, index).find(key => tagOrder.indexOf(key) > tagOrder.indexOf(ranked[index]))
		if (later !== undefined) {
			issues.push({ metadataIssue: 'iniTagOrder', description: `In "song.ini", "${ranked[index]}" should come before "${later}".` })
			break
		}
	}

	const values = valueIssues(input)
	const blank = known.filter(key => isBlank(songSection[key]) && !input.requiredKeys.includes(key) && !values.missing.includes(key))
	if (blank.length > 0) {
		issues.push({ metadataIssue: 'blankIniValue', description: `In "song.ini", ${keyList(blank)} ${blank.length === 1 ? 'is' : 'are'} blank or -1. Remove ${blank.length === 1 ? 'that line' : 'those lines'} instead.` })
	}
	const quoted = known.filter(key => songSection[key].length >= 2 && songSection[key].startsWith('"') && songSection[key].endsWith('"'))
	if (quoted.length > 0) {
		issues.push({
			metadataIssue: 'quotedIniValue',
			description: `In "song.ini", ${keyList(quoted)} ${quoted.length === 1 ? 'is' : 'are'} in quotes. Games show the quotes, and don't read a number in quotes, so remove them.`,
		})
	}
	if (unknown.length > 0) {
		const [tags, them] = unknown.length === 1 ? ['a tag that isn\'t', 'it'] : ['tags that aren\'t', 'them']
		issues.push({
			metadataIssue: 'unknownIniTag',
			description: `"song.ini" has ${tags} in the song.ini standard: ${keyList(unknown)}. Remove ${them}, unless a game you chart for reads ${them}.`,
		})
	}
	return [...issues, ...values.issues]
}

const isBlank = (value: string | undefined) => value === '' || value === '-1'
/** Whether a value is set: present, and not blank or -1. */
const isSet = (value: string | undefined): value is string => value !== undefined && !isBlank(value)
// Whether every reader reads charter and album_track over their older tags, frets and track.
const hasCharter = (songSection: SongSection) => isSet(songSection.charter) && songSection.charter !== '0'
const hasAlbumTrack = (songSection: SongSection) => isSet(songSection.album_track) && !isNaN(parseFloat(songSection.album_track))

/**
 * The charting recommendations about song.ini's values, and the keys reported missing: song_length and album_track
 * unset, a difficulty outside 0 to 10, an icon that isn't an icon's name, a tag for older charts that changes how the
 * chart reads, and a drum type flag the chart doesn't need.
 */
function valueIssues({ songSection, metadata, chart }: SongIniInput): { issues: MetadataFinding[]; missing: string[] } {
	const issues: MetadataFinding[] = []
	const missing: string[] = []
	const add = (metadataIssue: MetadataIssueType, description: string) => issues.push({ metadataIssue, description })

	if (!(metadata.song_length > 0)) {
		missing.push('song_length')
		add('missingSongLength', 'Metadata is missing "song_length": set it to the length of the longest audio file, in milliseconds.')
	}
	// A single's album is its name followed by " - (Single)".
	if (metadata.album_track === defaultMetadata.album_track && metadata.album !== defaultMetadata.album && !/\bsingle\)?$/i.test(metadata.album.trim())) {
		missing.push('album_track')
		add('missingAlbumTrack', 'Metadata is missing "album_track": set it to the song\'s position on its album.')
	}

	for (const key of Object.keys(songSection).filter(key => key.startsWith('diff_'))) {
		const value = Number(songSection[key])
		if (Number.isInteger(value) && value !== -1 && (value < 0 || value > 10)) {
			add('difficultyRange', `In "song.ini", "${key}" is ${value}. Difficulties go from 0 to 6, or up to 10 for very hard charts.`)
		}
	}

	const icon = songSection.icon
	if (isSet(icon) && icon !== '0' && !/^[a-z0-9_-]+$/.test(icon)) {
		add('iconName', `In "song.ini", "icon" is "${icon}". Write the icon's file name without its extension, in lowercase letters, numbers, "-" and "_".`)
	}

	issues.push(...deprecatedTagIssues(songSection, metadata, chart))
	const unneeded = unneededKeys(songSection, metadata, chart).map(key => `${key} = ${songSection[key]}`)
	if (unneeded.length > 0) {
		const one = unneeded.length === 1
		add('defaultIniValue', `In "song.ini", ${keyList(unneeded)} ${one ? 'changes' : 'change'} nothing: games read the song the same without ${one ? 'it' : 'them'}. `
			+ `Remove ${one ? 'that line' : 'those lines'}.`)
	}

	// Both flags together are already invalid.
	const proDrums = parseBoolean(songSection.pro_drums) === true
	const fiveLaneDrums = parseBoolean(songSection.five_lane_drums) === true
	if (chart !== null && proDrums !== fiveLaneDrums) {
		const [key, type, name] = proDrums ? ['pro_drums', drumTypes.fourLanePro, '4-lane pro'] as const : ['five_lane_drums', drumTypes.fiveLane, '5-lane'] as const
		if (chart.drumType === null) {
			add('redundantDrumType', `"song.ini" sets "${key}", but the chart has no drums track. Remove the tag.`)
		} else if (chart.detectedDrumType() === type) {
			add('redundantDrumType', `"song.ini" sets "${key}", but games already read this drums chart as ${name}. Remove the tag.`)
		}
	}
	return { issues, missing }
}

/**
 * The keys set to what Clone Hero and YARG both read without them, for the chart's format, and the tags for older
 * charts that change nothing. A value only one of them reads as the default, such as `pro_drums = False` in a `.mid`
 * chart, which YARG reads as 4-lane drums, isn't one.
 */
function unneededKeys(songSection: SongSection, metadata: typeof defaultMetadata, chart: SongIniInput['chart']): string[] {
	const keys: string[] = []
	const check = (key: string, unneeded: (value: string) => boolean) => {
		const value = songSection[key]
		if (isSet(value) && unneeded(value)) keys.push(key)
	}
	const isFalse = (value: string) => parseBoolean(value) === false
	// As getIniInteger reads it.
	const isZero = (value: string) => parseFloat(value) === 0
	const isAtMostZero = (value: string) => (parseDotnetInt(value) ?? 1) <= 0
	check('delay', isZero)
	check('hopo_frequency', isAtMostZero)
	// hopo_frequency, when it's set, comes first.
	check('eighthnote_hopo', value => isFalse(value) || metadata.hopo_frequency > 0)
	check('multiplier_note', value => chart !== null && parseDotnetInt(value) !== null && (chart.format === 'chart' || [0, 116].includes(parseDotnetInt(value)!)))
	check('frets', () => hasCharter(songSection))
	check('track', () => hasAlbumTrack(songSection))
	// No reader acts on end_events.
	check('end_events', () => true)
	// .chart has no sustain cutoff unless it's set.
	check('sustain_cutoff_threshold', value => chart?.format === 'chart' && isAtMostZero(value))
	check('chord_snap_threshold', isAtMostZero)
	check('modchart', isFalse)
	check('explicit_lyrics', isFalse)
	check('video_start_time', isZero)
	// YARG reads a .mid chart's drums as pro unless pro_drums is false, and five_lane_drums = False as 4-lane drums.
	check('pro_drums', value => isFalse(value) && chart !== null && (chart.format === 'chart' || chart.drumType === null))
	check('five_lane_drums', value => isFalse(value) && chart !== null
		&& (chart.drumType === null || (parseBoolean(songSection.pro_drums) !== true && chart.drumType !== drumTypes.fiveLane)))
	return Object.keys(songSection).filter(key => keys.includes(key))
}

/**
 * The tags only older charts need, which the charting guidelines forbid, when they change how the chart reads. The
 * chart is changed to read the same without one before it's removed.
 */
function deprecatedTagIssues(songSection: SongSection, metadata: typeof defaultMetadata, chart: SongIniInput['chart']): MetadataFinding[] {
	const issues: MetadataFinding[] = []
	const add = (description: string) => issues.push({ metadataIssue: 'deprecatedIniTag', description })
	const { delay } = metadata
	if (isSet(songSection.delay) && delay !== 0) {
		const fix = delay > 0
			? `start the audio ${delay} ms earlier, by removing its first ${delay} ms, or move every note ${delay} ms later`
			: `add ${-delay} ms of silence to the start of the audio, or move every note ${-delay} ms earlier`
		add(`"song.ini" sets "delay" to ${delay} ms, which only older charts need. Change the chart first so it plays the same without it: ${fix}. Then remove the tag.`)
	}
	const changesHopos = (key: string) =>
		`"song.ini" sets "${key}", which changes which notes are HOPOs. Change the chart first so it plays the same without it, by forcing the notes that change. Then remove the tag.`
	// Clone Hero and YARG read hopo_frequency over eighthnote_hopo.
	const hopoFrequency = metadata.hopo_frequency > 0
	if (isSet(songSection.hopo_frequency) && hopoFrequency) add(changesHopos('hopo_frequency'))
	if (isSet(songSection.eighthnote_hopo) && metadata.eighthnote_hopo && !hopoFrequency) add(changesHopos('eighthnote_hopo'))
	if (chart?.format === 'mid' && metadata.multiplier_note === 103) {
		add('"song.ini" sets "multiplier_note" to 103, which makes MIDI note 103 the star power note. Move the star power phrases to note 116 first. Then remove the tag.')
	}
	if (isSet(songSection.frets) && !hasCharter(songSection)) {
		add('"song.ini" names the charter with "frets", a tag for older charts. Write "charter" instead.')
	}
	if (isSet(songSection.track) && !hasAlbumTrack(songSection)) {
		add('"song.ini" gives the album track with "track", a tag for older charts. Write "album_track" instead.')
	}
	return issues
}

/** A line before `[song]`, a section other than `[song]`, and comments that don't start with ";": the first of each kind. */
function layoutIssues(tokens: IniTokens): MetadataFinding[] {
	if (tokens.text === null) return []
	// As parseIniTokens reads lines: without one leading byte order mark, and trimmed.
	const lines = tokens.text.replace(/^\uFEFF/, '').split(/\r?\n/g).map(trimDotnet)
	const found = new Map<string, string>()
	const report = (kind: string, description: string) => {
		if (!found.has(kind)) found.set(kind, description)
	}
	let seenSong = false
	lines.forEach((line, index) => {
		const at = `Line ${index + 1} of "song.ini"`
		if (line.startsWith('#')) report('#', `${at} is a comment that starts with "#". Start comments with ";".`)
		else if (line.startsWith('//')) report('//', `${at} is a comment that starts with "//", which some readers read as a tag. Start comments with ";".`)
		else if (line.startsWith('[') && line.endsWith(']')) {
			if (toLowerInvariant(line.slice(1, -1)) === 'song') seenSong = true
			else report(`[${line}`, `"song.ini" has a "${line}" section. Games read only "[song]": move its tags there, or remove it.`)
		} else if (line.length > 0 && !line.startsWith(';') && !seenSong) {
			report('before', `${at} comes before "[song]". Start the file with "[song]".`)
		}
	})
	return [...found.values()].map(description => ({ metadataIssue: 'iniLayout', description }))
}

/** Keys for a message: up to four, quoted, then how many more. */
export function keyList(keys: readonly string[]) {
	const named = keys.slice(0, keys.length > 4 ? 3 : 4).map(key => `"${key}"`)
	const rest = keys.length - named.length
	if (rest > 0) return `${named.join(', ')} and ${rest} more`
	return named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`
}
