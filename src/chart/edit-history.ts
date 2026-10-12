import type { ChartFileTokens } from './chart-file-parser'
import type { MidiTokens } from './midi-tokens'

type Tokens = ChartFileTokens | MidiTokens

const caches: TokensCache<unknown, Tokens>[] = []

/**
 * Something derived from a chart file's tokens, `.chart` or `.mid`, kept per tokens, that a version made by editing them
 * can reuse in part. Each cache holds what it derived from the original, not the original tokens, so a document doesn't
 * keep every earlier version of it alive.
 */
export class TokensCache<T, K extends Tokens = ChartFileTokens> {
	private readonly values = new WeakMap<K, T>()
	private readonly fromOriginal = new WeakMap<K, T>()

	constructor() {
		caches.push(this as TokensCache<unknown, Tokens>)
	}

	get(tokens: K): T | undefined {
		return this.values.get(tokens)
	}

	set(tokens: K, value: T): void {
		this.values.set(tokens, value)
	}

	/** What was derived from the tokens `tokens` were edited from, if it was derived before the edit. */
	original(tokens: K): T | undefined {
		return this.fromOriginal.get(tokens)
	}

	link(original: K, edited: K): void {
		const value = this.values.get(original)
		if (value !== undefined) this.fromOriginal.set(edited, value)
	}
}

/** Records that `edited` was made by editing `original`, so what each cache derived from `original` can be reused. */
export function recordEdit<K extends Tokens>(original: K, edited: K): void {
	for (const cache of caches) cache.link(original, edited)
}
