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

/** The order the charting guidelines list tags in, which scan-chart writes them in. */
export const tagOrder = Object.keys(defaultMetadata)

/** A tag's place in `tagOrder`, or `Infinity` for a tag it doesn't list. */
export function tagRank(key: string): number {
	const rank = tagOrder.indexOf(key)
	return rank === -1 ? Infinity : rank
}

const numberTags = new Set([...tagOrder.filter(key => typeof defaultMetadata[key as MetadataKey] === 'number'), 'track', 'video_end_time'])
const booleanTags = new Set([...tagOrder.filter(key => typeof defaultMetadata[key as MetadataKey] === 'boolean'), 'video_loop'])

/** Whether games read a tag as a number: a number above, any `diff_` tag, `track` or `video_end_time`. */
export function isNumberTag(key: string): boolean {
	return key.startsWith('diff_') || numberTags.has(key)
}

/** Whether games read a tag as true or false, reading -1, like any whole number but 0, as true. */
export function isBooleanTag(key: string): boolean {
	return booleanTags.has(key)
}
