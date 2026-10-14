import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * The README's TypeScript blocks, checked so its examples can't go stale:
 * - every block type-checks against the package;
 * - a block marked `ts browser` is only type-checked;
 * - a block that shows a type's shape (an `interface` the package exports) must match the exported type;
 * - every other block runs on a fixture song folder. Its paths, `songs/...`, are moved into a temporary folder, and
 *   the block that defines `readSongFolder` is imported by the blocks that use it.
 */
const root = resolve(__dirname, '../..')
const readme = readFileSync(join(root, 'readme.md'), 'utf8')
const blocks = [...readme.matchAll(/^```(ts[^\n]*)\n([\s\S]*?)^```$/gm)].map(([, info, code], index) => ({ index, info: info.split(/\s+/), code }))
const work = mkdtempSync(join(tmpdir(), 'scan-chart-readme-'))
const songs = join(work, 'songs').replace(/\\/g, '/')
afterAll(() => rmSync(work, { recursive: true, force: true }))

const exportedShapes = new Set(['SongFile', 'Issue'])
const shapeName = (code: string) => /^interface (\w+)/m.exec(code)?.[1]
const isShape = (code: string) => exportedShapes.has(shapeName(code) ?? '')
const definesReader = (code: string) => code.includes('async function readSongFolder(')

/** The block as a module: imports pointed at the source, the reader imported where it's used, paths moved. */
function moduleSource(code: string): string {
	let source = code
		.replace(/from 'scan-chart\/competitive'/g, 'from \'src/competitive\'')
		.replace(/from 'scan-chart'/g, 'from \'src/index\'')
		.replace(/'songs\//g, `'${songs}/`)
	if (definesReader(source)) source = source.replace('async function readSongFolder(', 'export async function readSongFolder(')
	else if (source.includes('readSongFolder(')) source = `import { readSongFolder } from './read-song-folder'\n${source}`
	if (isShape(code)) {
		// The shape must match the exported type, both ways.
		const name = shapeName(code)!
		const types = ['ByteSource', 'IssueCode', 'Instrument', 'Difficulty'].filter(type => code.includes(type))
		source = source.replace(`interface ${name}`, `interface Readme${name}`)
		source = `import type { ${[name, ...types].join(', ')} } from 'src/index'\n${source}\n`
			+ `export const fromPackage: Readme${name} = {} as ${name}\nexport const fromReadme: ${name} = {} as Readme${name}\n`
	}
	return `${source}\nexport {}\n`
}

const files = blocks.map(block => ({
	...block,
	path: join(work, definesReader(block.code) ? 'read-song-folder.ts' : `block-${block.index}.ts`),
}))
for (const file of files) writeFileSync(file.path, moduleSource(file.code))

function writeFixtureSong() {
	const folder = join(songs, 'Example Song')
	mkdirSync(folder, { recursive: true })
	writeFileSync(join(folder, 'notes.chart'), [
		'[Song]', '{', '  Resolution = 192', '}',
		'[SyncTrack]', '{', '  0 = TS 4', '  0 = B 120000', '}',
		'[Events]', '{', '  0 = E "section Intro"', '}',
		'[ExpertSingle]', '{', '  0 = N 0 0', '  192 = N 1 0', '  384 = N 2 192', '  0 = S 2 768', '}',
		'[HardSingle]', '{', '  0 = N 0 0', '  384 = N 2 0', '}',
	].join('\r\n') + '\r\n')
	writeFileSync(join(folder, 'song.ini'), '[song]\r\nname = Example Song\r\nartist = Example Band\r\ncharter = Example Charter\r\ndiff_guitar = 3\r\n')
	writeFileSync(join(folder, 'song.ogg'), 'not really audio')
}

describe('the README', () => {
	it('has the examples this test expects', () => {
		expect(files.filter(file => definesReader(file.code))).toHaveLength(1)
		expect(files.filter(file => isShape(file.code)).map(file => shapeName(file.code))).toEqual(['SongFile', 'Issue'])
		expect(files.filter(file => !file.info.includes('browser') && !isShape(file.code) && !definesReader(file.code)).length).toBeGreaterThan(5)
	})

	it('type-checks every example against the package', () => {
		const program = ts.createProgram(files.map(file => file.path), {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			strict: true,
			noEmit: true,
			skipLibCheck: true,
			types: ['node'],
			typeRoots: [join(root, 'src/@types'), join(root, 'node_modules/@types')],
			baseUrl: root,
			paths: { 'src/*': ['src/*'] },
		})
		const examplePaths = new Set(files.map(file => resolve(file.path).toLowerCase()))
		const errors = ts.getPreEmitDiagnostics(program)
			.filter(diagnostic => diagnostic.file !== undefined && examplePaths.has(resolve(diagnostic.file.fileName).toLowerCase()))
			.map(diagnostic => {
				const block = files.find(file => resolve(file.path).toLowerCase() === resolve(diagnostic.file!.fileName).toLowerCase())!
				const { line } = diagnostic.file!.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
				return `README block ${block.index}, line ${line + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`
			})
		expect(errors).toEqual([])
	}, 120_000)

	it('runs every Node example on a song folder', async () => {
		writeFixtureSong()
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
		try {
			for (const file of files) {
				if (file.info.includes('browser') || isShape(file.code) || definesReader(file.code)) continue
				log.mockClear()
				await import(pathToFileURL(file.path).href)
				// Every example that prints should have printed something.
				if (file.code.includes('console.log')) expect(log, `README block ${file.index}`).toHaveBeenCalled()
			}
		} finally {
			log.mockRestore()
		}
		const edited = readFileSync(join(songs, 'Example Song (edited)', 'song.ini'), 'utf8')
		expect(edited).toContain('genre = Rock')
		expect(readFileSync(join(songs, 'Example Song (edited)', 'song.ogg'), 'utf8')).toBe('not really audio')
	}, 120_000)
})
