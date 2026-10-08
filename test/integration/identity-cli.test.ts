import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeMidi } from '@geomitron/midi-file'
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
		'[EasyGHLKeys]', '{', '  0 = N 0 192', '}',
	].join('\r\n')
}

function validMidi(): Uint8Array {
	return new Uint8Array(writeMidi({
		header: { format: 1, numTracks: 2, ticksPerBeat: 192 },
		tracks: [
			[{ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 }, { deltaTime: 0, type: 'endOfTrack' }],
			[
				{ deltaTime: 0, type: 'trackName', text: 'PART BASS' },
				{ deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 96, velocity: 100 },
				{ deltaTime: 192, type: 'noteOff', channel: 0, noteNumber: 96, velocity: 0 },
				{ deltaTime: 0, type: 'endOfTrack' },
			],
		],
	}))
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('identity CLI generation', () => {
	it('uses the chart fallback without audio and keeps canonical duration independent of INI length and encoding', async () => {
		const root = await temporaryDirectory()
		const variants = [
			{ name: 'utf8', ini: Buffer.from('[song]\nsong_length = 9999\nSONG_LENGTH = 2345'), legacy: '2345', source: 'song.ini:song_length' },
			{ name: 'utf16', ini: Buffer.from('\ufeff[song]\nsong_length = 9999\nSONG_LENGTH = 2345', 'utf16le'), legacy: '2345', source: 'song.ini:song_length' },
			{ name: 'no-bom', ini: Buffer.from('[song]\nsong_length = 2345', 'utf16le'), legacy: '1000', source: 'chart-fallback' },
			{ name: 'invalid-last', ini: Buffer.from('[song]\nsong_length = 9999\nSONG_LENGTH = invalid'), legacy: '1000', source: 'chart-fallback' },
		]
		const canonicalHashes = new Set<string>()
		for (const variant of variants) {
			const song = join(root, variant.name)
			const output = join(root, `${variant.name}-output`)
			await mkdir(song)
			await writeFile(join(song, 'notes.chart'), validChart())
			await writeFile(join(song, 'song.ini'), variant.ini)
			await writeFile(join(song, 'crowd.ogg'), 'Crowd is excluded from CH length scanning')
			const result = await generate({ input: song, output })
			expect(result.results[0].kind).toBe('success')
			if (result.results[0].kind !== 'success') throw new Error(result.results[0].error)
			expect(result.results[0].legacySongHash).not.toBeNull()
			canonicalHashes.add(result.results[0].canonicalSongHash)
			const manifest = await readFile(join(output, 'song', 'manifest.json'), 'utf8')
			expect(manifest).toContain('"songDurationMs": "1000"')
			expect(manifest).toContain(`"source": "${variant.source}"`)
			expect(manifest).toContain(`"durationMs": "${variant.legacy}"`)
		}
		expect(canonicalHashes.size).toBe(1)
	})

	it('accepts an existing empty output directory', async () => {
		const root = await temporaryDirectory()
		const song = join(root, 'song')
		const output = join(root, 'output')
		await mkdir(song)
		await mkdir(output)
		await writeFile(join(song, 'notes.chart'), validChart())
		await writeFile(join(song, 'song.ini'), '[Song]\r\nname = Empty Output\r\nsong_length = 1234\r\n')

		const result = await generate({ input: song, output })
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

		await expect(generate({ input: song, output })).rejects.toThrow('Output directory is not empty')
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

		await expect(generate({ input: song, output })).rejects.toThrow('Output path already exists and is not a directory')
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
		await generate({ input: song, output: generated })

		const btrack = join(generated, 'song', 'canonical20260801', 'tracks', '000-guitar-expert', 'physical.btrack')
		await inspectBTrack({ input: btrack, output: inspected })
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

		const result = await generate({ input: root, output })
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
		await writeFile(join(song, 'song.ogg'), 'Audio is present; this tool cannot measure its BASS duration')

		const result = await generate({ input: song, output })
		expect(result.results[0]).toMatchObject({ kind: 'success', legacySongHash: null })
		await expect(access(join(output, 'song', 'canonical20260801', 'song', 'song-hash.txt'))).resolves.toBeUndefined()
		await expect(access(join(output, 'song', 'frozenLegacy6142', 'tracks', '000-guitar-expert', 'physical.btrack')))
			.resolves.toBeUndefined()
		await expect(access(join(output, 'song', 'frozenLegacy6142', 'tracks', '001-keysghl-easy', 'physical.btrack')))
			.resolves.toBeUndefined()
		const manifest = await readFile(join(output, 'song', 'manifest.json'), 'utf8')
		expect(manifest).toContain('"reason": "audioLengthUnavailable"')
		expect(manifest).toContain('"reason": "historicalDurationUnavailable"')
		expect(manifest).toContain('"definition": "strikecore-selected-track-last-note-v1"')
		expect(manifest).toContain('"durationMs": "500"')
	})

	it('uses notes.mid when a folder also has notes.chart', async () => {
		const root = await temporaryDirectory()
		const both = join(root, 'both')
		const midiOnly = join(root, 'midi-only')
		for (const folder of [both, midiOnly]) {
			await mkdir(folder)
			await writeFile(join(folder, 'notes.mid'), validMidi())
			await writeFile(join(folder, 'song.ini'), '[Song]\r\nname = Both Files\r\nsong_length = 1234\r\n')
		}
		await writeFile(join(both, 'notes.chart'), validChart())

		const result = await generate({ input: root, output: join(root, 'output') })
		expect(result.results.map(item => item.kind)).toEqual(['success', 'success'])
		const [bothResult, midiResult] = result.results
		if (bothResult.kind !== 'success' || midiResult.kind !== 'success') throw new Error('Expected both folders to succeed')
		expect(bothResult.canonicalSongHash).toBe(midiResult.canonicalSongHash)
		const manifest = await readFile(join(root, 'output', 'songs', 'both', 'manifest.json'), 'utf8')
		expect(manifest).toContain('"sourceFile": "notes.mid"')
	})
})
