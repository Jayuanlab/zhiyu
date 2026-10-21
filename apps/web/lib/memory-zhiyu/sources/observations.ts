import type { SourceDescriptor } from "../../../../../packages/memory/src/ports";
import { sourceId, extension } from "../observation-codec";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";
/** Host registration, not a model-supplied source declaration. */
export const zhiyuObservationSources: readonly SourceDescriptor[] =
  Object.freeze([
    Object.freeze({
      id: sourceId,
      adapterVersion: "zhiyu-observation.g2",
      kind: "manual",
      trustLevel: "raw",
      validateExtensions(value: Record<string, unknown>) {
        if (Object.keys(value).some((k) => k !== extension))
          throw new MemoryModuleError(
            "invalid_memory_request",
            400,
            "Unregistered project extension",
          );
      },
    }),
  ]);
