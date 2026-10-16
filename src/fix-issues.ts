import { contentType, readAudioInfo } from './assets/media-headers'
import { scanAudio } from './assets/scan-audio'
import { imageSize } from './assets/scan-image'
import { contentNames, hasContentExtension } from './assets/scan-media'
import { fixEmptyPhrases, fixEmptyTracks, fixHopoTags, fixMultiplierNote, fixSustains } from './fix-chart'
import { ignoredIssueCodes, keyList } from './ini/ini-checks'
import { asUtf8Ini, rewriteSongIni, songIniRepeats } from './ini/ini-edit'
import { isBooleanTag, isNumberTag, newerTag, olderTags } from './ini/metadata'
import { IniTokens, parseIniTokens } from './ini/parse-ini'
import { chooseEdits, FixRecord, hashChanges, hashNames, IniFixSubject, issueFixTable } from './issue-fixes'
import type { Issue, IssueCode, MetadataFinding } from './issues'
import { scanSong, songIniFindings } from './scan-song-folder'
import { getBasename, hasCrowdOrPreviewName } from './shared/file-names'
import { trimDotnet } from './shared/text'
import { songContext } from './song-context'
import { continueEdits, SongDocument, withSongIni } from './song-document'
import { readFileBytes, readRange, type SongFile } from './song-files'
import { songHashes } from './song-save'

/** What `fixIssues` fixes, and how. */
export interface FixOptions {
	/** Only these codes. Default: every code in `issueFixes`. */
	readonly codes?: readonly IssueCode[]
	/** Also make the fixes that change a canonical hash. Default: `false`. */
	readonly changeHashes?: boolean
	/** The gap the sustain gap fix leaves before the next note, in milliseconds. Default: 60, the charting guidelines'. */
	readonly sustainGapMs?: number
	/** The shortest sustain the short sustain fix keeps, in milliseconds. Default: 200, the charting guidelines'. */
	readonly minSustainMs?: number
	/** The album art sizes accepted, as in `ScanOptions`: square art of another size is resized to the first. Default: `[512]`. */
	readonly albumArtSizes?: readonly number[]
	/**
	 * Resizes an image to a square of `size` pixels, and returns it in the format and quality the caller chooses, PNG or
	 * JPEG. scan-chart has no image codec: without it, album art isn't resized.
	 */
	readonly resizeImage?: (image: Uint8Array, size: number) => Promise<Uint8Array>
}

/** What `fixIssues` did. The hashes are the canonical ones, keyed as `canonical:guitar:expert` and `canonical:song`. */
export interface FixReport {
	/** Each fix made: the code of the issue it fixes, the file it changes, and what it does. */
	readonly fixed: readonly { readonly code: IssueCode; readonly file: string; readonly description: string }[]
	/** Each issue found that wasn't fixed, and why. */
	readonly skipped: readonly { readonly code: IssueCode; readonly file: string | null; readonly reason: string }[]
	/** Files renamed. Writing the song back to its folder, remove each `from` file. */
	readonly renamed: readonly { readonly from: string; readonly to: string }[]
	/** Each hash the fixes changed, with its value before and after, or `null` where the song had or has no such hash. */
	readonly hashes: readonly { readonly key: string; readonly before: string | null; readonly after: string | null }[]
}

/**
 * Fixes the song's issues that `issueFixes` lists and returns the fixed song with a report, leaving `song` as it was.
 * A fix is made only where a scan reports its issue, and not for a code song.ini's `ignored_issues` lists. Save the
 * fixed song like any other.
 */
export async function fixIssues(song: SongDocument, options: FixOptions = {}): Promise<{ readonly song: SongDocument; readonly report: FixReport }> {
	const asked = options.codes ?? (Object.keys(issueFixTable) as IssueCode[])
	const scanned = await scanSong(song, { styleNotes: true, mediaIssues: asked.some(code => issueFixTable[code]?.media), albumArtSizes: options.albumArtSizes })
	const context = songContext(song)
	const ignored = context.ini.songSection === null ? new Set<IssueCode>() : ignoredIssueCodes(context.ini.songSection).codes
	const skipped: FixReport['skipped'][number][] = []
	const record: FixRecord = {
		fixed: [],
		renamed: [],
		skip: (code, file, reason) => {
			if (!skipped.some(entry => entry.code === code && entry.file === file && entry.reason === reason)) skipped.push({ code, file, reason })
		},
	}
	/** Whether a code's fix is asked for and made with these options. */
	const makes = (code: IssueCode) => {
		const fix = issueFixTable[code]
		return fix !== undefined && asked.includes(code) && !ignored.has(code) && (fix.hashes !== 'changesHashes' || options.changeHashes === true)
	}
	for (const issue of [...scanned.ignoredIssues, ...scanned.issues]) {
		if (!asked.includes(issue.code) || makes(issue.code)) continue
		record.skip(issue.code, issue.file, issueFixTable[issue.code] === undefined ? 'fixIssues has no fix for it.'
			: ignored.has(issue.code) ? 'song.ini\'s "ignored_issues" lists it.'
			: 'Its fix changes a canonical hash: fix it with changeHashes.')
	}
	const issues = scanned.issues.filter(issue => makes(issue.code))
	const findings = songIniFindings(song, context, scanned.stats, { styleNotes: true })

	let fixed = fixMultiplierNote(fixHopoTags(song, issues, findings, record), issues, findings, record)
	fixed = fixSustains(fixed, issues, { gapMs: options.sustainGapMs ?? 60, minMs: options.minSustainMs ?? 200, removeShort: makes('babySustain') }, record)
	fixed = fixEmptyTracks(fixEmptyPhrases(fixed, issues, record), issues, record)
	const songLength = issues.some(issue => issue.code === 'missingSongLength' || issue.code === 'songLengthMismatch') ? await longestAudio(song.files) : null
	let rewritten = fixSongIni(fixed, new Set(issues.map(issue => issue.code)), findings, songLength, options, record)
	// A song.ini fix can leave another line changing nothing, such as five_lane_drums = False once pro_drums is gone,
	// so song.ini is checked again, twice at most.
	for (let round = 0; round < 2 && rewritten !== fixed; round++) {
		const again = songIniFindings(rewritten, songContext(rewritten), scanned.stats, { styleNotes: true }).filter(finding => makes(finding.metadataIssue))
		const next = fixSongIni(rewritten, new Set(again.map(finding => finding.metadataIssue)), again, null, options, record)
		if (next === rewritten) break
		rewritten = next
	}
	fixed = await fixFiles(rewritten, issues, options, record)
	return { song: fixed, report: { fixed: record.fixed, skipped, renamed: record.renamed, hashes: hashChanges(songHashes(song), songHashes(fixed)) } }
}

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

/** One song.ini change, which fixes one tag's issue, or lays out or orders the file. */
interface IniFix extends IniFixSubject {
	readonly code: IssueCode
	readonly layout?: true
	readonly order?: true
	readonly remove?: readonly string[]
	readonly set?: readonly (readonly [key: string, value: string])[]
}

/**
 * Rewrites song.ini for the reported codes. A change that would change a canonical hash isn't made, unless its code's
 * fix may change hashes and `changeHashes` is set.
 */
function fixSongIni(
	song: SongDocument,
	reported: ReadonlySet<IssueCode>,
	findings: readonly MetadataFinding[],
	songLength: { ms: number } | { reason: string } | null,
	options: FixOptions,
	record: FixRecord,
): SongDocument {
	const codes = new Set([...reported].filter(code => issueFixTable[code]?.steps.includes('songIni')))
	const ini = song.ini
	if (codes.size === 0 || ini === null) return song
	let tokens: IniTokens
	try {
		tokens = asUtf8Ini(ini.tokens)
	} catch {
		for (const code of codes) record.skip(code, ini.fileName, 'song.ini can\'t be decoded, so it can\'t be rewritten.')
		return song
	}
	const songSection = parseIniTokens(tokens).iniObject.song ?? {}
	const keysOf = (code: IssueCode) => codes.has(code) ? findings.filter(finding => finding.metadataIssue === code).flatMap(finding => finding.keys ?? []) : []

	const fixes: IniFix[] = []
	if (codes.has('iniLayout')) fixes.push({ code: 'iniLayout', subject: 'the layout', layout: true })
	if (codes.has('iniTagOrder')) fixes.push({ code: 'iniTagOrder', subject: 'the tag order', order: true })
	for (const code of ['blankIniValue', 'blankIniNumber', 'defaultIniValue', 'redundantDrumType'] as const) {
		for (const key of keysOf(code)) fixes.push({ code, subject: code === 'defaultIniValue' ? `${key} = ${songSection[key]}` : key, remove: [key] })
	}
	// Games read an older name, such as frets, only without a line of its tag, so a blank one goes only with it.
	for (const [key, older] of olderTags) {
		const blank = fixes.find(fix => fix.remove?.includes(key))
		if (blank === undefined || songSection[older] === undefined || fixes.some(fix => fix.remove?.includes(older))) continue
		fixes.splice(fixes.indexOf(blank), 1)
		record.skip(blank.code, ini.fileName, `Removing "${key}" would make games read "${older}" instead: remove "${older}" too.`)
	}
	for (const key of keysOf('quotedIniValue')) {
		const unquoted = trimDotnet(songSection[key].slice(1, -1))
		// Games read a quoted number or boolean as not set, so unquoting it would change what they read.
		if (unquoted !== '' && (isNumberTag(key) || isBooleanTag(key))) {
			record.skip('quotedIniValue', ini.fileName, `Games read the default for a quoted number or true/false value: write the value you mean for "${key}" without quotes.`)
			continue
		}
		fixes.push({ code: 'quotedIniValue', subject: key, ...unquoted === '' ? { remove: [key] } : { set: [[key, unquoted]] } })
	}
	if (codes.has('iconName')) {
		const icon = songSection.icon
		const name = icon.replace(/\.[a-z0-9]+$/i, '').toLowerCase()
		if (/^[a-z0-9_-]+$/.test(name)) fixes.push({ code: 'iconName', subject: 'icon', value: name, set: [['icon', name]] })
		else record.skip('iconName', ini.fileName, `Without its extension and in lowercase, "${icon}" has other characters than a-z, 0-9, "-" and "_": choose an icon name.`)
	}
	for (const key of keysOf('deprecatedIniTag')) {
		const newer = newerTag(key)
		// A chart fix may have removed it already, as the star power fix removes star_power_note.
		if (newer !== undefined && songSection[key] !== undefined) fixes.push({ code: 'deprecatedIniTag', subject: key, value: newer, set: [[newer, songSection[key]]], remove: [key] })
		else if (key === 'delay') record.skip('deprecatedIniTag', ini.fileName, 'Removing "delay" moves every note against the audio: the audio or the notes have to change first.')
	}
	for (const code of ['missingSongLength', 'songLengthMismatch'] as const) {
		if (!codes.has(code) || songLength === null) continue
		if ('ms' in songLength) fixes.push({ code, subject: 'song_length', value: String(songLength.ms), set: [['song_length', String(songLength.ms)]] })
		else record.skip(code, ini.fileName, songLength.reason)
	}
	if (fixes.length === 0) return song

	const before = songHashes(song)
	const apply = (chosen: readonly IniFix[]) => continueEdits(song, withSongIni(song, rewriteSongIni(tokens, {
		layout: chosen.some(fix => fix.layout === true),
		order: chosen.some(fix => fix.order === true),
		remove: new Set(chosen.flatMap(fix => fix.remove ?? [])),
		set: new Map(chosen.flatMap(fix => fix.set ?? [])),
	})))
	const mayChange = (fix: IniFix) => issueFixTable[fix.code]!.hashes !== 'keepsHashes'
	const changedAlone = new Map<IniFix, readonly string[]>()
	const changesOf = (fix: IniFix) => {
		let keys = changedAlone.get(fix)
		if (keys === undefined) changedAlone.set(fix, keys = hashChanges(before, songHashes(apply([fix]))).map(change => change.key))
		return keys
	}
	// With changeHashes, the fixes that may change hashes may change the ones each changes alone.
	const problem = (edited: SongDocument, chosen: readonly IniFix[]) => {
		const changes = hashChanges(before, songHashes(edited))
		const allowed = new Set(options.changeHashes ? chosen.filter(mayChange).flatMap(changesOf) : [])
		return changes.every(change => allowed.has(change.key)) ? null : `would change ${hashNames(changes)}`
	}
	const { song: rewritten, chosen } = chooseEdits(song, fixes, apply, problem, (fix, problem) => record.skip(fix.code, ini.fileName, mayChange(fix)
		? `Fixing "${fix.subject}" ${problem}: fix it with changeHashes.`
		: `Fixing "${fix.subject}" ${problem}, so games would read the song differently.`))

	// A rewrite of the whole file merges [song] sections, and keeps only the line Clone Hero reads of a repeated tag.
	const repeats = songIniRepeats(tokens)
	const merged = [...repeats.sections > 1 ? [`merged its ${repeats.sections} "[song]" sections`] : [],
		...repeats.keys.length > 0 ? [`kept only the last line of ${keyList(repeats.keys)}, the one Clone Hero reads`] : []]
	const rewrites = chosen.find(fix => fix.layout === true) ?? chosen.find(fix => fix.order === true)
	for (const code of Object.keys(issueFixTable) as IssueCode[]) {
		const ofCode = chosen.filter(fix => fix.code === code)
		if (ofCode.length === 0) continue
		const also = merged.length > 0 && rewrites?.code === code ? ` It also ${merged.join(' and ')}.` : ''
		record.fixed.push({ code, file: ini.fileName, description: issueFixTable[code]!.describe!(ofCode) + also })
	}
	return rewritten
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
