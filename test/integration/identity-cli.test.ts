import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { generate, inspectBTrack } from '../../tools/ch-identity/generate'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'ch-identity-cli-'))
	temporaryDirectories.push(directory)
	return directory
}

function validChart(): string {
	return [
		'[Song]', '{', '  Resolution = 192', '}',
		'[SyncTrack]', '{', '  0 = B 120000', '}',
		'[Events]', '{', '}',
		'[ExpertSingle]', '{', '  0 = N 0 192', '}',
	].join('\r\n')
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('identity CLI generation', () => {
	it('accepts an existing empty output directory', async () => {
		const root = await temporaryDirectory()
		const song = join(root, 'song')
		const output = join(root, 'output')
		await mkdir(song)
		await mkdir(output)
		await writeFile(join(song, 'notes.chart'), validChart())
		await writeFile(join(song, 'song.ini'), '[Song]\r\nname = Empty Output\r\nsong_length = 1234\r\n')

		const result = await generate(song, output)
		expect(result.results).toHaveLength(1)
		expect(result.results[0].kind).toBe('success')
		await expect(access(join(output, 'song', 'manifest.json'))).resolves.toBeUndefined()
	})

	it('preserves and rejects a non-empty output directory', async () => {
		const root = await temporaryDirectory()
		const song = join(root, 'song')
		const output = join(root, 'output')
		await mkdir(song)
		await mkdir(output)
		await writeFile(join(song, 'notes.chart'), validChart())
		await writeFile(join(song, 'song.ini'), '[Song]\r\nname = Protected Output\r\nsong_length = 1234\r\n')
		await writeFile(join(output, 'keep.txt'), 'do not delete')

		await expect(generate(song, output)).rejects.toThrow('Output directory is not empty')
		await expect(readFile(join(output, 'keep.txt'), 'utf8')).resolves.toBe('do not delete')
	})

	it('preserves and rejects an existing output file', async () => {
		const root = await temporaryDirectory()
		const song = join(root, 'song')
		const output = join(root, 'output')
		await mkdir(song)
		await writeFile(join(song, 'notes.chart'), validChart())
		await writeFile(join(song, 'song.ini'), '[Song]\r\nname = Protected File\r\nsong_length = 1234\r\n')
		await writeFile(output, 'do not delete')

		await expect(generate(song, output)).rejects.toThrow('Output path already exists and is not a directory')
		await expect(readFile(output, 'utf8')).resolves.toBe('do not delete')
	})

	it('accepts an existing empty BTrack inspection directory', async () => {
		const root = await temporaryDirectory()
		const song = join(root, 'song')
		const generated = join(root, 'generated')
		const inspected = join(root, 'inspected')
		await mkdir(song)
		await mkdir(inspected)
		await writeFile(join(song, 'notes.chart'), validChart())
		await writeFile(join(song, 'song.ini'), '[Song]\r\nname = Inspect Output\r\nsong_length = 1234\r\n')
		await generate(song, generated)

		const btrack = join(generated, 'song', 'canonical20260801', 'tracks', '000-guitar-expert', 'physical.btrack')
		await inspectBTrack(btrack, inspected)
		await expect(access(join(inspected, 'manifest.json'))).resolves.toBeUndefined()
	})

	it('keeps successful song artifacts when another library folder fails', async () => {
		const root = await temporaryDirectory()
		const good = join(root, 'Artist', 'Good Song')
		const bad = join(root, 'Artist', 'Bad Song')
		const output = join(root, 'reference-output')
		await mkdir(good, { recursive: true })
		await mkdir(bad, { recursive: true })
		await writeFile(join(good, 'notes.chart'), validChart())
		await writeFile(join(good, 'song.ini'), '[Song]\r\nname = Good Song\r\nsong_length = 1234\r\n')
		await writeFile(join(bad, 'notes.chart'), 'not a chart')

		const result = await generate(root, output)
		expect(result.results.map(item => item.kind).sort()).toEqual(['failure', 'success'])
		await expect(access(join(output, 'songs', 'Artist', 'Good Song', 'canonical20260801', 'song', 'song-hash.txt')))
			.resolves.toBeUndefined()
		const manifest = await readFile(join(output, 'songs', 'Artist', 'Good Song', 'manifest.json'), 'utf8')
		expect(manifest).toContain('"schemaVersion": 3')
		expect(manifest).toContain('"source": "song.ini:song_length"')
		expect(manifest).toContain('"durationMs": "1234"')
		expect(manifest).toContain('"definition": "strikecore-all-track-last-note-plus-one-beat-v1"')
		expect(manifest).toContain('"durationMs": "1000"')
		expect(manifest).toContain('"definition": "strikecore-selected-track-last-note-v1"')
		expect(manifest).toContain('"durationMs": "500"')
		const runManifest = await readFile(join(output, 'manifest.json'), 'utf8')
		expect(runManifest).toContain('"scanChartDirty": true')
		expect(runManifest).toContain('"sourceTreeSha256": "working-tree"')
	})

	it('generates canonical artifacts when historical duration is unavailable', async () => {
		const root = await temporaryDirectory()
		const song = join(root, 'song')
		const output = join(root, 'output')
		await mkdir(song)
		await writeFile(join(song, 'notes.chart'), validChart())

		const result = await generate(song, output)
		expect(result.results[0]).toMatchObject({ kind: 'success', legacySongHash: null })
		await expect(access(join(output, 'song', 'canonical20260801', 'song', 'song-hash.txt'))).resolves.toBeUndefined()
		await expect(access(join(output, 'song', 'frozenLegacy6142', 'tracks', '000-guitar-expert', 'physical.btrack')))
			.resolves.toBeUndefined()
		const manifest = await readFile(join(output, 'song', 'manifest.json'), 'utf8')
		expect(manifest).toContain('"reason": "missingSongLength"')
		expect(manifest).toContain('"reason": "historicalDurationUnavailable"')
		expect(manifest).toContain('"definition": "strikecore-selected-track-last-note-v1"')
		expect(manifest).toContain('"durationMs": "500"')
	})
})
