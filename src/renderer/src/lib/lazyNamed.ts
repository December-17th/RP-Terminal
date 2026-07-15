import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

/**
 * `React.lazy` for a module's NAMED export.
 *
 * `React.lazy` only accepts a module whose component is the `default` export, but our components are
 * named exports — so every code-split call site repeated the same adapter:
 * `lazy(() => import('./X').then((m) => ({ default: m.X })))`. This wraps that adapter once, keeping
 * the exact component type (props included) via the module/name generics.
 *
 * Laziness is unchanged: the returned component still defers `loader()` until it first renders, so
 * gate it with `{open && <Lazy… />}` if the import should only fire when a surface opens.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors React.lazy's own `T extends
// ComponentType<any>` bound; `any` here lets any prop-shape satisfy the constraint (contravariance),
// while `M[K]` in the return type preserves each component's exact props for its call site.
export function lazyNamed<K extends string, M extends Record<K, ComponentType<any>>>(
  loader: () => Promise<M>,
  name: K
): LazyExoticComponent<M[K]> {
  return lazy(() => loader().then((mod) => ({ default: mod[name] })))
}
