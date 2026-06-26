import { z } from 'zod'

/**
 * The Zod value cards expect on the global `z`.
 *
 * The ST/MVU ecosystem convention (see the clean-room MVU zod shim `main/services/mvuZod.ts`, which does
 * `z.z = z`, and the iframe lib shim `plugin/shims/lib.ts`, which documents `z` shaped as `{ z: <zod> }`)
 * is that the global is **self-referential**: card schema bundles call BOTH `z.object(...)` and
 * `z.z.object(...)` (the MVU schema style — e.g. The-poem-of-destiny's `data_schema`/`image_preload`
 * bundles do `const t = z; t.z.object({...})`). zod v4's instance has `z.object` but no `z.z`, so reading
 * `z.z.object` throws "Cannot read properties of undefined (reading 'object')". Adding the self-ref once
 * satisfies both access styles. Mutating the shared singleton is harmless — the app's own zod usage only
 * touches `z.object`/`z.string`/etc., never `z.z`.
 *
 * Both card transports (inline `cardBridge`, isolated `wcvPreload`) inject THIS value as the global `z`,
 * so they stay at parity.
 */
const zod = z as typeof z & { z?: typeof z }
if (!zod.z) zod.z = zod
export const cardZod = zod
