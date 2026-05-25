import * as _ from 'lodash'

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
	const seconds = _.floor((ms / 1000) % 60, 2)
	const minutes = _.floor((ms / 1000 / 60) % 60)
	const hours = _.floor((ms / 1000 / 60 / 60) % 24)
	return `${hours ? `${hours}:` : ''}${_.padStart(minutes + '', 2, '0')}:${_.padStart(seconds.toFixed(2), 5, '0')}`
}

/**
 * @returns a string representation of `ms` that looks like HH:MM:SS
 */
export function msToRoughTime(ms: number) {
	const seconds = _.floor((ms / 1000) % 60)
	const minutes = _.floor((ms / 1000 / 60) % 60)
	const hours = _.floor((ms / 1000 / 60 / 60) % 24)
	return `${hours ? `${hours}:` : ''}${minutes}:${_.padStart(String(seconds), 2, '0')}`
}
