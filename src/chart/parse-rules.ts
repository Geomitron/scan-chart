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
	 * Whether a `.chart` line or section written in a nonstandard way is read as what it probably means
	 * (chart-line-spelling.ts), with a resolution of 192 when the file gives none. Clone Hero refuses such a file, or
	 * reads it the same way; scan-chart 8 skipped such a line, which the frozen profile keeps doing.
	 */
	readonly chartNonstandardLines: 'read' | 'ignored'
	/**
	 * A pro drums chart's 5-lane green note on the tick of a green note, on one difficulty. `invalid` is the spec's rule:
	 * the chart is invalid, so games refuse it, and the parser reads the green note alone and records the tick. `blueTom`
	 * is Clone Hero 1.1's reading, which moves the 5-lane green to a blue tom.
	 */
	readonly proDrumsGreenPair: 'invalid' | 'blueTom'
	/**
	 * How a drums `mix` event's text is read, in either format (C20: R2, R10). `cloneHero` reads it as Clone Hero's
	 * `TryParseDiscoMixEvent` does: any spaces or `_` between the parts, a difficulty `int.TryParse` reads, any
	 * configuration character, and any text after it that starts with `d` as a flip. `strict` is scan-chart 8's reading:
	 * single separators, a configuration from 0 to 5, and only the flags `d`, `dnoflip`, `easy` and `easynokick`.
	 */
	readonly mixEvents: 'cloneHero' | 'strict'
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
}

const scanner: ParseRules = Object.freeze({
	profile: 'scanner',
	midiTrackAllocation: 'difficultiesWithNotes',
	chartTrackAllocation: 'everySection',
	midiDuplicateInstrumentTracks: 'keepAll',
	midiChartDynamics: 'fromEvent',
	midiKickDynamics: 'ignored',
	chartFlam: 'read',
	chartNonstandardLines: 'read',
	proDrumsGreenPair: 'invalid',
	mixEvents: 'cloneHero',
	midiEnhancedOpens: 'anyCase',
	midiTrackChunks: 'every',
	midiEventsAfterEnd: 'ignored',
	phaseShiftSysEx: 'exactly8Bytes',
})

const frozenLegacy6142: ParseRules = Object.freeze({
	profile: 'frozenLegacy6142',
	midiTrackAllocation: 'difficultiesWithNotesAndExpert',
	chartTrackAllocation: 'everySection',
	midiDuplicateInstrumentTracks: 'keepAll',
	midiChartDynamics: 'leaksAcrossDifficulties',
	midiKickDynamics: 'applied',
	chartFlam: 'ignored',
	chartNonstandardLines: 'ignored',
	proDrumsGreenPair: 'blueTom',
	mixEvents: 'strict',
	midiEnhancedOpens: 'capitals',
	midiTrackChunks: 'headerCount',
	midiEventsAfterEnd: 'read',
	phaseShiftSysEx: '7BytesOrMore',
})

const canonical20260801: ParseRules = Object.freeze({
	profile: 'canonical20260801',
	midiTrackAllocation: 'difficultiesWithNotes',
	chartTrackAllocation: 'sectionsWithNotes',
	midiDuplicateInstrumentTracks: 'firstWins',
	midiChartDynamics: 'fromEvent',
	midiKickDynamics: 'ignored',
	chartFlam: 'read',
	chartNonstandardLines: 'read',
	proDrumsGreenPair: 'invalid',
	mixEvents: 'cloneHero',
	midiEnhancedOpens: 'anyCase',
	midiTrackChunks: 'every',
	midiEventsAfterEnd: 'ignored',
	phaseShiftSysEx: 'exactly8Bytes',
})

export const parseRules = Object.freeze({ scanner, frozenLegacy6142, canonical20260801 })
