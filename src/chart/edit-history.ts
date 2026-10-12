import type { ChartFileTokens } from './chart-file-parser'

const caches: TokensCache<unknown>[] = []

/**
 * Something derived from a `.chart` file's tokens, kept per tokens, that a version made by editing them can reuse in
 * part. Each cache holds what it derived from the original, not the original tokens, so a document doesn't keep every
 * earlier version of it alive.
 */
export class TokensCache<T> {
	private readonly values = new WeakMap<ChartFileTokens, T>()
	private readonly fromOriginal = new WeakMap<ChartFileTokens, T>()

	constructor() {
		caches.push(this as TokensCache<unknown>)
	}

	get(tokens: ChartFileTokens): T | undefined {
		return this.values.get(tokens)
	}

	set(tokens: ChartFileTokens, value: T): void {
		this.values.set(tokens, value)
	}

	/** What was derived from the tokens `tokens` were edited from, if it was derived before the edit. */
	original(tokens: ChartFileTokens): T | undefined {
		return this.fromOriginal.get(tokens)
	}

	link(original: ChartFileTokens, edited: ChartFileTokens): void {
		const value = this.values.get(original)
		if (value !== undefined) this.fromOriginal.set(edited, value)
	}
}

/** Records that `edited` was made by editing `original`, so what each cache derived from `original` can be reused. */
export function recordChartEdit(original: ChartFileTokens, edited: ChartFileTokens): void {
	for (const cache of caches) cache.link(original, edited)
}
