import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { apiFolder, docsJsonPath, filesUnder, generateApiReference, toLf, withApiNavigation } from '../../tools/api-reference/generate'

/** The committed pages, with LF line endings, since Git may check them out with CRLF. */
async function committedPages(): Promise<Map<string, string>> {
	const pages = new Map<string, string>()
	for (const file of await filesUnder(apiFolder)) pages.set(file, toLf(await readFile(join(apiFolder, file), 'utf8')))
	return pages
}

describe('API reference', () => {
	it('is what `npm run docs:api` generates from the current source', async () => {
		const reference = await generateApiReference()
		const committed = await committedPages()
		const message = 'docs/scan-chart/api is out of date: run `npm run docs:api`'
		expect([...committed.keys()].sort(), message).toEqual([...reference.pages.keys()].sort())
		for (const [file, contents] of reference.pages) expect(committed.get(file), `${message} (${file})`).toBe(contents)

		const docsJson = toLf(await readFile(docsJsonPath, 'utf8'))
		expect(docsJson, 'docs/docs.json lists other API pages: run `npm run docs:api`').toBe(await withApiNavigation(docsJson, reference.navigation))
	}, 120_000)
})
