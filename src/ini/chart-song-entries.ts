/**
 * `[Song]` keys scan-chart reads as metadata when there's no song.ini, with their song.ini keys. `Difficulty` is the
 * whole song's difficulty, `diff_band`, as YARG reads it; Clone Hero ignores it and reads the other keys.
 */
const chartSongKeys: readonly (readonly [chartKey: string, iniKey: string, secondsToMs?: true])[] = [
	['Name', 'name'],
	['Artist', 'artist'],
	['Album', 'album'],
	['Genre', 'genre'],
	['Year', 'year'],
	['Charter', 'charter'],
	['Difficulty', 'diff_band'],
	['Offset', 'delay', true],
	['PreviewStart', 'preview_start_time', true],
]

/**
 * The `[Song]` values Clone Hero and scan-chart read when there's no song.ini, as song.ini entries: times in
 * milliseconds as Clone Hero rounds them, and Year without its `, `. A time that isn't a number is left out, as
 * song.ini's reading leaves out a number it can't read.
 */
export function chartSongIniEntries(chartSong: ReadonlyMap<string, string>): [key: string, value: string][] {
	const entries: [string, string][] = []
	for (const [chartKey, iniKey, inSeconds] of chartSongKeys) {
		const value = chartSong.get(chartKey)
		if (value === undefined) continue
		if (!inSeconds) entries.push([iniKey, chartKey === 'Year' && value.startsWith(', ') ? value.slice(2) : value])
		else if (secondsToMs(value) !== null) entries.push([iniKey, String(secondsToMs(value))])
	}
	return entries
}

/**
 * A `[Song]` time in seconds, in milliseconds as Clone Hero reads it, or `null` if it isn't a number. Clone Hero
 * calculates `(int)Math.Ceiling(float.Parse(value) * 1000)` (`SongEntry.ReadFeedbackChartMetadata`) in single
 * precision, so 0.127 seconds reads as 128 ms, where double precision gives 127.
 */
export function secondsToMs(seconds: string | undefined): number | null {
	const value = seconds === undefined ? NaN : Number(seconds)
	return Number.isFinite(value) ? Math.ceil(Math.fround(Math.fround(value) * 1000)) : null
}
