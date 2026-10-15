import { roundTo } from './lodash-equivalents'

/**
 * Converts `val` from the range (`fromStart`, `fromEnd`) to the range (`toStart`, `toEnd`).
 */
export function interpolate(val: number, fromStart: number, fromEnd: number, toStart: number, toEnd: number) {
	return ((val - fromStart) / (fromEnd - fromStart)) * (toEnd - toStart) + toStart
}

/**
 * @returns how to keep the notes in time with the audio without delaying them by `ms`, as song.ini's delay or a `.chart`
 * Offset does: by the audio's start, or by moving the notes.
 */
export function undelayedSyncAdvice(ms: number) {
	return ms > 0
		? `start the audio ${ms} ms earlier, by removing its first ${ms} ms, or move every note ${ms} ms later`
		: `add ${-ms} ms of silence to the start of the audio, or move every note ${-ms} ms earlier`
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
