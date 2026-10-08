import { describe, expect, it } from 'vitest'

import { parseRules } from 'src/chart/parse-rules'

describe('parse profiles', () => {
	it('keeps every profile rule visible in review', () => {
		expect(parseRules).toMatchInlineSnapshot(`
			{
			  "canonical20260801": {
			    "midiTapEnd": "inclusive",
			    "midiTrackAllocation": "difficultiesWithNotes",
			    "profile": "canonical20260801",
			  },
			  "frozenLegacy6142": {
			    "midiTapEnd": "exclusive",
			    "midiTrackAllocation": "difficultiesWithNotesAndExpert",
			    "profile": "frozenLegacy6142",
			  },
			  "scanner": {
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
