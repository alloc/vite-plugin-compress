// Advanced helper types used throughout the plugin.

/**
 * Generic type that remaps an intersection of interfaces into a single interface.
 */
type Remap<T> = {} & { [P in keyof T]: T[P] }

/**
 * Generic type that converts a type union to a type intersection. See
 * https://fettblog.eu/typescript-union-to-intersection/.
 *
 * @example
 * type A = { a: string }
 * type B = { b: string }
 * UnionToIntersection<A | B> // => A & B
 */
type UnionToIntersection<T> = (T extends any ? (x: T) => any : never) extends (
  x: infer R
) => any
  ? R
  : never
