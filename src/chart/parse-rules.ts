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
}

const scanner: ParseRules = Object.freeze({
	profile: 'scanner',
	midiTapEnd: 'exclusive',
	midiTrackAllocation: 'difficultiesWithNotes',
})

const frozenLegacy6142: ParseRules = Object.freeze({
	profile: 'frozenLegacy6142',
	midiTapEnd: 'exclusive',
	midiTrackAllocation: 'difficultiesWithNotesAndExpert',
})

const canonical20260801: ParseRules = Object.freeze({
	profile: 'canonical20260801',
	midiTapEnd: 'inclusive',
	midiTrackAllocation: 'difficultiesWithNotes',
})

export const parseRules = Object.freeze({ scanner, frozenLegacy6142, canonical20260801 })
