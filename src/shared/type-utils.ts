/** Overwrites the type of a nested property in `T` with `U`. */
export type Overwrite<T, U> =
	U extends object ?
		T extends object ?
			{
				[K in keyof T]: K extends keyof U ? Overwrite<T[K], U[K]> : T[K]
			}
		:	U
	:	U
export type Subset<K> = {
	[attr in keyof K]?: NonNullable<K[attr]> extends object ? Subset<K[attr]> : K[attr]
}
export type RequireMatchingProps<T, K extends keyof T> = T & { [P in K]-?: NonNullable<T[P]> }
export type OptionalMatchingProps<T, K extends keyof T> = Omit<T, K> & { [P in K]?: T[P] }
export type ObjectValues<T> = T[keyof T]

declare global {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	interface ReadonlyArray<T> {
		includes<S, R extends `${Extract<S, string>}`>(this: ReadonlyArray<R>, searchElement: S, fromIndex?: number): searchElement is R & S
	}
}
