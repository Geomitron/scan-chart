// The few lodash functions scan-chart used, written out with lodash's exact behavior. lodash doesn't declare itself
// free of side effects, so a bundler kept all of it in any tool that imported scan-chart, even a metadata-only one.

/**
 * `_.round`, `_.floor` and `_.ceil`: rounds to `precision` decimal places by shifting the decimal exponent in the
 * number's text, which avoids the binary error of multiplying (1.005 rounds to 1.01).
 */
export function roundTo(method: 'round' | 'floor' | 'ceil', number: number, precision: number): number {
	if (precision === 0 || !Number.isFinite(number)) return Math[method](number)
	const [digits, exponent = '0'] = `${number}e`.split('e')
	const shifted = Math[method](Number(`${digits}e${Number(exponent) + precision}`))
	const [shiftedDigits, shiftedExponent = '0'] = `${shifted}e`.split('e')
	return Number(`${shiftedDigits}e${Number(shiftedExponent) - precision}`)
}

/** `_.max`: the largest value, skipping `null`, `undefined` and NaN; `undefined` when there's none. */
export function maxOf(values: readonly (number | null | undefined)[]): number | undefined {
	let max: number | undefined
	for (const value of values) if (value != null && !Number.isNaN(value) && (max === undefined || value > max)) max = value
	return max
}

/** `_.min`: the smallest value, skipping `null`, `undefined` and NaN; `undefined` when there's none. */
export function minOf(values: readonly (number | null | undefined)[]): number | undefined {
	let min: number | undefined
	for (const value of values) if (value != null && !Number.isNaN(value) && (min === undefined || value < min)) min = value
	return min
}

/** `_.uniq`: the distinct values, in the order each first appears. */
export function uniq<T>(values: readonly T[]): T[] {
	return [...new Set(values)]
}

/** `_.difference`: the items of `values` that aren't in `excluded`. */
export function difference<T>(values: readonly T[], excluded: readonly T[]): T[] {
	const set = new Set(excluded)
	return values.filter(value => !set.has(value))
}

/** `_.remove`: removes the items `predicate` accepts from `array`, in place, and returns them. */
export function removeWhere<T>(array: T[], predicate: (item: T) => boolean): T[] {
	const removed: T[] = []
	for (let index = 0; index < array.length;) {
		if (predicate(array[index])) removed.push(...array.splice(index, 1))
		else index++
	}
	return removed
}

/** `_.truncate` with lodash's default omission: `text` cut to `length` characters, the last three being `...`. */
export function truncate(text: string, length: number): string {
	const characters = Array.from(text)
	return characters.length <= length ? text : `${characters.slice(0, Math.max(0, length - 3)).join('')}...`
}
