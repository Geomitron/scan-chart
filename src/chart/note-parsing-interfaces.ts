import type { MidiEvent } from '@geomitron/midi-file'
import { defaultMetadata } from 'src/ini'
import { Difficulty, Instrument, NotesData } from 'src/interfaces'
import { ObjectValues } from 'src/utils'

export interface IniChartModifiers {
	song_length: number
	hopo_frequency: number
	eighthnote_hopo: boolean
	multiplier_note: number
	sustain_cutoff_threshold: number
	chord_snap_threshold: number
	five_lane_drums: boolean
	pro_drums: boolean
}

/**
 * Projection of the 8 `song.ini` fields that influence chart parsing, with
 * defaults derived from {@link defaultMetadata}. Exported so consumers who
 * call `parseChartFile` directly can construct a `Partial<IniChartModifiers>`
 * on top of known defaults without having to duplicate the values here.
 *
 * Kept as a projection (rather than a standalone literal) so these 8 defaults
 * can never drift from the 40-field source of truth in {@link defaultMetadata}.
 */
export const defaultIniChartModifiers: IniChartModifiers = {
	song_length: defaultMetadata.song_length,
	hopo_frequency: defaultMetadata.hopo_frequency,
	eighthnote_hopo: defaultMetadata.eighthnote_hopo,
	multiplier_note: defaultMetadata.multiplier_note,
	sustain_cutoff_threshold: defaultMetadata.sustain_cutoff_threshold,
	chord_snap_threshold: defaultMetadata.chord_snap_threshold,
	five_lane_drums: defaultMetadata.five_lane_drums,
	pro_drums: defaultMetadata.pro_drums,
}

/**
 * This is the common format that both .mid and .chart parsers target, and is used by `parseChart()` to generate `ChartData`.
 *
 * The intention is that the .mid and .chart parsers do as little processing of the data as possible so that the shared
 * functionality can all happen in `parseChart()`. This means that "invalid" event configurations can exist in this data, such as:
 * - modifiers and phrases that contain zero notes
 * - multiple events of the same type on the same tick
 * - overlapping events of the same type
 * - drum tracks containing both 5-lane green and tom/cymbal modifiers
 */
export interface RawChartData {
	chartTicksPerBeat: number
	/**
	 * Song metadata. Parsers populate only what the source file carries
	 * (the [Song] section for .chart; nothing for .mid). `parseChartAndIni`
	 * overlays `song.ini` values on top of this, with ini winning where both
	 * are present, and populates `extraIniFields` from unknown ini keys.
	 */
	metadata: Partial<typeof defaultMetadata> & {
		/** Unknown song.ini key/value pairs, preserved for round-trip writing. */
		extraIniFields?: { [key: string]: string }
		/**
		 * Unknown `[Song]`-section key/value pairs from a `.chart` file,
		 * preserved verbatim for round-trip writing. Counterpart to
		 * `extraIniFields` for the chart file's metadata block. Covers
		 * deprecated/legacy fields that games don't read but chart editors
		 * like Moonscraper expect to see round-tripped — `Player2`, `HoPo`,
		 * `PreviewEnd`, `MediaType`, `ArtistText`, audio-stream filenames
		 * (`MusicStream`, `GuitarStream`, …), etc. Consumers should not
		 * treat these as authoritative (e.g. audio filenames here should be
		 * ignored in favor of folder scans), and writers should not
		 * synthesize or update these values — only persist what the source
		 * carried. `.mid` files do not populate this field.
		 */
		extraChartSongFields?: { [key: string]: string }
		/**
		 * `[Song].Offset` from the .chart file body, in milliseconds. Distinct
		 * from the ini-origin `delay` field — games recognize `Offset` only in
		 * [Song], and `delay` only in song.ini. Kept as a separate key so the
		 * two never collide on the ini-wins merge in `parseChartAndIni`.
		 */
		chart_offset?: number
	}
	/**
	 * Vocal track data keyed by part name.
	 * 'vocals' = PART VOCALS / .chart [Events]
	 * 'harmony1' = HARM1 / PART HARM1
	 * 'harmony2' = HARM2 / PART HARM2
	 * 'harmony3' = HARM3 / PART HARM3
	 */
	vocalTracks: {
		[part: string]: VocalTrackData
	}
	tempos: {
		tick: number
		/** double, rounded to 12 decimal places */
		beatsPerMinute: number
	}[]
	timeSignatures: {
		tick: number
		numerator: number
		denominator: number
	}[]
	/**
	 * `[SyncTrack]` lines from a `.chart` file that are neither tempo (`B`)
	 * nor time signature (`TS`). Preserved verbatim for round-trip so tempo
	 * anchors (`A <microseconds>`) and any future SyncTrack event types
	 * survive parse → write. `text` is the line content after `TICK = ` —
	 * e.g. `"A 0"` for an anchor at time-position 0. Anchors are editor-time
	 * audio-sync metadata and are not competitively relevant, but Moonscraper
	 * and other editors make use of them. `.mid` files do not populate this
	 * field.
	 */
	unrecognizedSyncTrackEvents: {
		tick: number
		text: string
	}[]
	sections: {
		tick: number
		name: string
	}[]
	endEvents: {
		tick: number
	}[]
	/**
	 * Text-like events on the EVENTS track that weren't recognized and routed
	 * to a typed field (sections, endEvents, vocalTracks). These include crowd
	 * events, music_start/end, drums mix events, coda markers, and any
	 * custom/unknown text events. Populated from both `.mid` (FF 01 / FF 05 /
	 * FF 06 / FF 07) and `.chart` (`E "text"` in `[Events]`).
	 */
	unrecognizedEventsTrackTextEvents: {
		tick: number
		text: string
	}[]
	/**
	 * Non-text-like MIDI events on the EVENTS track — most notably Rock Band
	 * practice-mode assist sample notes (note numbers 24/25/26), documented in
	 * `Implementation-Specific/Rock-Band/MIDI-Tracks/Global-Events.md`. Also
	 * catches stray channel/sysex/meta events an authoring tool left on the
	 * EVENTS track. Stored verbatim (`deltaTime` is absolute ticks) so writers
	 * can re-emit them. Structural events (`trackName`, `endOfTrack`) are
	 * excluded — writers emit those independently.
	 *
	 * `.chart` always returns `[]` here.
	 */
	unrecognizedEventsTrackMidiEvents: MidiEvent[]
	/**
	 * Issues detected at parse time (before `findChartIssues` runs). `chart-scanner`
	 * concatenates these into the final `chartIssues` array, attaching the standard
	 * description from `chartIssueDescriptions`. Use this for issues that the parser
	 * is uniquely positioned to detect (e.g. duplicate tracks that get normalized
	 * away, malformed events that get dropped).
	 */
	parseIssues: Omit<NotesData['chartIssues'][number], 'description'>[]
	/**
	 * Whole MIDI tracks whose `trackName` isn't recognized as a parseable
	 * instrument/vocal/EVENTS track. Stored verbatim as raw `MidiEvent[]` (delta
	 * times in absolute ticks, matching the rest of the parser). Round-trip
	 * writers re-emit these as-is so unrecognized tracks (VENUE, BEAT, PART
	 * REAL_GUITAR, PART REAL_DRUMS_PS, custom tracks, etc.) survive a
	 * parse → write → parse loop.
	 *
	 * `.chart` always returns `[]` here — see `unrecognizedChartSections` for
	 * the `.chart` equivalent.
	 */
	unrecognizedMidiTracks: { trackName: string; events: MidiEvent[] }[]
	/**
	 * `.chart` sections whose name is not Song/SyncTrack/Events and isn't
	 * resolvable as an instrument+difficulty track. Stored verbatim as the
	 * lines that appeared inside the `[Section] { ... }` block, so writers
	 * can re-emit them for round-trip.
	 *
	 * MIDI always returns `[]` here.
	 */
	unrecognizedChartSections: { name: string; lines: string[] }[]
	trackData: {
		instrument: Instrument
		difficulty: Difficulty
		starPowerSections: {
			tick: number
			/** Number of ticks */
			length: number
		}[]
		/** related to multiplier_note */
		rejectedStarPowerSections: {
			tick: number
			/** Number of ticks */
			length: number
		}[]
		soloSections: {
			tick: number
			/** Number of ticks */
			length: number
		}[]
		flexLanes: {
			tick: number
			/** Number of ticks */
			length: number
			isDouble: boolean
		}[]
		drumFreestyleSections: {
			tick: number
			/** Number of ticks */
			length: number
			/** If the freestyle section is a big rock ending instead of an activation lane */
			isCoda: boolean
		}[]
		/** Only contains notes and note modifiers. */
		trackEvents: {
			tick: number
			/**
			 * Number of ticks. For modifiers, this should be zero. In .mid, modifiers do have length,
			 * but the .mid parser normalizes this by inserting a zero-length modifier for every
			 * note that it applies to. (chords count as one note in this context)
			 */
			length: number
			type: EventType
		}[]
		/** Per-track text events (FF 01 text on MIDI instrument tracks, E events in .chart).
		 * Does not include events already consumed by other fields (disco flip, ENHANCED_OPENS, etc.). */
		textEvents: {
			tick: number
			text: string
		}[]
		/** Player 1/2 versus phrase markers (MIDI notes 105/106, S 0/1 in .chart). */
		versusPhrases: {
			tick: number
			/** Number of ticks */
			length: number
			/** true = player 2 (note 106 / S 1), false = player 1 (note 105 / S 0) */
			isPlayer2: boolean
		}[]
		/**
		 * Note-based animation events (guitar left hand positions: MIDI 40-59,
		 * drum pad animations: MIDI 24-51). Not present in .chart format.
		 */
		animations: {
			tick: number
			/** Number of ticks */
			length: number
			/** The MIDI note number identifying the animation */
			noteNumber: number
		}[]
		/**
		 * MIDI events on this track that the typed parser didn't consume —
		 * stray noteOn/noteOff outside the recognized note ranges, text/sysex/
		 * meta events not routed to a typed field. Stored verbatim (deltaTime
		 * is in absolute ticks) so writers can re-emit them for round-trip.
		 *
		 * `.chart` always returns `[]` here.
		 */
		unrecognizedMidiEvents: MidiEvent[]
	}[]
}

export interface VocalTrackData {
	lyrics: {
		tick: number
		length: number
		text: string
	}[]
	vocalPhrases: {
		tick: number
		length: number
	}[]
	notes: import('./lyric-parser').VocalNote[]
	starPowerSections: {
		tick: number
		length: number
	}[]
	rangeShifts: {
		tick: number
		length: number
	}[]
	lyricShifts: {
		tick: number
		length: number
	}[]
	/** HARM2/3 static lyric phrase boundaries (from note 106 — distinct from
	 * scoring phrases which are note 105). On HARM1 this is typically empty. */
	staticLyricPhrases: {
		tick: number
		length: number
	}[]
	/**
	 * Raw text events on the vocal track (stance markers, Band_PlayFacialAnim, etc.).
	 * YARG.Core parses these into the VocalsPart.TextEvents list, which is what
	 * makes an otherwise-empty vocal track "non-empty" (and therefore visible to
	 * ChartDump / UI). Storing them here lets the writer round-trip vocals-only
	 * tracks that have no lyrics/notes/phrases but still have stance markers.
	 * Does NOT include lyric events (which live in `lyrics`) or events scan-chart
	 * consumes internally (`ENHANCED_OPENS`, `[mix N drumsM]`, `[range_shift ...]`).
	 */
	textEvents: {
		tick: number
		text: string
	}[]
	/**
	 * MIDI events on this vocal track the scanner didn't consume — stray
	 * noteOn/noteOff outside recognized vocal note ranges (not 0/1/105/106/116
	 * and not 36–84/96/97), plus sysEx / meta / channel events. Stored verbatim
	 * (deltaTime is absolute ticks) so writers can re-emit them for round-trip.
	 *
	 * `.chart` always returns `[]` here.
	 */
	unrecognizedMidiEvents: MidiEvent[]
}

export type EventType = ObjectValues<typeof eventTypes>
export const eventTypes = {
	starPower: 0,
	soloSection: 1, // .mid
	rejectedStarPower: 2, // .mid, related to multiplier_note
	soloSectionStart: 3, // .chart
	soloSectionEnd: 4, // .chart

	// 5 fret
	open: 5,
	green: 6,
	red: 7,
	yellow: 8,
	blue: 9,
	orange: 10,

	// 6 fret
	black1: 11,
	black2: 12,
	black3: 13,
	white1: 14,
	white2: 15,
	white3: 16,

	// Drums
	kick: 17,
	kick2x: 18,
	redDrum: 19,
	yellowDrum: 20,
	blueDrum: 21,
	fiveOrangeFourGreenDrum: 22,
	fiveGreenDrum: 23,
	flexLaneSingle: 24,
	flexLaneDouble: 25,
	freestyleSection: 26,

	// Modifiers
	forceOpen: 27, // .mid
	forceTap: 28,
	forceStrum: 29, // .mid
	forceHopo: 30, // .mid
	forceUnnatural: 31, // .chart
	forceFlam: 32,
	yellowTomMarker: 33, // .mid
	blueTomMarker: 34, // .mid
	greenTomMarker: 35, // .mid
	yellowCymbalMarker: 36, // .chart
	blueCymbalMarker: 37, // .chart
	greenCymbalMarker: 38, // .chart
	redGhost: 39,
	yellowGhost: 40,
	blueGhost: 41,
	fiveOrangeFourGreenGhost: 42,
	fiveGreenGhost: 43,
	kickGhost: 44,
	redAccent: 45,
	yellowAccent: 46,
	blueAccent: 47,
	fiveOrangeFourGreenAccent: 48,
	fiveGreenAccent: 49,
	kickAccent: 50,
	discoFlipOff: 51,
	discoFlipOn: 52,
	discoNoFlipOn: 53,

	// Toggle
	enableChartDynamics: 54,
} as const

/** A single event in a chart's track. Note that more than one event can occur at the same time. */
export interface NoteEvent {
	/** The chart tick of this event. */
	tick: number
	msTime: number
	/** Length of the event in ticks. Some events have a length of zero. */
	length: number
	msLength: number
	type: NoteType
	/** bitmask of `NoteFlag`. */
	flags: number
}

/** Note: specific values here are standardized; they are constants used in the track hash calculation. */
export type NoteType = ObjectValues<typeof noteTypes>
export const noteTypes = {
	// 5 fret
	open: 1,
	green: 2,
	red: 3,
	yellow: 4,
	blue: 5,
	orange: 6,

	// 6 fret
	black1: 7,
	black2: 8,
	black3: 9,
	white1: 10,
	white2: 11,
	white3: 12,

	// Drums
	kick: 13,
	redDrum: 14,
	yellowDrum: 15,
	blueDrum: 16,
	greenDrum: 17,
} as const

/** Upper bound on noteType integer values — used for dense array-indexed lookups.
 * Keep in sync with the maximum value in `noteTypes` above. */
export const noteTypeCount = Math.max(...Object.values(noteTypes)) + 1

/** Note: specific values here are standardized; they are constants used in the track hash calculation. */
export const noteFlags = {
	none: 0,
	strum: 1,
	hopo: 2,
	tap: 4,
	doubleKick: 8,
	tom: 16,
	cymbal: 32,
	discoNoflip: 64,
	disco: 128,
	flam: 256,
	ghost: 512,
	accent: 1024,
} as const

// ---------------------------------------------------------------------------
// Normalized vocal types (produced by notes-parser from raw VocalTrackData)
// ---------------------------------------------------------------------------

/** Bitmask flags for lyric symbols, matching YARG's LyricSymbolFlags. */
export const lyricFlags = {
	none:              0,
	joinWithNext:      1,    // '-' suffix
	nonPitched:        2,    // '#', '^', '*' suffix
	lenientScoring:    4,    // '^' suffix (combined with nonPitched)
	pitchSlide:       16,    // '+' suffix
	harmonyHidden:    32,    // '$' prefix
	staticShift:      64,    // '/' suffix
	rangeShift:      128,    // '%' suffix
	hyphenateWithNext: 256,  // '=' suffix
} as const

export interface NormalizedLyricEvent {
	tick: number
	msTime: number
	/** Original text from the source file, including markup symbols (#, ^, +, =, $, etc.).
	 * Consumers should use `flags` for semantic interpretation, not parse `text` directly. */
	text: string
	/** Bitmask of `lyricFlags`, derived from markup symbols in text. */
	flags: number
}

export interface NormalizedVocalNote {
	tick: number
	msTime: number
	length: number
	msLength: number
	/** MIDI pitch 36-84 for pitched, -1 for percussion. NonPitched notes
	 * (lyric flags #/^/*) keep their original MIDI pitch — check the
	 * associated lyric's nonPitched flag for semantic meaning. */
	pitch: number
	/** percussionHidden (note 97) is excluded from normalized output. */
	type: 'pitched' | 'percussion'
}

export interface NormalizedVocalPhrase {
	tick: number
	msTime: number
	length: number
	msLength: number
	/** True if first note is percussion (YARG behavior — mixing types in one phrase is invalid data). */
	isPercussion: boolean
	/** Versus player (PART VOCALS only). 1 = player 1 (note 105), 2 = player 2 (note 106). */
	player?: 1 | 2
	notes: NormalizedVocalNote[]
	lyrics: NormalizedLyricEvent[]
}

export interface NormalizedVocalPart {
	/** Phrases with notes and lyrics grouped. Built from the union of note 105
	 * and note 106 phrase boundaries. Notes outside all phrases are dropped. */
	notePhrases: NormalizedVocalPhrase[]
	/** Static lyric display phrases (from note 106 on HARM2/3, copy of
	 * notePhrases on vocals/HARM1). */
	staticLyricPhrases: NormalizedVocalPhrase[]
	/** Star power sections — separate array, not per-phrase. */
	starPowerSections: { tick: number; msTime: number; length: number; msLength: number }[]
	/**
	 * Per-part range shift markers (MIDI note 0 on this part's track).
	 * YARG computes rangeShifts from these markers. PART VOCALS and HARM1 often
	 * have distinct marker sets — must be stored per-part for lossless round-trip.
	 */
	rangeShifts: { tick: number; msTime: number; length: number; msLength: number }[]
	/** Per-part lyric shift markers (MIDI note 1 on this part's track). */
	lyricShifts: { tick: number; msTime: number; length: number; msLength: number }[]
	/**
	 * Raw text events on the vocal track (stance, facial anim, etc.). Required
	 * so that vocal tracks with only text events (no notes/lyrics/phrases)
	 * round-trip — YARG considers a VocalsPart non-empty iff it has phrases or
	 * text events, so dropping them causes ChartDump to hide the track.
	 */
	textEvents: { tick: number; msTime: number; text: string }[]
}

/** Top-level normalized vocal track. */
export interface NormalizedVocalTrack {
	parts: { [partName: string]: NormalizedVocalPart }
	/** Range shifts at track level (shared across parts). Length 0 = from '%' symbol, >0 = from MIDI note 0. */
	rangeShifts: { tick: number; msTime: number; length: number; msLength: number }[]
	/** Lyric shifts at track level. YARG drops these but we keep them for writing. */
	lyricShifts: { tick: number; msTime: number; length: number; msLength: number }[]
}
