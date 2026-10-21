/** Identity used by stored Work allow/deny policies and source capabilities. */
export function toolLeafName(toolName: string): string {
  return (toolName.split("__").pop() ?? toolName).toLowerCase();
}
