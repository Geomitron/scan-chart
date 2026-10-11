import { describe, expect, it } from 'vitest'

import { parseRules } from 'src/chart/parse-rules'

describe('parse profiles', () => {
	it('keeps every profile rule visible in review', () => {
		expect(parseRules).toMatchInlineSnapshot(`
			{
			  "canonical20260801": {
			    "chartTrackAllocation": "sectionsWithNotes",
			    "midiChartDynamics": "fromEvent",
			    "midiDuplicateInstrumentTracks": "firstWins",
			    "midiKickDynamics": "ignored",
			    "midiTapEnd": "inclusive",
			    "midiTrackAllocation": "difficultiesWithNotes",
			    "profile": "canonical20260801",
			  },
			  "frozenLegacy6142": {
			    "chartTrackAllocation": "everySection",
			    "midiChartDynamics": "leaksAcrossDifficulties",
			    "midiDuplicateInstrumentTracks": "keepAll",
			    "midiKickDynamics": "applied",
			    "midiTapEnd": "exclusive",
			    "midiTrackAllocation": "difficultiesWithNotesAndExpert",
			    "profile": "frozenLegacy6142",
			  },
			  "scanner": {
			    "chartTrackAllocation": "everySection",
			    "midiChartDynamics": "fromEvent",
			    "midiDuplicateInstrumentTracks": "keepAll",
			    "midiKickDynamics": "ignored",
			    "midiTapEnd": "exclusive",
			    "midiTrackAllocation": "difficultiesWithNotes",
			    "profile": "scanner",
			  },
			}
		`)
	})

	it('cannot be modified at runtime', () => {
		expect(Object.isFrozen(parseRules)).toBe(true)
		for (const rules of Object.values(parseRules)) expect(Object.isFrozen(rules)).toBe(true)
	})
})
