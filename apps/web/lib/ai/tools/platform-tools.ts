import type { Session } from 'next-auth';
import { createBusinessToolsMcpServer } from '../mcp/business-tools';
import { adaptRuntimeToolDefinition, guardPiTools } from './pi-tools';
import type { RuntimeToolPolicy } from '../runtime/tool-executor';

export const PLATFORM_READ_TOOLS = [
  'time',
  'webSearch',
  'chatInsight',
  'queryContacts',
  'queryIntegrations',
  'searchKnowledgeBase',
  'getFullDocumentContent',
  'listKnowledgeBaseDocuments',
  'searchUnifiedMemory',
  'searchMemoryPath',
  'brainListMemories',
  'brainListCandidates',
  'brainListSnapshots',
  'brainListGrants',
  'listLoopTasks',
  'wechatDesktopHealth',
  'inspectWorkshopAgent',
  'listWorkshopManifestCapabilities',
  'reviewWorkshopManifestYaml',
];
/** Connector and standalone Loop hosts select a bounded tool set. Handler-level
 * owner, approval, source and idempotency checks remain authoritative. */
export function createPlatformPiTools(input: {
  session: Session;
  authToken?: string;
  chatId?: string;
  policy?: RuntimeToolPolicy;
  excludeTools?: string[];
  approvalControlledByHost?: boolean;
}) {
  const server = createBusinessToolsMcpServer(
    input.session,
    input.authToken,
    undefined,
    input.chatId,
    { excludeTools: input.excludeTools, enableWechatDesktopSend: false },
  );
  const requested = input.policy?.allowedTools ?? PLATFORM_READ_TOOLS;
  const leaf = (name: string) => name.split('__').at(-1)!.toLowerCase();
  const names = new Set(requested.map(leaf));
  const tools = server.tools
    .filter((definition) => names.has(leaf(definition.name)))
    .map(adaptRuntimeToolDefinition);
  return guardPiTools(tools, {
    ...input.policy,
    ...(input.approvalControlledByHost
      ? { requiresApprovalTools: undefined }
      : {}),
    allowedTools: [...requested],
    defaultDecision: 'deny',
  });
}
