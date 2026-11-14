// Generates the scan-chart API reference: TypeDoc writes a Markdown page for each exported name (options in
// typedoc.json), and this module turns those pages into Mintlify pages and lists them in docs/docs.json.
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'

import { format, resolveConfig } from 'prettier'

export const repositoryRoot = resolve(__dirname, '../..')
/** The folder of the generated pages, and the docs.json path of each page, relative to `docs/`. */
export const apiFolder = join(repositoryRoot, 'docs/scan-chart/api')
const apiRoute = 'scan-chart/api'
export const docsJsonPath = join(repositoryRoot, 'docs/docs.json')
const docsTab = 'scan-chart'

/** TypeDoc's folder for each entry point, in sidebar order, with the sidebar group of its pages. */
const entryPoints = [
	{ folder: 'index', group: 'scan-chart API' },
	{ folder: 'competitive', group: 'scan-chart/competitive API' },
]
/** TypeDoc's folders for each kind of export, in sidebar order, with the sidebar group of their pages. */
const kinds = [
	{ group: 'Functions', folders: ['functions'] },
	{ group: 'Types', folders: ['interfaces', 'type-aliases'] },
	{ group: 'Classes', folders: ['classes'] },
	{ group: 'Variables', folders: ['variables'] },
]

export interface NavigationGroup {
	readonly group: string
	readonly pages: readonly (string | NavigationGroup)[]
}

/** The generated reference: each page's contents by its path relative to the API folder, and the sidebar groups. */
export interface ApiReference {
	readonly pages: ReadonlyMap<string, string>
	readonly navigation: readonly NavigationGroup[]
}

export async function generateApiReference(): Promise<ApiReference> {
	const typedocOutput = await mkdtemp(join(tmpdir(), 'scan-chart-typedoc-'))
	try {
		const typedoc = spawnSync(process.execPath, [join(repositoryRoot, 'node_modules/typedoc/bin/typedoc'), '--out', typedocOutput], {
			cwd: repositoryRoot,
			encoding: 'utf8',
		})
		if (typedoc.status !== 0) throw new Error(`TypeDoc failed:\n${typedoc.stdout}${typedoc.stderr}`)
		return await convertTypedocOutput(typedocOutput)
	} finally {
		await rm(typedocOutput, { recursive: true, force: true })
	}
}

async function convertTypedocOutput(typedocOutput: string): Promise<ApiReference> {
	const files = (await readdir(typedocOutput, { recursive: true, withFileTypes: true }))
		.filter(entry => entry.isFile())
		.map(entry => posix.join(...join(entry.parentPath, entry.name).slice(typedocOutput.length + 1).split(/[\\/]/)))
	const pages = new Map<string, string>()
	const navigation: NavigationGroup[] = []
	for (const entryPoint of entryPoints) {
		const groups: NavigationGroup[] = []
		for (const kind of kinds) {
			const kindPages = files
				.filter(file => kind.folders.some(folder => file.startsWith(`${entryPoint.folder}/${folder}/`)))
				.sort((a, b) => posix.basename(a).toLowerCase().localeCompare(posix.basename(b).toLowerCase(), 'en'))
			for (const file of kindPages) pages.set(file, toMintlifyPage(file, await readFile(join(typedocOutput, file), 'utf8')))
			if (kindPages.length > 0) groups.push({ group: kind.group, pages: kindPages.map(file => `${apiRoute}/${file.replace(/\.mdx$/, '')}`) })
		}
		navigation.push({ group: entryPoint.group, pages: groups })
	}
	// The README pages index each entry point's exports, which the sidebar already lists.
	const unexpected = files.filter(file => !pages.has(file) && posix.basename(file) !== 'README.mdx')
	if (unexpected.length > 0) throw new Error(`TypeDoc wrote pages of a kind the sidebar doesn't list: ${unexpected.join(', ')}`)
	return { pages, navigation }
}

/**
 * Moves the page's heading into Mintlify front matter, and makes its links Mintlify routes. Doc comments keep the
 * line endings of the source checkout, so the page is converted to LF line endings to be the same on every checkout.
 */
function toMintlifyPage(file: string, typedocPage: string): string {
	const markdown = typedocPage.replace(/\r\n/g, '\n')
	const heading = /^# (.+)\n\n/.exec(markdown)
	if (!heading) throw new Error(`${file}: TypeDoc's page doesn't start with a heading`)
	const title = heading[1].replace(/\\(.)/g, '$1')
	const body = markdown
		.slice(heading[0].length)
		.replace(/\]\(([^)\s:]+)\.mdx(#[^)\s]*)?\)/g, (_link, target: string, anchor = '') =>
			`](/${posix.join(apiRoute, posix.dirname(file), target)}${anchor})`)
	return `---\ntitle: ${JSON.stringify(title)}\n---\n\n${body}`
}

/** Returns docs.json with the scan-chart tab's API groups replaced by `navigation`, keeping its other groups. */
export async function withApiNavigation(docsJson: string, navigation: readonly NavigationGroup[]): Promise<string> {
	const docs = JSON.parse(docsJson) as { navigation: { tabs: { tab: string; groups: NavigationGroup[] }[] } }
	const tab = docs.navigation.tabs.find(candidate => candidate.tab === docsTab)
	if (!tab) throw new Error(`docs.json has no ${docsTab} tab`)
	tab.groups = [...tab.groups.filter(group => !firstPage(group).startsWith(`${apiRoute}/`)), ...navigation]
	return format(JSON.stringify(docs, null, '\t'), { ...(await resolveConfig(docsJsonPath)), filepath: docsJsonPath })
}

function firstPage(group: NavigationGroup): string {
	const page = group.pages[0]
	return page === undefined ? '' : typeof page === 'string' ? page : firstPage(page)
}

/** Writes the reference into the docs site, replacing the previous pages. */
export async function writeApiReference(reference: ApiReference): Promise<void> {
	await rm(apiFolder, { recursive: true, force: true })
	for (const [file, contents] of reference.pages) {
		await mkdir(dirname(join(apiFolder, file)), { recursive: true })
		await writeFile(join(apiFolder, file), contents)
	}
	await writeFile(docsJsonPath, await withApiNavigation(await readFile(docsJsonPath, 'utf8'), reference.navigation))
}
