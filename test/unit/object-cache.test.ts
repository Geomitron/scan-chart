import { describe, expect, it } from 'vitest'

import { ObjectCache } from 'src/shared/object-cache'

describe('ObjectCache', () => {
	it('keeps a value per object, hidden from spreading, JSON and cloning', () => {
		const cache = new ObjectCache<object, number>('test')
		const object = { a: 1 }
		expect(cache.get(object)).toBeUndefined()
		cache.set(object, 5)
		expect(cache.get(object)).toBe(5)
		expect(cache.get({ ...object })).toBeUndefined()
		expect(cache.get(structuredClone(object))).toBeUndefined()
		expect(JSON.stringify(object)).toBe('{"a":1}')
		expect(Object.keys(object)).toEqual(['a'])
	})

	it('caches for a frozen object too', () => {
		const cache = new ObjectCache<object, number>('test')
		const object = Object.freeze({ a: 1 })
		cache.set(object, 7)
		expect(cache.get(object)).toBe(7)
	})

	it('keeps separate values for separate caches', () => {
		const first = new ObjectCache<object, string>('same name')
		const second = new ObjectCache<object, string>('same name')
		const object = {}
		first.set(object, 'first')
		second.set(object, 'second')
		expect([first.get(object), second.get(object)]).toEqual(['first', 'second'])
	})
})
