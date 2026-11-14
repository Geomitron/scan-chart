import { readdir, readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'

import { describe, expect, it } from 'vitest'

import { apiFolder, docsJsonPath, generateApiReference, withApiNavigation } from '../../tools/api-reference/generate'

/** Git may check the committed files out with CRLF line endings; the generator writes LF. */
function lf(text: string): string {
	return text.replace(/\r\n/g, '\n')
}

async function committedPages(): Promise<Map<string, string>> {
	const entries = (await readdir(apiFolder, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
	const pages = new Map<string, string>()
	for (const entry of entries) {
		const path = join(entry.parentPath, entry.name)
		pages.set(posix.join(...path.slice(apiFolder.length + 1).split(/[\\/]/)), lf(await readFile(path, 'utf8')))
	}
	return pages
}

describe('API reference', () => {
	it('is what `npm run docs:api` generates from the current source', async () => {
		const reference = await generateApiReference()
		const committed = await committedPages()
		const message = 'docs/scan-chart/api is out of date: run `npm run docs:api`'
		expect([...committed.keys()].sort(), message).toEqual([...reference.pages.keys()].sort())
		for (const [file, contents] of reference.pages) expect(committed.get(file), `${message} (${file})`).toBe(contents)

		const docsJson = lf(await readFile(docsJsonPath, 'utf8'))
		expect(docsJson, 'docs/docs.json lists other API pages: run `npm run docs:api`').toBe(await withApiNavigation(docsJson, reference.navigation))
	}, 120_000)
})
