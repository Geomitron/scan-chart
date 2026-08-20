import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { readBTrack20260801 } from 'src/chart/identity/btrack-20260801'

import { physicalCases, resolvedModifiers, sourceCases } from './cases'
import { canonicalPipeline, deriveSourceCase, stableJson } from './derive'
import { BTrackAcceptedVector, BTrackRejectedVector, FixtureFile, FixtureProvenance, GoldenManifestV1, SourceAcceptedVector } from './schema'

function outputArgument(): string {
	const index = process.argv.indexOf('--out')
	if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: npm run vectors:generate -- --out <new-directory>')
	return path.resolve(process.argv[index + 1])
}

function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child)
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function main(): Promise<void> {
	const output = outputArgument()
	const approvedRoot = path.resolve('test/golden-vectors/suites')
	if (isWithin(approvedRoot, output)) throw new Error('The generator cannot write inside the approved fixture tree')
	if (existsSync(output)) throw new Error(`Output directory already exists: ${output}`)
	await mkdir(path.dirname(output), { recursive: true })
	await mkdir(output)

	async function artifact(relativePath: string, value: Uint8Array): Promise<FixtureFile> {
		const absolute = path.join(output, relativePath)
		await mkdir(path.dirname(absolute), { recursive: true })
		await writeFile(absolute, value, { flag: 'wx' })
		return {
			path: relativePath.replaceAll('\\', '/'),
			byteLength: value.length,
			sha256: createHash('sha256').update(value).digest('hex'),
		}
	}

	const provenance = (purpose: string): FixtureProvenance => ({
		kind: 'authored-minimal',
		author: 'scan-chart migration maintainers',
		license: 'MIT',
		purpose,
	})
	const vectors: (SourceAcceptedVector | BTrackAcceptedVector | BTrackRejectedVector)[] = []

	for (const sourceCase of sourceCases) {
		const derived = deriveSourceCase(sourceCase)
		const root = `artifacts/${sourceCase.id}`
		const pipeline = async (name: 'legacy6142' | 'canonical20260801', value: typeof derived.legacy) => ({
			parsedSemantics: await artifact(`${root}/${name}/semantics.json`, stableJson(value.semantics)),
			diagnostics: await artifact(`${root}/${name}/diagnostics.json`, stableJson(value.diagnostics)),
			physicalBTrack: await artifact(`${root}/${name}/physical.btrack`, value.physical),
			projection: await artifact(`${root}/${name}/projection.bin`, value.projection),
			rawDigest: await artifact(`${root}/${name}/digest.bin`, value.digest),
			trackHash: value.trackHash,
		})
		vectors.push({
			kind: 'source-accepted',
			id: sourceCase.id,
			provenance: provenance(sourceCase.purpose),
			sourceFormat: sourceCase.format,
			source: await artifact(`${root}/source.${sourceCase.format === 'chart' ? 'chart' : 'mid'}`, sourceCase.bytes),
			modifiers: resolvedModifiers,
			target: sourceCase.target,
			expected: {
				legacy6142: {
					...await pipeline('legacy6142', derived.legacy),
					publishedPaddedTrackHash: derived.legacy.publishedPaddedTrackHash!,
				},
				canonical20260801: await pipeline('canonical20260801', derived.canonical),
			},
		})
	}

	for (const physicalCase of physicalCases) {
		const root = `artifacts/${physicalCase.id}`
		const physicalBTrack = await artifact(`${root}/physical.btrack`, physicalCase.bytes)
		const read = readBTrack20260801(physicalCase.bytes)
		if (physicalCase.expected === 'accepted') {
			if (read.kind !== 'accepted') throw new Error(`${physicalCase.id}: expected accepted BTrack`)
			const derived = canonicalPipeline(read.identity, read.semantics)
			vectors.push({
				kind: 'btrack-accepted',
				id: physicalCase.id,
				provenance: provenance(physicalCase.purpose),
				physicalBTrack,
				expected: {
					parsedSemantics: await artifact(`${root}/semantics.json`, stableJson(derived.semantics)),
					projection: await artifact(`${root}/projection.bin`, derived.projection),
					rawDigest: await artifact(`${root}/digest.bin`, derived.digest),
					trackHash: derived.trackHash,
				},
			})
		} else {
			if (read.kind !== 'rejected') throw new Error(`${physicalCase.id}: expected rejected BTrack`)
			vectors.push({
				kind: 'btrack-rejected',
				id: physicalCase.id,
				provenance: provenance(physicalCase.purpose),
				physicalBTrack,
				expectedErrors: await artifact(`${root}/errors.json`, stableJson(read.errors)),
			})
		}
	}

	const manifest: GoldenManifestV1 = {
		schemaVersion: 1,
		contract: {
			legacy: 'clone-hero-1.1.0.6142',
			physical: 'CHNF/20260801',
			projection: 'ticket-03-map-first',
			parser: 'ticket-05-20260801',
		},
		compatibility: {
			vectorIdsAreImmutable: true,
			generatorMayOverwriteApprovedFixtures: false,
			canonicalHashEncoding: 'base64url-unpadded',
		},
		vectors,
	}
	await writeFile(path.join(output, 'manifest.json'), stableJson(manifest), { flag: 'wx' })
	console.log(`Generated ${vectors.length} vectors in ${output}`)
}

main().catch(error => {
	console.error(error instanceof Error ? error.message : error)
	process.exitCode = 1
})
