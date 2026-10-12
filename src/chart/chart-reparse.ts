import { defaultMetadata } from '../ini/metadata'
import { ChartFileTokens, classifyChartFile, lazyChartFileSections } from './chart-file-parser'
import { TokensCache } from './edit-history'
import { applyChartRules, ParsedChartFile, resolveChartData, ResolvedTrack, resolveTrack } from './parse-chart-file'
import type { ParseRules } from './parse-rules'
import type { RawChartData } from './raw-types'
import type { IniChartModifiers } from './types'

type ClassifiedTrack = RawChartData['trackData'][number]

/** What a parse of a `.chart` file keeps, so a parse of an edited version can reuse the sections the edit didn't change. */
interface ChartParseMemo {
	/** The rule profile and settings it was parsed with; another parse reuses it only with the same. */
	readonly key: string
	/** Each section's body text, by name: the last section of a repeated name, as classification reads it. */
	readonly bodies: ReadonlyMap<string, string>
	/** Each instrument section's classification, kept unresolved, by section name. */
	readonly classified: ReadonlyMap<string, { readonly firstCodaTick: number | null; readonly track: ClassifiedTrack }>
	/** Each instrument section's resolved track, with the tempo map, resolution and drum type it was resolved with. */
	readonly resolved: ReadonlyMap<string, { readonly context: string; readonly track: ResolvedTrack }>
	readonly parsed: ParsedChartFile
}

const memos = new TokensCache<ChartParseMemo>()

/**
 * Parses a tokenized `.chart` file with a rule profile, exactly as `parseChartSource` does. When the tokens were made
 * by editing tokens already parsed with the same rules and settings, an instrument section whose text the edit didn't
 * change keeps its earlier classification, and keeps its resolved track too when the tempo map, resolution and drum
 * type are unchanged. Those tracks are shared with the earlier result, so treat both results as read-only.
 *
 * Throws an exception exactly as parsing the file's bytes would.
 */
export function parseChartTokens(tokens: ChartFileTokens, partialIniChartModifiers: Partial<IniChartModifiers>, rules: ParseRules): ParsedChartFile {
	const iniChartModifiers = Object.assign({}, defaultMetadata, partialIniChartModifiers) as IniChartModifiers
	const key = `${rules.profile}|${JSON.stringify(iniChartModifiers)}`
	const own = memos.get(tokens)
	if (own?.key === key) return own.parsed
	const earlier = memos.original(tokens)
	const memo = parseReusing(tokens, iniChartModifiers, rules, key, earlier?.key === key ? earlier : undefined)
	memos.set(tokens, memo)
	return memo.parsed
}

function parseReusing(
	tokens: ChartFileTokens,
	iniChartModifiers: IniChartModifiers,
	rules: ParseRules,
	key: string,
	earlier: ChartParseMemo | undefined,
): ChartParseMemo {
	const bodies = new Map<string, string>()
	const classified = new Map<string, { firstCodaTick: number | null; track: ClassifiedTrack }>()
	const sectionOf = new WeakMap<ClassifiedTrack, string>()
	const unchanged = new WeakSet<ClassifiedTrack>()
	const raw = classifyChartFile(lazyChartFileSections(tokens, bodies), (name, firstCodaTick, classify) => {
		const kept = earlier?.classified.get(name)
		let track: ClassifiedTrack
		if (kept !== undefined && kept.firstCodaTick === firstCodaTick && earlier!.bodies.get(name) === bodies.get(name)) {
			classified.set(name, kept)
			// The .chart rules replace a track's arrays without changing their events, so a shallow copy keeps `kept`
			// intact until the track is resolved again, which copies it deeply first.
			track = { ...kept.track }
			unchanged.add(track)
		} else {
			track = classify()
			classified.set(name, { firstCodaTick, track: cloneClassifiedTrack(track) })
		}
		sectionOf.set(track, name)
		return track
	})

	const syncTrack = bodies.get('SyncTrack') ?? ''
	const resolved = new Map<string, { context: string; track: ResolvedTrack }>()
	const parsed = resolveChartData(applyChartRules(raw, rules), 'chart', iniChartModifiers, rules, (track, context) => {
		const name = sectionOf.get(track)!
		// Only drum tracks are resolved with the drum type.
		const contextKey = `${context.resolution}|${track.instrument === 'drums' ? context.drumType : ''}|${syncTrack}`
		const kept = earlier?.resolved.get(name)
		const result = !unchanged.has(track) ? resolveTrack(track, context)
			: kept?.context === contextKey ? kept.track
			: resolveTrack(cloneClassifiedTrack(track), context)
		resolved.set(name, { context: contextKey, track: result })
		return result
	})
	return { key, bodies, classified, resolved, parsed }
}

/**
 * A copy of a classified track that resolution can consume without changing the original: resolution sorts its arrays
 * and sets times and lengths on their events. Every array field is copied with copies of its events.
 */
function cloneClassifiedTrack(track: ClassifiedTrack): ClassifiedTrack {
	const copy: Record<string, unknown> = { ...track }
	for (const [field, value] of Object.entries(track)) {
		if (Array.isArray(value)) copy[field] = value.map(event => ({ ...event }))
	}
	return copy as ClassifiedTrack
}
