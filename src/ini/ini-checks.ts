import { isNameListed, toLowerInvariant, trimDotnet } from '../shared/text'
import { undelayedSyncAdvice } from '../shared/time'
import { type IssueCode, issueSeverities, type MetadataFinding } from '../issues'
import { type DrumType, drumTypes, type MetadataIssueType } from '../types'
import { defaultMetadata, isNumberTag, olderTags, tagOrder, tagRank } from './metadata'
import { marksSingle } from './metadata-style'
import type { IniTokens } from './parse-ini'
import { knownIniKeys, parseBoolean, parseDotnetInt } from './scan-ini'

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
	/**
	 * The chart's format and drum type, or `null` when it didn't parse. `detectedDrumType` reads it without song.ini's drum
	 * flags; `solosReadAsStarPower` says whether a guitar or keys track reads its solos as star power without `multiplier_note`.
	 */
	readonly chart: {
		readonly format: 'chart' | 'mid'
		readonly drumType: DrumType | null
		readonly detectedDrumType: () => DrumType | null
		readonly solosReadAsStarPower: () => boolean
	} | null
	/** Tags a caller's game reads. */
	readonly extraIniKeys: readonly (string | RegExp)[]
	/** Whether to report what every reader reads alike: tags out of order, -1 numbers and blank text values, and lines that change nothing. */
	readonly styleNotes: boolean
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
/** The tags Clone Hero (SongEntry) or YARG (SongIniHandler) reads that the standard and scan-chart don't. */
const gameTags = [
	'diff_coop', 'diff_coopghl', 'diff_rhythmghl', 'explicit_lyrics', 'md5_hash',
	'banner_link_a', 'banner_link_b', 'bass_type', 'boss_battle', 'cassettecolor', 'charter_audio', 'charter_bass', 'charter_bass_6f', 'charter_drums',
	'charter_elite_drums', 'charter_guitar', 'charter_guitar_6f', 'charter_keys', 'charter_lower_diff', 'charter_pro_bass', 'charter_pro_guitar',
	'charter_pro_keys', 'charter_rhythm', 'charter_rhythm_6f', 'charter_venue', 'charter_vocals', 'clean_vocals', 'count', 'covered_by',
	'credit_album_art_by', 'credit_album_art_designed_by', 'credit_album_cover', 'credit_arranged_by', 'credit_background', 'credit_composed_by',
	'credit_courtesy_of', 'credit_engineered_by', 'credit_license', 'credit_mastered_by', 'credit_mixed_by', 'credit_other', 'credit_performed_by',
	'credit_produced_by', 'credit_published_by', 'credit_written_by', 'dance_type', 'date_released', 'diff_elite_drums', 'drum_fallback_blue',
	'early_hit_window_size', 'eof_midi_import_drum_accent_velocity', 'eof_midi_import_drum_ghost_velocity', 'guitar_type', 'hopofreq', 'keys_type',
	'kit_type', 'link_bandcamp', 'link_bluesky', 'link_facebook', 'link_instagram', 'link_name_a', 'link_name_b', 'link_other', 'link_spotify',
	'link_twitter', 'link_youtube', 'location', 'preview', 'pro_drum', 'real_keys_lane_count_left', 'real_keys_lane_count_right', 'scores',
	'scores_ext', 'sub_genre', 'sysex_high_hat_ctrl', 'sysex_open_bass', 'sysex_pro_slide', 'sysex_rimshot', 'sysex_slider', 'tags', 'tutorial',
	'unlock_completed', 'unlock_id', 'unlock_require', 'unlock_text', 'venue_hint', 'vocal_character_hint',
]
/** scan-chart's own tag: the issue codes a chart means to have. */
const ignoredIssuesTag = 'ignored_issues'
/** The tags some game reads, or the standard or scan-chart documents. */
const knownTags = new Set([...standardTags, ...knownIniKeys, ...gameTags, ignoredIssuesTag])

/**
 * The charting recommendations about song.ini: how it's written (its layout, its tags' order, blank and quoted values,
 * and tags no game reads), then its values. What every reader reads alike is reported only with `styleNotes`.
 */
export function songIniIssues(input: SongIniInput): MetadataFinding[] {
	const { tokens, songSection, extraIniKeys, styleNotes } = input
	// A line starting with "//" is reported as a comment, though readers read one with "=" in it as a key.
	const keys = Object.keys(songSection).filter(key => !key.startsWith('//'))
	const known = keys.filter(key => knownTags.has(key) || isNameListed(extraIniKeys, key))
	const unknown = keys.filter(key => !known.includes(key))
	const issues = layoutIssues(tokens)

	const ranked = known.filter(key => tagOrder.includes(key))
	for (let index = 1; index < ranked.length && styleNotes; index++) {
		const later = ranked.slice(0, index).find(key => tagOrder.indexOf(key) > tagOrder.indexOf(ranked[index]))
		if (later !== undefined) {
			issues.push({ metadataIssue: 'iniTagOrder', description: `In "song.ini", "${ranked[index]}" should come before "${later}".` })
			break
		}
	}

	const values = valueIssues(input)
	const blank: string[] = keys.filter(key => key !== ignoredIssuesTag && isBlank(key, songSection[key]) && !input.requiredKeys.includes(key) && !values.missing.includes(key))
	// Clone Hero reads a blank number as not set, and YARG as 0; a scanner reads a number's -1 or blank text as not set.
	const blankNumbers = blank.filter(key => songSection[key] === '' && isNumberTag(key))
	const blankStyle = blank.filter(key => !blankNumbers.includes(key))
	if (blankNumbers.length > 0) {
		const one = blankNumbers.length === 1
		issues.push({
			metadataIssue: 'blankIniNumber',
			keys: blankNumbers,
			description: `In "song.ini", ${keyList(blankNumbers)} ${one ? 'is' : 'are'} blank. Clone Hero reads ${one ? 'it' : 'them'} as not set, and YARG as 0: `
				+ `remove ${one ? 'that line' : 'those lines'}, or give ${one ? 'it a value' : 'them values'}.`,
		})
	}
	if (blankStyle.length > 0 && styleNotes) {
		issues.push({ metadataIssue: 'blankIniValue', keys: blankStyle, description: `In "song.ini", ${keyList(blankStyle)} ${blankStyle.length === 1 ? 'is' : 'are'} blank or -1. Remove ${blankStyle.length === 1 ? 'that line' : 'those lines'} instead.` })
	}
	const quoted = keys.filter(key => songSection[key].length >= 2 && songSection[key].startsWith('"') && songSection[key].endsWith('"'))
	if (quoted.length > 0) {
		issues.push({
			metadataIssue: 'quotedIniValue',
			keys: quoted,
			description: `In "song.ini", ${keyList(quoted)} ${quoted.length === 1 ? 'is' : 'are'} in quotes. Games show the quotes, and don't read a number in quotes, so remove them.`,
		})
	}
	if (unknown.length > 0) {
		const [tags, them] = unknown.length === 1 ? ['a tag', 'it'] : ['tags', 'them']
		issues.push({
			metadataIssue: 'unknownIniTag',
			description: `"song.ini" has ${tags} no game reads: ${keyList(unknown)}. Remove ${them}, unless your game reads ${them}.`,
		})
	}
	return [...issues, ...values.issues]
}

/**
 * song.ini tags in the order scan-chart writes them: the standard's in `defaultMetadata`'s order, then the other tags
 * some game reads, then the rest, each in the order given.
 */
export function standardTagOrder(keys: readonly string[]): string[] {
	const ranked = keys.filter(key => tagOrder.includes(key)).sort((a, b) => tagRank(a) - tagRank(b))
	const unranked = keys.filter(key => !tagOrder.includes(key))
	return [...ranked, ...unranked.filter(key => knownTags.has(key)), ...unranked.filter(key => !knownTags.has(key))]
}

/** Whether a tag's value reads as not set: blank, or -1 for a number tag. Text -1 is text, and a boolean -1 is true. */
const isBlank = (key: string, value: string | undefined) => value === '' || (value === '-1' && isNumberTag(key))
/** Whether a tag is written: present, and not blank or a number's -1. */
const hasValue = (songSection: SongSection, key: string) => songSection[key] !== undefined && !isBlank(key, songSection[key])

/**
 * The charting recommendations about song.ini's values, and the keys reported missing: song_length and album_track
 * unset, a difficulty outside 0 to 10, an icon that isn't an icon's name, a tag for older charts that changes how the
 * chart reads, and a drum type flag the chart doesn't need.
 */
function valueIssues({ songSection, metadata, chart, styleNotes }: SongIniInput): { issues: MetadataFinding[]; missing: string[] } {
	const issues: MetadataFinding[] = []
	const missing: string[] = []
	const add = (metadataIssue: MetadataIssueType, description: string, keys?: readonly string[]) => issues.push({ metadataIssue, description, keys })

	if (!(metadata.song_length > 0)) {
		missing.push('song_length')
		add('missingSongLength', 'Metadata is missing "song_length": set it to the length of the longest audio file, in milliseconds.')
	}
	if (metadata.album_track === defaultMetadata.album_track && metadata.album !== defaultMetadata.album && !marksSingle(metadata.album)) {
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
	if (hasValue(songSection, 'icon') && !/^[a-z0-9_-]+$/.test(icon)) {
		add('iconName', `In "song.ini", "icon" is "${icon}". Write the icon's file name without its extension, in lowercase letters, numbers, "-" and "_".`, ['icon'])
	}

	issues.push(...deprecatedTagIssues(songSection, metadata, chart))
	const unneededTags = unneededKeys(songSection, metadata, chart)
	const unneeded = unneededTags.map(key => `${key} = ${songSection[key]}`)
	if (unneeded.length > 0 && styleNotes) {
		const one = unneeded.length === 1
		add('defaultIniValue', `In "song.ini", ${keyList(unneeded)} ${one ? 'changes' : 'change'} nothing: games read the song the same without ${one ? 'it' : 'them'}. `
			+ `Remove ${one ? 'that line' : 'those lines'}.`, unneededTags)
	}

	// Both flags together are already invalid.
	const proDrums = parseBoolean(songSection.pro_drums) === true
	const fiveLaneDrums = parseBoolean(songSection.five_lane_drums) === true
	if (chart !== null && proDrums !== fiveLaneDrums) {
		const [key, type, name] = proDrums ? ['pro_drums', drumTypes.fourLanePro, '4-lane pro'] as const : ['five_lane_drums', drumTypes.fiveLane, '5-lane'] as const
		if (chart.drumType === null) {
			add('redundantDrumType', `"song.ini" sets "${key}", but the chart has no drums track. Remove the tag.`, [key])
		} else if (chart.detectedDrumType() === type) {
			add('redundantDrumType', `"song.ini" sets "${key}", but games already read this drums chart as ${name}. Remove the tag.`, [key])
		}
	}
	return { issues, missing }
}

/**
 * The keys that change nothing: set to what Clone Hero and YARG both read without them, for the chart's format, or tags
 * for older charts that another tag or setting overrides. A value only one game reads the same without, such as
 * `pro_drums = False` in a `.mid` chart, which YARG reads as 4-lane drums, isn't one.
 */
function unneededKeys(songSection: SongSection, metadata: typeof defaultMetadata, chart: SongIniInput['chart']): string[] {
	const keys: string[] = []
	const check = (key: string, unneeded: (value: string) => boolean) => {
		const value = songSection[key]
		if (hasValue(songSection, key) && unneeded(value)) keys.push(key)
	}
	const isFalse = (value: string) => parseBoolean(value) === false
	// As getIniInteger reads it.
	const isZero = (value: string) => parseFloat(value) === 0
	const isAtMostZero = (value: string) => (parseDotnetInt(value) ?? 1) <= 0
	check('delay', isZero)
	check('hopo_frequency', isAtMostZero)
	// hopo_frequency, when it's set, comes first.
	check('eighthnote_hopo', value => isFalse(value) || metadata.hopo_frequency > 0)
	// Without 116, Clone Hero reads a .mid guitar or keys track's two or more solos, and no star power, as star power.
	check('multiplier_note', value => chart !== null && (chart.format === 'chart' || parseDotnetInt(value) === 0 || (parseDotnetInt(value) === 116 && !chart.solosReadAsStarPower())))
	// Games read a tag over its older name, such as charter over frets, whenever it's in the file.
	for (const [tag, older] of olderTags) check(older, () => songSection[tag] !== undefined)
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
	const add = (key: string, description: string) => issues.push({ metadataIssue: 'deprecatedIniTag', description, keys: [key] })
	const { delay } = metadata
	if (hasValue(songSection, 'delay') && delay !== 0) {
		add('delay', `"song.ini" sets "delay" to ${delay} ms, which only older charts need. Change the chart first so it plays the same without it: ${undelayedSyncAdvice(delay)}. Then remove the tag.`)
	}
	const changesHopos = (key: string) =>
		`"song.ini" sets "${key}", which changes which notes are HOPOs. Change the chart first so it plays the same without it, by forcing the notes that change. Then remove the tag.`
	// Clone Hero and YARG read hopo_frequency over eighthnote_hopo.
	const hopoFrequency = metadata.hopo_frequency > 0
	if (hasValue(songSection, 'hopo_frequency') && hopoFrequency) add('hopo_frequency', changesHopos('hopo_frequency'))
	if (hasValue(songSection, 'eighthnote_hopo') && metadata.eighthnote_hopo && !hopoFrequency) add('eighthnote_hopo', changesHopos('eighthnote_hopo'))
	if (chart?.format === 'mid' && metadata.multiplier_note === 103) {
		add('multiplier_note', '"song.ini" sets "multiplier_note" to 103, which makes MIDI note 103 the star power note. Move the star power phrases to note 116 first. Then remove the tag.')
	}
	for (const [tag, older] of olderTags) {
		if (hasValue(songSection, older) && songSection[tag] === undefined) {
			add(older, `"song.ini" sets "${tag}" with "${older}", its name in older charts. Write "${tag}" instead.`)
		}
	}
	return issues
}

/**
 * The issue codes song.ini's `ignored_issues` lists, separated by commas: the ones a chart can ignore, a warning's or a
 * recommendation's, and an issue for each other code listed, which isn't an issue code or is an error's.
 */
export function ignoredIssueCodes(songSection: SongSection): { codes: ReadonlySet<IssueCode>; issues: MetadataFinding[] } {
	const codes = new Set<IssueCode>()
	const issues: MetadataFinding[] = []
	const listed = (songSection[ignoredIssuesTag] ?? '').split(',').map(trimDotnet).filter(code => code !== '')
	for (const code of listed) {
		const severity = Object.prototype.hasOwnProperty.call(issueSeverities, code) ? issueSeverities[code as IssueCode] : null
		if (severity === null || severity === 'error') {
			issues.push({
				metadataIssue: 'invalidValue',
				description: `The "${ignoredIssuesTag}" value in "song.ini" lists "${code}", ${severity === null ? 'which isn\'t an issue code' : 'an error, which can\'t be ignored'}.`,
			})
		} else {
			codes.add(code as IssueCode)
		}
	}
	return { codes, issues }
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
