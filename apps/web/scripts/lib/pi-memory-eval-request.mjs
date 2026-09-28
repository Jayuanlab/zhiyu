/** Keep evaluation labels and tool expectations entirely outside model input. */
export function buildMemoryEvalRequest(question, allowedTools, provider = 'pi') {
  if (typeof question.question !== 'string' || !question.question.trim()) throw new Error('Missing user question');
  return {
    provider, allowedTools,
    skillsConfig: { enabled: false, userDirEnabled: false, appDirEnabled: false },
    mcpConfig: { enabled: false, userDirEnabled: false, appDirEnabled: false },
    prompt: question.question,
  };
}
