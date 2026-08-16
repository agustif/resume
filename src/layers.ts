import { Layer } from "effect"
import { allAdapters } from "./adapters/index.js"
import { layerAdapterRegistry } from "./core/registry.js"

/**
 * Application service graph.
 * Platform services (Node FileSystem/Path/ChildProcess/Terminal) are provided
 * once at the CLI edge via NodeServices.layer — not here.
 */
export const RegistryLive = layerAdapterRegistry(allAdapters)

export const AppLayer = RegistryLive
