import { describe, expect, it } from 'vitest'

import { noflipsDuringFlips } from 'src/chart/disco-flip'
import type { DrumMixEvent } from 'src/chart/raw-types'

const mix = (tick: number, flag: DrumMixEvent['flag'], configuration = 0): DrumMixEvent => ({ tick, configuration, flag })

describe('noflipsDuringFlips', () => {
	it('turns the flip off on the tick before the dnoflip, with the d event\'s configuration', () => {
		expect(noflipsDuringFlips([mix(960, 'dnoflip'), mix(480, 'd', 2)], [700, 480])).toEqual([{ noflipTick: 960, offTick: 959, configuration: 2 }])
		expect(noflipsDuringFlips([mix(480, 'd'), mix(720, ''), mix(960, 'dnoflip')], [480])).toEqual([])
	})

	it('finds no tick when a red or yellow note, or the d event, is on the tick before', () => {
		expect(noflipsDuringFlips([mix(480, 'd'), mix(960, 'dnoflip')], [959])).toEqual([{ noflipTick: 960, offTick: null, configuration: 0 }])
		expect(noflipsDuringFlips([mix(959, 'd'), mix(960, 'dnoflip')], [])).toEqual([{ noflipTick: 960, offTick: null, configuration: 0 }])
	})

	it('reads an event turning the flip off at a tick first, then d, as readers do', () => {
		expect(noflipsDuringFlips([mix(480, 'd'), mix(960, 'dnoflip'), mix(960, '')], [])).toEqual([])
		expect(noflipsDuringFlips([mix(480, 'd'), mix(960, 'dnoflip'), mix(960, 'd')], [])).toEqual([])
		expect(noflipsDuringFlips([mix(480, 'dnoflip'), mix(480, 'd'), mix(960, 'dnoflip')], [])).toEqual([{ noflipTick: 960, offTick: 959, configuration: 0 }])
	})
})
