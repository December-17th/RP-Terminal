import { z } from 'zod'

/**
 * The Zod value cards expect on the global `z`.
 *
 * The ST/MVU ecosystem convention (see the clean-room MVU zod shim `main/services/mvuZod.ts`, which does
 * `z.z = z`, and the iframe lib shim `plugin/shims/lib.ts`, which documents `z` shaped as `{ z: <zod> }`)
 * is that the global is **self-referential**: card schema bundles call BOTH `z.object(...)` and
 * `z.z.object(...)` (the MVU schema style — e.g. The-poem-of-destiny's `data_schema`/`image_preload`
 * bundles do `const t = z; t.z.object({...})`). zod v4's instance has `z.object` but no `z.z`, so reading
 * `z.z.object` throws "Cannot read properties of undefined (reading 'object')".
 *
 * We must NOT mutate the imported `z` to add the self-ref: in the ESM/vite build it is non-extensible
 * (`z.z = z` throws "object is not extensible"). Instead derive a new object whose prototype IS `z` — so
 * `z.object`/`z.string`/`z.coerce`/etc. resolve through the chain unchanged — and give it an own `z` that
 * points back at itself, satisfying any depth of `z.z.z…`. Both card transports (inline `cardBridge`,
 * isolated `wcvPreload`) inject THIS value as the global `z`, so they stay at parity.
 */
const cardZodObj = Object.create(z) as typeof z & { z: typeof z }
cardZodObj.z = cardZodObj
export const cardZod = cardZodObj
