import { isNullOrWhiteSpaceDotnet, toLowerInvariant } from '../../shared/text'
import type { SongHashMetadata } from './song-hash-20251010'

type SongTextField = 'name' | 'artist' | 'album' | 'genre' | 'year' | 'charter'

const unknownMetadata: { readonly [field in SongTextField]: string } = {
	name: 'Unknown Name',
	artist: 'Unknown Artist',
	album: 'Unknown Album',
	genre: 'Unknown Genre',
	year: 'Unknown Year',
	charter: 'Unknown Charter',
}

/**
 * Selects the metadata Clone Hero places on a song before hashing it (`SongEntry.ReadMetadata` and
 * `SongLibrary.GetOrCreateMetadataValue`). When a song.ini with a `[song]` section loads, only its values are
 * used and a missing key is blank; `charter` falls back to `frets` only when the `charter` key is absent.
 * Otherwise the `.chart [Song]` values are used. Blank values become "Unknown …". The canonical SongHash
 * writer resolves the result further (unset sentinels, style tags, icon).
 *
 * @param iniSong the `[song]` section of song.ini, or `null` when no song.ini with that section loads.
 * @param chartSong the `.chart [Song]` values as CH's reader returns them; empty for `.mid`.
 */
export function selectSongHashMetadata(
	iniSong: { readonly [key: string]: string } | null,
	chartSong: { readonly [field in SongTextField]?: string },
): SongHashMetadata {
	const source: { readonly [field in SongTextField]?: string } = iniSong === null ? chartSong : {
		name: iniSong.name ?? '',
		artist: iniSong.artist ?? '',
		album: iniSong.album ?? '',
		genre: iniSong.genre ?? '',
		year: iniSong.year ?? '',
		charter: iniSong.charter ?? iniSong.frets ?? '',
	}
	const known = (field: SongTextField) => {
		const value = source[field]
		return value === undefined || isNullOrWhiteSpaceDotnet(value) ? unknownMetadata[field] : value
	}
	return {
		name: known('name'),
		artist: known('artist'),
		album: known('album'),
		genre: known('genre'),
		year: known('year'),
		charter: known('charter'),
		icon: toLowerInvariant(iniSong?.icon ?? ''),
	}
}
