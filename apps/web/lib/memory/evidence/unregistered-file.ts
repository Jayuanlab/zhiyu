/** Static refusal data performs no filesystem, network or authorization lookup. */
export function unregisteredFileSource(source: string) {
  return { status: "unavailable", code: "memory_source_unregistered", source, coverage: "unsupported", content: null,
    recovery: "The owner may import bytes as a managed private artifact and use the owner exact reader. This does not grant Work access: a formal Work binding is still required and is unavailable here. Paths, URLs and old inline payloads grant no source authority." };
}
