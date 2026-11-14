// Regenerates docs/scan-chart/api and the scan-chart tab's API groups in docs/docs.json (`npm run docs:api`).
import { generateApiReference, writeApiReference } from './generate'

async function main(): Promise<void> {
	const reference = await generateApiReference()
	await writeApiReference(reference)
	console.log(`Wrote ${reference.pages.size} API reference pages to docs/scan-chart/api and updated docs/docs.json.`)
}

main().catch(error => {
	console.error(error instanceof Error ? error.message : error)
	process.exitCode = 1
})
