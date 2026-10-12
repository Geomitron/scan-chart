/**
 * A value calculated once per object, held by the object in a hidden property, so it's collected with the object.
 *
 * A WeakMap is the usual cache, but V8 is slow to collect a WeakMap value whose key was short-lived: caching each
 * song's parse in one, keyed by a document that was dropped right after scanning, nearly doubled the CPU time of
 * parsing a song folder in Node 24. A frozen object can't take the property, so its value is kept in a WeakMap.
 */
export class ObjectCache<K extends object, V> {
	private readonly key: symbol
	private readonly frozen = new WeakMap<K, V>()

	constructor(name: string) {
		this.key = Symbol(name)
	}

	get(object: K): V | undefined {
		return Object.prototype.hasOwnProperty.call(object, this.key) ? (object as { [key: symbol]: V })[this.key] : this.frozen.get(object)
	}

	/** The property isn't enumerable, so spreading or cloning the object leaves it out. */
	set(object: K, value: V): void {
		if (Object.isExtensible(object)) Object.defineProperty(object, this.key, { value, configurable: true })
		else this.frozen.set(object, value)
	}
}
