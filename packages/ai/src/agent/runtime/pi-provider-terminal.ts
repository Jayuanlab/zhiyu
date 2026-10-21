import type { AssistantMessage } from '@earendil-works/pi-ai';

/** Host terminal admission, after the raw SDK result has been audited.
 * A draft and its usage remain available. Default incomplete output cannot
 * enter implicit SDK recovery; explicit bounded host recovery still requires
 * its audited summary budgets and a complete approved final candidate. */
export function admitPiProviderTerminal(result: AssistantMessage, options?: {
  /** Requires the explicit bounded-compaction policy and final-validation
   * gate. The gate reserves and audits each summary before dispatch, rejects
   * incomplete summaries, and requires a complete approved final candidate. */
  boundedLengthRecovery?: boolean;
}): AssistantMessage {
  if (result.stopReason === 'length' && (!options?.boundedLengthRecovery ||
    result.content.some(block => block.type === 'toolCall'))) {
    return {
      ...result,
      stopReason: 'error',
      errorMessage: '[provider_output_truncated] Provider ended with finish_reason=length; the partial output is incomplete.',
    };
  }
  if (result.stopReason === 'error' && result.errorMessage &&
    /data_inspection_failed|DataInspectionFailed|^Provider finish_reason: content_filter$/i.test(result.errorMessage) &&
    !result.errorMessage.startsWith('[provider_content_rejected]')) {
    return { ...result, errorMessage: `[provider_content_rejected] ${result.errorMessage}` };
  }
  if (result.stopReason === 'error' && result.errorMessage?.trim() === '{}') {
    return { ...result, errorMessage: '[provider_stream_interrupted] Provider stream returned an unspecified error (raw: {}). Partial output is incomplete; the upstream cause is unknown.' };
  }
  return result;
}
