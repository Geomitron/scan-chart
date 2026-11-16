import { parseDotnetInt } from '../ini/scan-ini'
import { trimDotnet } from '../shared/text'
import type { Difficulty } from '../types'
import type { ParseRules } from './parse-rules'
import { type DrumMixEvent, type EventType, eventTypes } from './raw-types'

/** The difficulties in the order a mix event numbers them, from 0. */
const mixDifficulties = ['easy', 'medium', 'hard', 'expert'] as const

/**
 * A drums `mix <difficulty> drums<configuration><flag>` event as a reading reads it. The `strict` reading reads the flags
 * `easy` and `easynokick` and gives them no meaning (`setsDiscoFlip`).
 */
export interface MixEventReading {
	readonly difficulty: Difficulty
	readonly configuration: number
	readonly flag: DrumMixEvent['flag']
}

const strictPattern = /^\s*\[?mix[ _]([0-3])[ _]drums([0-5])(d|dnoflip|easy|easynokick|)\]?\s*$/

/**
 * The mix event `text` is in the reading `reading`, or `null` when it reads none. In the `cloneHero` reading, the
 * configuration is the character after `drums`, read as a number only when it's a digit from 0 to 5, and otherwise as 0,
 * which the writers write.
 */
export function readMixEvent(text: string, reading: ParseRules['mixEvents']): MixEventReading | null {
	if (reading === 'strict') {
		const match = strictPattern.exec(text)
		return match === null ? null
			: { difficulty: mixDifficulties[Number(match[1])], configuration: Number(match[2]), flag: match[3] as MixEventReading['flag'] }
	}
	return readCloneHeroMixEvent(text)
}

/** The event type each flag gives a mix event that sets a disco flip. */
export const discoFlipEventTypes: { readonly [flag in DrumMixEvent['flag']]: EventType } = {
	'': eventTypes.discoFlipOff,
	easy: eventTypes.discoFlipOff,
	easynokick: eventTypes.discoFlipOff,
	d: eventTypes.discoFlipOn,
	dnoflip: eventTypes.discoNoFlipOn,
}

/** Whether `flag` is `easy` or `easynokick`, which choose the easy-difficulty drum audio and turn a flip off. */
export function isEasyMixFlag(flag: string): flag is 'easy' | 'easynokick' {
	return flag === 'easy' || flag === 'easynokick'
}

/** Whether the mix event `mix`, read in the reading `reading`, sets a disco flip: the `strict` reading gives `easy` and `easynokick` none. */
export function setsDiscoFlip(mix: MixEventReading, reading: ParseRules['mixEvents']): boolean {
	return reading !== 'strict' || !isEasyMixFlag(mix.flag)
}

/**
 * Clone Hero's reading: StrikeCore's readers check that the text starts with `[mix` or `mix`, then `Track.TryParseDiscoMixEvent`
 * splits it, and `Track.ParseDiscoMix` reads the part from `drums` on: `drums` and one character turn the flip off, then
 * `dnoflip` starts no-flip and any other `d` starts a flip. Any other flag turns the flip off too: `easy` and
 * `easynokick` are read as written, so that the writers keep them, and an unknown flag as no flag.
 */
function readCloneHeroMixEvent(text: string): MixEventReading | null {
	if (!text.startsWith('[mix') && !text.startsWith('mix')) return null
	let trimmed = trimDotnet(text)
	if (trimmed.startsWith('[')) trimmed = trimmed.slice(1, trimmed.endsWith(']') && trimmed.length > 1 ? -1 : undefined)
	let rest = trimmed.replace(/_/g, ' ')
	const mixEnd = rest.indexOf(' ')
	if (mixEnd === -1 || rest.slice(0, mixEnd) !== 'mix') return null
	rest = rest.slice(mixEnd).replace(dotnetLeadingWhitespace, '')
	const difficultyEnd = rest.indexOf(' ')
	if (difficultyEnd === -1) return null
	const difficulty = mixDifficulties[parseDotnetInt(rest.slice(0, difficultyEnd)) ?? -1] as Difficulty | undefined
	if (difficulty === undefined) return null
	const drums = rest.slice(difficultyEnd).replace(dotnetLeadingWhitespace, '')
	if (!drums.startsWith('drums') || drums.length < 6) return null
	const configuration = /^[0-5]$/.test(drums[5]) ? Number(drums[5]) : 0
	const flag = drums.slice(6)
	if (isEasyMixFlag(flag)) return { difficulty, configuration, flag }
	if (!flag.startsWith('d')) return { difficulty, configuration, flag: '' }
	return { difficulty, configuration, flag: flag.startsWith('dnoflip') ? 'dnoflip' : 'd' }
}

/** .NET's `char.IsWhiteSpace` set at the start of a string, which `TrimStart()` removes. */
const dotnetLeadingWhitespace = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/

/**
 * Whether `text` is a mix event the two readings read differently (C20: R2, R10): Clone Hero's reads a flip, no-flip
 * or flip off that scan-chart 8 read otherwise or not at all, or the reverse. The flags `easy` and `easynokick` are
 * standard: both readings read them alike.
 */
export function isMixEventSpelledAnotherWay(text: string): boolean {
	const read = readMixEvent(text, 'cloneHero')
	const strict = readMixEvent(text, 'strict')
	return read?.difficulty !== strict?.difficulty || read?.flag !== strict?.flag || read?.configuration !== strict?.configuration
}
