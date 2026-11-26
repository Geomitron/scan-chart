/**
 * The parsing rules that differ between scan-chart's parse profiles. Each profile is one frozen object,
 * and the parser reads its behavior from that object instead of from positional switches.
 *
 * To make a profile diverge, add a rule here and set it on every profile. Do not construct rule objects
 * anywhere else: callers choose a profile through `parseChartFile` or an identity profile.
 */
export interface ParseRules {
	readonly profile: 'scanner' | 'frozenLegacy6142' | 'canonical20260801'
	/**
	 * Which MIDI difficulties become tracks. `difficultiesWithNotesAndExpert` also keeps the Expert track
	 * that Clone Hero 1.1.0.6142 allocates for every recognized instrument track, even when it has no notes.
	 */
	readonly midiTrackAllocation: 'difficultiesWithNotes' | 'difficultiesWithNotesAndExpert'
	/** Which `.chart` difficulty sections become tracks: every recognized section, or only sections with a note. */
	readonly chartTrackAllocation: 'everySection' | 'sectionsWithNotes'
	/**
	 * What happens when several MIDI tracks name the same instrument. `firstWins` reads only the first such
	 * track, as Clone Hero does; `keepAll` parses each of them.
	 */
	readonly midiDuplicateInstrumentTracks: 'keepAll' | 'firstWins'
	/**
	 * Which MIDI drum notes `[ENABLE_CHART_DYNAMICS]` turns into accents and ghosts. `fromEvent` matches Clone
	 * Hero's single pass: every note that comes after the event in the track, on every difficulty.
	 * `leaksAcrossDifficulties` is scan-chart 8's behavior: after the event on the first charted difficulty
	 * (Expert first), and on every note of each later difficulty.
	 */
	readonly midiChartDynamics: 'fromEvent' | 'leaksAcrossDifficulties'
	/**
	 * Whether `[ENABLE_CHART_DYNAMICS]` turns kick velocities into accents and ghosts. Clone Hero 1.1.0.6142 does;
	 * kick dynamics are not supported, so later builds ignore them.
	 */
	readonly midiKickDynamics: 'applied' | 'ignored'
	/**
	 * Whether `N 109` in a `.chart` drum section is a flam marker on the drum notes of its tick. Clone Hero
	 * 1.1.0.6142 ignores it; `.chart` gained flam in 2026, mirroring MIDI's flam note.
	 */
	readonly chartFlam: 'read' | 'ignored'
	/**
	 * Which difficulties a `.mid` drums flam, note 109, applies to. `laneVelocities` is the spec's rule: like a lane, velocity
	 * 21 to 30 every difficulty, 31 to 40 Medium and up, 41 to 50 Hard and up, and any other Expert only. `everyDifficulty`
	 * is Clone Hero 1.1's reading, whatever the velocity.
	 */
	readonly midiFlam: 'laneVelocities' | 'everyDifficulty'
	/**
	 * Whether a `.chart` line or section written in a nonstandard way is read as what it probably means
	 * (chart-line-spelling.ts), with a resolution of 192 when the `[Song]` section gives none. Clone Hero refuses such a
	 * file, or reads it the same way; scan-chart 8 skipped such a line, which the frozen profile keeps doing.
	 */
	readonly chartNonstandardLines: 'read' | 'ignored'
	/**
	 * A pro drums chart's 5-lane green note on the tick of a green note, on one difficulty. Both read the 5-lane green as
	 * a blue tom with its own length and accent or ghost. `blueTom` is the spec's rule: where a blue note is also on the
	 * tick, the 5-lane green is dropped, and the blue note keeps its own type, flags and length. `longerBlue` is Clone
	 * Hero 1.1's reading, where the blue note keeps its own type, accent and ghost with the longer of the two lengths.
	 */
	readonly proDrumsGreenPair: 'blueTom' | 'longerBlue'
	/**
	 * A kick and a double kick on one tick of one difficulty (`.mid` 96 and 95, `.chart` `N 0` and `N 32`). `kick` is the
	 * spec's rule: the note is the kick, with the kick's own length. `longer` is Clone Hero 1.1's reading, which keeps the
	 * longer of the two, or the double kick when their lengths are equal.
	 */
	readonly kickPair: 'kick' | 'longer'
	/**
	 * How a drums `mix` event's text is read, in either format (C20: R2, R10). `cloneHero` reads it as Clone Hero's
	 * `TryParseDiscoMixEvent` does: any spaces or `_` between the parts, a difficulty `int.TryParse` reads, any
	 * configuration character, any text after it that starts with `d` as a flip, and any other text as turning the flip
	 * off. `strict` is scan-chart 8's reading: single separators, a configuration from 0 to 5, and only the flags `d`,
	 * `dnoflip`, `easy` and `easynokick`, the last two setting nothing.
	 */
	readonly mixEvents: 'cloneHero' | 'strict'
	/**
	 * Whether a `.mid` drums track's mix events and `[ENABLE_CHART_DYNAMICS]` written as lyric events (`FF 05`) are `read`
	 * as they are in text events (`FF 01`), as YARG and Rock Band 3 read them, or `ignored`, as Clone Hero 1.1 ignores them.
	 */
	readonly midiDrumsLyricEvents: 'read' | 'ignored'
	/** Whether a `.mid` track's `ENHANCED_OPENS` is read in any letter case, as Clone Hero reads it (C20: R13), or only in capitals. */
	readonly midiEnhancedOpens: 'anyCase' | 'capitals'
	/**
	 * Which `MTrk` chunks of a `.mid` file are tracks (C20: R15): `every` reads each one up to a chunk of another kind after
	 * the tracks the header counts, as Clone Hero does; `headerCount` reads only the tracks the header counts.
	 */
	readonly midiTrackChunks: 'every' | 'headerCount'
	/** Whether a `.mid` track's events after its end-of-track event are ignored, as Clone Hero ignores them (C20: R16), or read. */
	readonly midiEventsAfterEnd: 'ignored' | 'read'
	/**
	 * Which SysEx events are Phase Shift events (C20: R12): `exactly8Bytes`, `50 53 00 00 <difficulty> <type> <value> F7`
	 * as Clone Hero reads them, or `7BytesOrMore`, any event that starts with `50 53 00 00` and has a value byte.
	 */
	readonly phaseShiftSysEx: 'exactly8Bytes' | '7BytesOrMore'
	/**
	 * Whether a `.mid` text event that starts with a UTF-8 byte order mark keeps it as U+FEFF, as Clone Hero's UTF-8 decoding
	 * keeps it, or drops it, as `parseMidi`'s `TextDecoder` does.
	 */
	readonly midiTextByteOrderMark: 'kept' | 'dropped'
}

const scanner: ParseRules = Object.freeze({
	profile: 'scanner',
	midiTrackAllocation: 'difficultiesWithNotes',
	chartTrackAllocation: 'everySection',
	midiDuplicateInstrumentTracks: 'keepAll',
	midiChartDynamics: 'fromEvent',
	midiKickDynamics: 'ignored',
	chartFlam: 'read',
	midiFlam: 'laneVelocities',
	chartNonstandardLines: 'read',
	proDrumsGreenPair: 'blueTom',
	kickPair: 'kick',
	mixEvents: 'cloneHero',
	midiDrumsLyricEvents: 'read',
	midiEnhancedOpens: 'anyCase',
	midiTrackChunks: 'every',
	midiEventsAfterEnd: 'ignored',
	phaseShiftSysEx: 'exactly8Bytes',
	midiTextByteOrderMark: 'kept',
})

const frozenLegacy6142: ParseRules = Object.freeze({
	profile: 'frozenLegacy6142',
	midiTrackAllocation: 'difficultiesWithNotesAndExpert',
	chartTrackAllocation: 'everySection',
	midiDuplicateInstrumentTracks: 'keepAll',
	midiChartDynamics: 'leaksAcrossDifficulties',
	midiKickDynamics: 'applied',
	chartFlam: 'ignored',
	midiFlam: 'everyDifficulty',
	chartNonstandardLines: 'ignored',
	proDrumsGreenPair: 'longerBlue',
	kickPair: 'longer',
	mixEvents: 'strict',
	midiDrumsLyricEvents: 'ignored',
	midiEnhancedOpens: 'capitals',
	midiTrackChunks: 'headerCount',
	midiEventsAfterEnd: 'read',
	phaseShiftSysEx: '7BytesOrMore',
	midiTextByteOrderMark: 'dropped',
})

const canonical20260801: ParseRules = Object.freeze({
	profile: 'canonical20260801',
	midiTrackAllocation: 'difficultiesWithNotes',
	chartTrackAllocation: 'sectionsWithNotes',
	midiDuplicateInstrumentTracks: 'firstWins',
	midiChartDynamics: 'fromEvent',
	midiKickDynamics: 'ignored',
	chartFlam: 'read',
	midiFlam: 'laneVelocities',
	chartNonstandardLines: 'read',
	proDrumsGreenPair: 'blueTom',
	kickPair: 'kick',
	mixEvents: 'cloneHero',
	midiDrumsLyricEvents: 'read',
	midiEnhancedOpens: 'anyCase',
	midiTrackChunks: 'every',
	midiEventsAfterEnd: 'ignored',
	phaseShiftSysEx: 'exactly8Bytes',
	midiTextByteOrderMark: 'kept',
})

export const parseRules = Object.freeze({ scanner, frozenLegacy6142, canonical20260801 })

/**
 * The scanner's rules with each mix event reading (C20: R2, R10), so that one `.chart` line can be read both ways and
 * the readings compared, with every other rule alike.
 */
export const mixEventReadingRules: { readonly [reading in ParseRules['mixEvents']]: ParseRules } = Object.freeze({
	cloneHero: scanner,
	strict: Object.freeze({ ...scanner, mixEvents: 'strict' }),
})
