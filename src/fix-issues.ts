import { contentType, readAudioInfo } from './assets/media-headers'
import { scanAudio } from './assets/scan-audio'
import { imageSize } from './assets/scan-image'
import { contentNames, hasContentExtension } from './assets/scan-media'
import { keyList, standardTagOrder } from './ini/ini-checks'
import { asUtf8Ini, rewriteSongIni } from './ini/ini-edit'
import { IniTokens, parseIniTokens } from './ini/parse-ini'
import { fixEmptyPhrases, fixEmptyTracks } from './fix-chart'
import { FixRecord, FixReport, hashChanges, hashNames } from './fix-report'
import type { Issue, IssueCode, MetadataFinding } from './issues'
import { scanSong } from './scan-song-folder'
import { getBasename, hasCrowdOrPreviewName } from './shared/file-names'
import { trimDotnet } from './shared/text'
import { songContext } from './song-context'
import { continueEdits, SongDocument, withSongIni } from './song-document'
import { readFileBytes, readRange, type SongFile } from './song-files'
import { songHashes } from './song-save'

/**
 * For each issue code `fixIssues` can fix, whether its fix keeps the canonical hashes or changes them. A fix that keeps
 * them is made by default. Where a song needs one that would change a hash after all, such as unquoting a song name,
 * which the SongHash reads, it waits for `changeHashes`; where a fix meant to read alike would change one, it's wrong
 * for that song, and isn't made.
 */
export const issueFixes: { readonly [code in IssueCode]?: 'keepsHashes' | 'changesHashes' } = {
	fileNameCase: 'keepsHashes',
	extensionMismatch: 'keepsHashes',
	albumArtSize: 'keepsHashes',
	iniLayout: 'keepsHashes',
	iniTagOrder: 'keepsHashes',
	blankIniValue: 'keepsHashes',
	blankIniNumber: 'keepsHashes',
	quotedIniValue: 'keepsHashes',
	defaultIniValue: 'keepsHashes',
	iconName: 'keepsHashes',
	deprecatedIniTag: 'keepsHashes',
	redundantDrumType: 'keepsHashes',
	missingSongLength: 'keepsHashes',
	songLengthMismatch: 'keepsHashes',
	emptyTrack: 'keepsHashes',
	emptyStarPower: 'keepsHashes',
	emptySoloSection: 'keepsHashes',
	emptyFlexLane: 'keepsHashes',
}

export type { FixReport } from './fix-report'

/** What `fixIssues` fixes, and how. */
export interface FixOptions {
	/** Only these codes. Default: every code in `issueFixes`. */
	readonly codes?: readonly IssueCode[]
	/** Also make the fixes that change a canonical hash. Default: `false`. */
	readonly changeHashes?: boolean
	/** The album art sizes accepted, as `ScanOptions.albumArtSizes` says: square art of another size is resized to the first. Default: `[512]`. */
	readonly albumArtSizes?: readonly number[]
	/**
	 * Resizes an image to a square of `size` pixels, and returns it in the format and quality the caller chooses, PNG or
	 * JPEG. scan-chart has no image codec: without it, album art isn't resized.
	 */
	readonly resizeImage?: (image: Uint8Array, size: number) => Promise<Uint8Array>
}

/**
 * Fixes the song's issues that `issueFixes` lists, found by scanning it, and returns the fixed song with a report,
 * leaving `song` as it was. A fix is made only where its issue is reported, and not where song.ini's `ignored_issues`
 * lists its code. Save the fixed song like any other: `serializeSong` keeps every hash the fixes didn't change.
 */
export async function fixIssues(song: SongDocument, options: FixOptions = {}): Promise<{ readonly song: SongDocument; readonly report: FixReport }> {
	const asked = options.codes ?? (Object.keys(issueFixes) as IssueCode[])
	const { scanned, iniFindings } = await scanSong(song, {
		styleNotes: true,
		mediaIssues: asked.some(code => mediaCodes.includes(code)),
		albumArtSizes: options.albumArtSizes,
	})
	const skipped: FixReport['skipped'][number][] = []
	const record: FixRecord = {
		fixed: [],
		renamed: [],
		removed: [],
		skip: (code, file, reason) => {
			if (!skipped.some(entry => entry.code === code && entry.file === file && entry.reason === reason)) skipped.push({ code, file, reason })
		},
	}
	for (const issue of scanned.ignoredIssues) {
		if (asked.includes(issue.code) && issueFixes[issue.code] !== undefined) record.skip(issue.code, issue.file, 'song.ini\'s "ignored_issues" lists it.')
	}
	const issues = scanned.issues.filter(issue => {
		if (!asked.includes(issue.code)) return false
		const fix = issueFixes[issue.code]
		if (fix === undefined) record.skip(issue.code, issue.file, 'fixIssues has no fix for it.')
		else if (fix === 'changesHashes' && !options.changeHashes) record.skip(issue.code, issue.file, 'Its fix changes a canonical hash: fix it with changeHashes.')
		return fix === 'keepsHashes' || (fix === 'changesHashes' && options.changeHashes)
	})

	const songLength = issues.some(issue => issue.code === 'missingSongLength' || issue.code === 'songLengthMismatch') ? await longestAudio(song.files) : null
	const charted = fixEmptyTracks(fixEmptyPhrases(song, issues, record), issues, record)
	const fixed = await fixFiles(fixSongIni(charted, issues, iniFindings, songLength, options, record), issues, options, record)
	return {
		song: fixed,
		report: { fixed: record.fixed, skipped, renamed: record.renamed, removed: record.removed, hashes: hashChanges(songHashes(song), songHashes(fixed)) },
	}
}

/** The codes whose issues only a scan that reads the media files finds. */
const mediaCodes: readonly IssueCode[] = ['songLengthMismatch', 'extensionMismatch', 'albumArtSize']

/**
 * The length of the longest audio file, not counting crowd or preview audio, in whole milliseconds, read from the
 * files' headers as the song_length check reads it, or why it can't be read.
 */
async function longestAudio(files: readonly SongFile[]): Promise<{ ms: number } | { reason: string }> {
	const stems = scanAudio(files).stemFiles.filter(file => !hasCrowdOrPreviewName(file.fileName))
	if (stems.length === 0) return { reason: 'The song has no audio file to measure.' }
	let longest = 0
	for (const file of stems) {
		const info = await readAudioInfo(file)
		if (info === null) return { reason: `The length of "${file.fileName}" can't be read from its headers.` }
		longest = Math.max(longest, info.durationMs)
	}
	return { ms: Math.round(longest) }
}

/** One change to song.ini, which fixes one issue for one tag, or lays out or orders the file. */
interface IniFix {
	readonly code: IssueCode
	/** The tag or line it's about, for the report, such as `delay = 0`. */
	readonly subject: string
	readonly layout?: true
	readonly order?: true
	readonly remove?: readonly string[]
	readonly set?: readonly (readonly [key: string, value: string])[]
	/** Whether games read the song alike after it. A fix that does and changes a hash anyway is wrong for this song. */
	readonly readsAlike: boolean
}

const iniCodes: readonly IssueCode[] = [
	'iniLayout', 'iniTagOrder', 'blankIniValue', 'blankIniNumber', 'quotedIniValue', 'defaultIniValue', 'iconName', 'deprecatedIniTag', 'redundantDrumType',
	'missingSongLength', 'songLengthMismatch',
]

/**
 * Rewrites song.ini for its issues, as `rewriteSongIni` writes it: its layout and tag order, and its values. Every
 * change is checked against the canonical hashes: one that changes a hash is left out, unless it's meant to change how
 * games read the song and `changeHashes` is set. `songLength` is the longest audio file's, when an issue asks for it.
 */
function fixSongIni(
	song: SongDocument,
	issues: readonly Issue[],
	findings: readonly MetadataFinding[],
	songLength: { ms: number } | { reason: string } | null,
	options: FixOptions,
	record: FixRecord,
): SongDocument {
	const found = issues.filter(issue => issue.scope === 'metadata' && iniCodes.includes(issue.code))
	const ini = song.ini
	if (found.length === 0 || ini === null) return song
	let tokens: IniTokens
	try {
		tokens = asUtf8Ini(ini.tokens)
	} catch {
		for (const issue of found) record.skip(issue.code, ini.fileName, 'song.ini can\'t be decoded, so it can\'t be rewritten.')
		return song
	}
	const songSection = parseIniTokens(tokens).iniObject.song ?? {}
	const codes = new Set(found.map(issue => issue.code))
	const keysOf = (code: IssueCode) => codes.has(code) ? findings.filter(finding => finding.metadataIssue === code).flatMap(finding => finding.keys ?? []) : []

	const fixes: IniFix[] = []
	if (codes.has('iniLayout')) fixes.push({ code: 'iniLayout', subject: '', layout: true, readsAlike: true })
	if (codes.has('iniTagOrder')) fixes.push({ code: 'iniTagOrder', subject: '', order: true, readsAlike: true })
	for (const code of ['blankIniValue', 'blankIniNumber', 'defaultIniValue', 'redundantDrumType'] as const) {
		for (const key of keysOf(code)) fixes.push({ code, subject: code === 'defaultIniValue' ? `${key} = ${songSection[key]}` : key, remove: [key], readsAlike: true })
	}
	for (const key of keysOf('quotedIniValue')) {
		const unquoted = trimDotnet(songSection[key].slice(1, -1))
		fixes.push({ code: 'quotedIniValue', subject: key, ...unquoted === '' ? { remove: [key] } : { set: [[key, unquoted]] }, readsAlike: false })
	}
	if (codes.has('iconName')) {
		const icon = songSection.icon
		const name = icon.replace(/\.[a-z0-9]+$/i, '').toLowerCase()
		if (/^[a-z0-9_-]+$/.test(name)) fixes.push({ code: 'iconName', subject: 'icon', set: [['icon', name]], readsAlike: false })
		else record.skip('iconName', ini.fileName, `Without its extension and in lowercase, "${icon}" has other characters than a-z, 0-9, "-" and "_": choose an icon name.`)
	}
	for (const key of keysOf('deprecatedIniTag')) {
		const newer = key === 'frets' ? 'charter' : key === 'track' ? 'album_track' : null
		if (newer !== null) fixes.push({ code: 'deprecatedIniTag', subject: key, set: [[newer, songSection[key]]], remove: [key], readsAlike: true })
		else if (key === 'delay') record.skip('deprecatedIniTag', ini.fileName, 'Removing "delay" moves every note against the audio: the audio or the notes have to change first.')
	}
	for (const code of ['missingSongLength', 'songLengthMismatch'] as const) {
		if (!codes.has(code) || songLength === null) continue
		if ('ms' in songLength) fixes.push({ code, subject: 'song_length', set: [['song_length', String(songLength.ms)]], readsAlike: false })
		else record.skip(code, ini.fileName, songLength.reason)
	}
	if (fixes.length === 0) return song

	const before = songHashes(song)
	const apply = (chosen: readonly IniFix[]) => continueEdits(song, withSongIni(song, rewriteSongIni(tokens, {
		layout: chosen.some(fix => fix.layout),
		order: chosen.some(fix => fix.order) ? standardTagOrder : null,
		remove: new Set(chosen.flatMap(fix => fix.remove ?? [])),
		set: new Map(chosen.flatMap(fix => fix.set ?? [])),
	})))
	let chosen: readonly IniFix[] = fixes
	let fixed = apply(chosen)
	if (hashChanges(before, songHashes(fixed)).length > 0) {
		chosen = fixes.filter(fix => {
			const changes = hashChanges(before, songHashes(apply([fix])))
			if (changes.length === 0 || (!fix.readsAlike && options.changeHashes)) return true
			record.skip(fix.code, ini.fileName, fix.readsAlike
				? `Fixing "${fix.subject}" would change ${hashNames(changes)}, so games would read the song differently.`
				: `Fixing "${fix.subject}" changes ${hashNames(changes)}: fix it with changeHashes.`)
			return false
		})
		fixed = apply(chosen)
		const changes = hashChanges(before, songHashes(fixed))
		if (changes.length > 0 && !options.changeHashes) {
			// Fixes that each keep the hashes change one together: only the layout and the order are left.
			for (const fix of chosen.filter(fix => !fix.layout && !fix.order)) record.skip(fix.code, ini.fileName, `With the other fixes, fixing "${fix.subject}" would change ${hashNames(changes)}.`)
			chosen = chosen.filter(fix => fix.layout || fix.order)
			fixed = chosen.length === 0 ? song : apply(chosen)
		}
	}
	for (const code of iniCodes) {
		const ofCode = chosen.filter(fix => fix.code === code)
		if (ofCode.length > 0) record.fixed.push({ code, file: ini.fileName, description: iniFixDescription(code, ofCode) })
	}
	return fixed
}

function iniFixDescription(code: IssueCode, fixes: readonly IniFix[]): string {
	const list = keyList(fixes.map(fix => fix.subject))
	const was = fixes.length === 1 ? 'was' : 'were'
	switch (code) {
		case 'iniLayout': return 'Wrote "[song]" first, comments with ";", and the lines games don\'t read as comments.'
		case 'iniTagOrder': return 'Put the tags in the standard order.'
		case 'blankIniValue': return `Removed ${list}, which ${was} blank or -1.`
		case 'blankIniNumber': return `Removed ${list}, which ${was} blank.`
		case 'quotedIniValue': return `Removed the quotes around ${list}.`
		case 'defaultIniValue': return `Removed ${list}, which changed nothing.`
		case 'iconName': return `Changed "icon" to "${fixes[0].set![0][1]}".`
		case 'deprecatedIniTag': return `Renamed ${fixes.map(fix => `"${fix.subject}" to "${fix.set![0][0]}"`).join(' and ')}.`
		case 'missingSongLength':
		case 'songLengthMismatch': return `Set "song_length" to ${fixes[0].set![0][1]}, the length of the longest audio file in milliseconds.`
		default: return `Removed ${list}, which games read the drums the same without.`
	}
}

/** What the file fixes do to one file: its new name, its new bytes, and the issues they fix. */
interface FilePlan {
	name: string
	data?: Uint8Array
	readonly fixes: { code: IssueCode; description: string }[]
}

/**
 * Renames a file named in another letter case (`fileNameCase`) or with an extension that doesn't match its content
 * (`extensionMismatch`), and resizes square album art with `resizeImage` (`albumArtSize`), keeping its name unless the
 * resized image's format differs. A file isn't renamed to another file's name, or when song.ini names it.
 */
async function fixFiles(song: SongDocument, issues: readonly Issue[], options: FixOptions, record: FixRecord): Promise<SongDocument> {
	const found = issues.filter(issue => issue.scope === 'folder' && issue.file !== null
		&& (issue.code === 'fileNameCase' || issue.code === 'extensionMismatch' || issue.code === 'albumArtSize'))
	if (found.length === 0) return song
	const plans = new Map<string, FilePlan>()
	const planOf = (file: string) => {
		let plan = plans.get(file)
		if (plan === undefined) plans.set(file, plan = { name: file, fixes: [] })
		return plan
	}
	const fileOf = (name: string) => song.files.find(file => file.fileName === name)!
	const songSection = songContext(song).ini.songSection
	/** Why a file can't take a new name, or `null` when it can. */
	const renameProblem = (from: string, to: string) => {
		const key = ['background', 'video', 'cover'].find(key => songSection?.[key]?.toLowerCase() === from.toLowerCase())
		if (key !== undefined) return `song.ini's "${key}" names it.`
		const taken = song.files.find(file => file.fileName !== from && (plans.get(file.fileName)?.name ?? file.fileName).toLowerCase() === to.toLowerCase())
		return taken === undefined ? null : `"${taken.fileName}" already has the name "${to}".`
	}

	// A name's letter case first, then its extension.
	for (const issue of [...found.filter(issue => issue.code === 'fileNameCase'), ...found.filter(issue => issue.code === 'extensionMismatch')]) {
		const from = issue.file!
		const plan = planOf(from)
		let to = plan.name
		if (issue.code === 'fileNameCase') {
			to = to.toLowerCase()
		} else {
			const content = contentType(await readRange(fileOf(from), 0, 64))
			const extension = content === null ? null : contentNames[content].extension
			if (content === null || extension === null) {
				record.skip(issue.code, from, `Games don't read ${content === null ? 'its content' : contentNames[content].name} in a file of this kind: convert it.`)
				continue
			}
			to = `${getBasename(to)}.${extension}`
		}
		const problem = renameProblem(from, to)
		if (problem !== null) {
			record.skip(issue.code, from, problem)
			continue
		}
		plan.fixes.push({ code: issue.code, description: `Renamed "${plan.name}" to "${to}".` })
		plan.name = to
	}

	const sizes = options.albumArtSizes ?? [512]
	for (const issue of found.filter(issue => issue.code === 'albumArtSize')) {
		const from = issue.file!
		const image = await readFileBytes(fileOf(from))
		const size = imageSize(image)
		const skip = (reason: string) => record.skip('albumArtSize', from, reason)
		if (size === null || size.width !== size.height) {
			skip(size === null ? 'The album art can\'t be decoded.' : `The album art is ${size.width}x${size.height}: making it square needs it cropped.`)
			continue
		}
		if (options.resizeImage === undefined) {
			skip('Resizing album art needs resizeImage.')
			continue
		}
		const side = sizes[0]
		const resized = await options.resizeImage(image, side)
		const resizedSize = imageSize(resized)
		const content = contentType(resized.subarray(0, 64))
		if (resizedSize === null || resizedSize.width !== side || resizedSize.height !== side || (content !== 'png' && content !== 'jpeg')) {
			skip(`resizeImage didn't return a ${side}x${side} PNG or JPEG image.`)
			continue
		}
		const plan = planOf(from)
		const to = hasContentExtension(plan.name, content) ? plan.name : `${getBasename(plan.name)}.${contentNames[content].extension}`
		const problem = to === plan.name ? null : renameProblem(from, to)
		if (problem !== null) {
			skip(`resizeImage returned ${contentNames[content].name}, and ${problem}`)
			continue
		}
		plan.name = to
		plan.data = resized
		plan.fixes.push({ code: 'albumArtSize', description: `Resized "${from}" from ${size.width}x${size.height} to ${side}x${side}${to === from ? '' : `, as "${to}"`}.` })
	}

	const files = song.files.map(file => {
		const plan = plans.get(file.fileName)
		if (plan === undefined) return file
		for (const { code, description } of plan.fixes) record.fixed.push({ code, file: plan.name, description })
		if (plan.name !== file.fileName) record.renamed.push({ from: file.fileName, to: plan.name })
		return { fileName: plan.name, data: plan.data ?? file.data }
	})
	return continueEdits(song, { ...song, files })
}
