import type { Difficulty, Instrument } from '../../types'

const identityTrackKeyToken: unique symbol = Symbol('identityTrackKey')

export type IdentityTrackKey = string & { readonly [identityTrackKeyToken]: true }

export function identityTrackKey(instrument: Instrument, difficulty: Difficulty): IdentityTrackKey {
	return `${instrument}:${difficulty}` as IdentityTrackKey
}
