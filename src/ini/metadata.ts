/** Default values for known `song.ini` `[Song]` fields. */
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
	diff_keys_ghl: -1,
	diff_guitarghl: -1,
	diff_guitar_coop_ghl: -1,
	diff_rhythm_ghl: -1,
	diff_bassghl: -1,
	diff_vocals: -1,
	/** Units of ms */ preview_start_time: -1,
	/** Units of ms */ preview_end_time: -1,
	icon: '',
	loading_phrase: '',
	album_track: 16000,
	playlist_track: 16000,
	playlist: '',
	sub_playlist: '',
	modchart: false,
	explicit_lyrics: false,
	// The keys only YARG reads, which Clone Hero ignores.
	/** Units of ms: both preview times, written `<start> <end>`. YARG reads it over `preview_start_time` and `preview_end_time`. */
	preview: null as { readonly start: number; readonly end: number } | null,
	/** Units of ms */ video_end_time: -1,
	video_loop: false,
	background: '',
	video: '',
	cover: '',
	/** 1 Family Friendly, 2 Supervision Recommended, 3 Mature, 4 No Rating, 5 Sensitive Content; 0 isn't set. */
	rating: 0,
	/** `cover` marks a cover. */
	tags: '',
	diff_vocals_harm: -1,
	diff_guitar_real: -1,
	diff_guitar_real_22: -1,
	diff_bass_real: -1,
	diff_bass_real_22: -1,
	diff_keys_real: -1,
	diff_elite_drums: -1,
	sub_genre: '',
	covered_by: '',
	/** `yyyy-MM-dd` or `yyyy-MM`, as written. */
	date_released: '',
	location: '',
	credit_album_art_designed_by: '',
	credit_arranged_by: '',
	credit_background: '',
	credit_composed_by: '',
	credit_courtesy_of: '',
	credit_engineered_by: '',
	credit_license: '',
	credit_mastered_by: '',
	credit_mixed_by: '',
	credit_other: '',
	credit_performed_by: '',
	credit_produced_by: '',
	credit_published_by: '',
	credit_written_by: '',
	charter_guitar: '',
	charter_rhythm: '',
	charter_bass: '',
	charter_drums: '',
	charter_elite_drums: '',
	charter_keys: '',
	charter_pro_guitar: '',
	charter_pro_bass: '',
	charter_pro_keys: '',
	charter_guitar_6f: '',
	charter_rhythm_6f: '',
	charter_bass_6f: '',
	charter_vocals: '',
	charter_lower_diff: '',
	charter_venue: '',
	charter_audio: '',
	link_bandcamp: '',
	link_bluesky: '',
	link_facebook: '',
	link_instagram: '',
	link_spotify: '',
	link_twitter: '',
	link_other: '',
	link_youtube: '',
	/** 0 to 3 or a name: female, male, nonbinary or other. */
	vocal_gender: '',
	/** A percentage, or `null` when it isn't set. */
	vocal_scroll_speed: null as number | null,
	clean_vocals: false,
	venue_hint: '',
	vocal_character_hint: '',
	tuning_offset_cents: 0,
	/** Units of ms */ delay: 0,
	hopo_frequency: 0,
	eighthnote_hopo: false,
	multiplier_note: 0,
	sustain_cutoff_threshold: -1,
	chord_snap_threshold: 0,
	video_start_time: 0,
	five_lane_drums: false,
	pro_drums: false,
	end_events: true,
}

type MetadataKey = keyof typeof defaultMetadata

/**
 * The older name of each tag that has one, which games read only when the file doesn't have the tag, whatever the
 * tag's value: `frets` for `charter`, `track` for `album_track`, `pro_drum` for `pro_drums`, and `star_power_note` for
 * `multiplier_note`.
 */
export const olderTags: ReadonlyMap<string, string> = new Map([
	['charter', 'frets'],
	['album_track', 'track'],
	['pro_drums', 'pro_drum'],
	['multiplier_note', 'star_power_note'],
])

/** The older names Clone Hero 1.1.0.6142 didn't read, so the hashes it calculated, the frozen legacy ones, ignore them. */
export const olderTagsUnreadByLegacy: readonly string[] = ['pro_drum', 'star_power_note']

/** The tag `older` is an older name of, or `undefined`. */
export function newerTag(older: string): string | undefined {
	return [...olderTags].find(([, name]) => name === older)?.[0]
}

/** The order the charting guidelines list tags in, which scan-chart writes them in. */
export const tagOrder = Object.keys(defaultMetadata)

/** A tag's place in `tagOrder`, or `Infinity` for a tag it doesn't list. */
export function tagRank(key: string): number {
	const rank = tagOrder.indexOf(key)
	return rank === -1 ? Infinity : rank
}

/** The tags whose default is of `type`, with their older names. */
const tagsOfType = (type: 'number' | 'boolean') => tagOrder.filter(key => typeof defaultMetadata[key as MetadataKey] === type)
	.flatMap(key => [key, ...olderTags.has(key) ? [olderTags.get(key)!] : []])
const numberTags = new Set([...tagsOfType('number'), 'vocal_scroll_speed'])
const booleanTags = new Set(tagsOfType('boolean'))

/** Whether games read a tag as a number: a number above or its older name, `vocal_scroll_speed`, or any `diff_` tag. */
export function isNumberTag(key: string): boolean {
	return key.startsWith('diff_') || numberTags.has(key)
}

/** Whether games read a tag as true or false, reading -1, like any whole number but 0, as true. */
export function isBooleanTag(key: string): boolean {
	return booleanTags.has(key)
}
