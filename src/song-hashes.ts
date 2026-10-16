import { calculateCompetitiveHashes } from './competitive'
import { ObjectCache } from './shared/object-cache'
import type { SongDocument } from './song-document'

/**
 * Every hash saving keeps unless an edit spends it (E7): each track's canonical TrackHash and the canonical SongHash,
 * keyed like `canonical:guitar:expert` and `canonical:song`, as `calculateCompetitiveHashes` gives them. Saving doesn't
 * keep the legacy hashes: a normalization may change them. `null` when the canonical rules reject the chart.
 *
 * Documents don't change, so a song's hashes are calculated once per document.
 */
export function songHashes(song: SongDocument): ReadonlyMap<string, string> | null {
	let hashes = hashCache.get(song)
	if (hashes === undefined) {
		const competitive = calculateCompetitiveHashes(song)
		hashes = competitive.accepted
			? new Map([...competitive.tracks.map(track => [`canonical:${track.instrument}:${track.difficulty}`, track.trackHash] as const), ['canonical:song', competitive.songHash]])
			: null
		hashCache.set(song, hashes)
	}
	return hashes
}

const hashCache = new ObjectCache<SongDocument, ReadonlyMap<string, string> | null>('songHashes')
