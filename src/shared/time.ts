import { roundTo } from './lodash-equivalents'

/**
 * Converts `val` from the range (`fromStart`, `fromEnd`) to the range (`toStart`, `toEnd`).
 */
export function interpolate(val: number, fromStart: number, fromEnd: number, toStart: number, toEnd: number) {
	return ((val - fromStart) / (fromEnd - fromStart)) * (toEnd - toStart) + toStart
}

/**
 * @returns an string representation of `ms` that looks like HH:MM:SS.mm
 */
export function msToExactTime(ms: number) {
	const seconds = roundTo('floor', (ms / 1000) % 60, 2)
	const minutes = Math.floor((ms / 1000 / 60) % 60)
	const hours = Math.floor((ms / 1000 / 60 / 60) % 24)
	return `${hours ? `${hours}:` : ''}${String(minutes).padStart(2, '0')}:${seconds.toFixed(2).padStart(5, '0')}`
}

/**
 * @returns a string representation of `ms` that looks like HH:MM:SS
 */
export function msToRoughTime(ms: number) {
	const seconds = Math.floor((ms / 1000) % 60)
	const minutes = Math.floor((ms / 1000 / 60) % 60)
	const hours = Math.floor((ms / 1000 / 60 / 60) % 24)
	return `${hours ? `${hours}:` : ''}${minutes}:${String(seconds).padStart(2, '0')}`
}
