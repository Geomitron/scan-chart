/**
 * The parsing rules that differ between scan-chart's parse profiles. Each profile is one frozen object,
 * and the parser reads its behavior from that object instead of from positional switches.
 *
 * To make a profile diverge, add a rule here and set it on every profile. Do not construct rule objects
 * anywhere else: callers choose a profile through `parseChartFile` or an identity profile.
 */
export interface ParseRules {
	readonly profile: 'scanner' | 'frozenLegacy6142' | 'canonical20260801'
	/** Whether a MIDI tap phrase (SysEx or note 104) still applies to a note on its end tick. */
	readonly midiTapEnd: 'exclusive' | 'inclusive'
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
}

const scanner: ParseRules = Object.freeze({
	profile: 'scanner',
	midiTapEnd: 'exclusive',
	midiTrackAllocation: 'difficultiesWithNotes',
	chartTrackAllocation: 'everySection',
	midiDuplicateInstrumentTracks: 'keepAll',
	midiChartDynamics: 'fromEvent',
	midiKickDynamics: 'ignored',
})

const frozenLegacy6142: ParseRules = Object.freeze({
	profile: 'frozenLegacy6142',
	midiTapEnd: 'exclusive',
	midiTrackAllocation: 'difficultiesWithNotesAndExpert',
	chartTrackAllocation: 'everySection',
	midiDuplicateInstrumentTracks: 'keepAll',
	midiChartDynamics: 'leaksAcrossDifficulties',
	midiKickDynamics: 'applied',
})

const canonical20260801: ParseRules = Object.freeze({
	profile: 'canonical20260801',
	midiTapEnd: 'inclusive',
	midiTrackAllocation: 'difficultiesWithNotes',
	chartTrackAllocation: 'sectionsWithNotes',
	midiDuplicateInstrumentTracks: 'firstWins',
	midiChartDynamics: 'fromEvent',
	midiKickDynamics: 'ignored',
})

export const parseRules = Object.freeze({ scanner, frozenLegacy6142, canonical20260801 })
