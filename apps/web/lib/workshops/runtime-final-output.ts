import type { AgentMessage, AgentRuntimeTerminal } from '@openzhiyu/ai/agent/types';
import type { AgentRuntimeMetadata } from '@openzhiyu/ai/agent/runtime/types';

export type WorkshopFinalOutputMode = 'pi-harness-terminal' | 'pi-agent-candidate' | 'legacy-text' | 'unsupported';

export interface WorkshopRuntimeFinalOutput {
  ok: boolean;
  /** Empty on failure. Failed draft text is retained only as the transcript. */
  text: string;
  transcript: string;
  error?: string;
  metadata: {
    mode: WorkshopFinalOutputMode;
    candidateCount: number;
    terminalCount: number;
    doneReceived: boolean;
    terminalStatus?: AgentRuntimeTerminal['status'];
    cleanupStatus?: AgentRuntimeTerminal['cleanupStatus'];
  };
}

/** Streaming text is an audit transcript. It is not Pi's final document. */
export function createWorkshopRuntimeFinalOutput(runtime: Pick<AgentRuntimeMetadata, 'engine' | 'adapter'>) {
  const mode: WorkshopFinalOutputMode = runtime.engine === 'claude' ? 'legacy-text'
    : runtime.adapter === 'pi-agent-harness' ? 'pi-harness-terminal'
    : runtime.adapter === 'pi-agent-core' ? 'pi-agent-candidate' : 'unsupported';
  let transcript = '';
  let candidateText = '';
  let candidateCount = 0;
  let terminalCount = 0;
  let terminal: AgentRuntimeTerminal | undefined;
  let doneReceived = false;
  let invalid: string | undefined;
  const fail = (message: string) => { invalid ??= message; };
  const requiresCandidate = mode === 'pi-harness-terminal' || mode === 'pi-agent-candidate';

  return {
    observe(message: AgentMessage) {
      if (doneReceived) fail('Runtime emitted messages after its end marker.');
      if (message.type === 'error') fail(message.message || 'Runtime emitted an error.');
      if (message.type === 'text') transcript += message.content ?? '';

      if (requiresCandidate && candidateCount > 0 && ['text', 'reasoning', 'tool_use', 'tool_result'].includes(message.type)) {
        fail('Runtime resumed generation or tool execution after its final candidate.');
      }
      if (requiresCandidate && terminalCount > 0 && message.type !== 'done' && message.type !== 'runtime_terminal' && message.type !== 'error') {
        fail('Runtime emitted output after its terminal receipt.');
      }
      if (message.type === 'result') {
        if (message.answerPhase === 'candidate_final') {
          candidateCount += 1;
          candidateText = typeof message.content === 'string' ? message.content : '';
        } else if (requiresCandidate && candidateCount > 0) {
          fail('Runtime emitted an intermediate result after its final candidate.');
        }
        // Claude's legacy result content is the SDK outcome subtype, not text.
        if (mode === 'legacy-text' && /^error(?:_|$)/u.test(message.content ?? '')) {
          fail(`Legacy runtime outcome: ${message.content}`);
        }
      }
      if (message.type === 'runtime_terminal') {
        terminalCount += 1;
        terminal = message.runtimeTerminal ? { ...message.runtimeTerminal } : undefined;
        if (!terminal || terminal.schemaVersion !== 'agent-runtime-terminal.v1') fail('Runtime terminal receipt is missing or invalid.');
        else if (terminal.status !== 'completed' || terminal.cleanupStatus !== 'completed'
          || terminal.runtimeStatus && terminal.runtimeStatus !== 'completed') {
          fail(terminal.error || `Runtime ended with ${terminal.status}; cleanup ${terminal.cleanupStatus}.`);
        }
      }
      if (message.type === 'done') doneReceived = true;
    },
    finish(): WorkshopRuntimeFinalOutput {
      if (mode === 'unsupported') fail(`Unsupported Pi output adapter: ${runtime.adapter}.`);
      if (!doneReceived) fail('Runtime did not emit its end marker.');
      if (requiresCandidate && (candidateCount !== 1 || !candidateText.trim())) {
        fail(`Runtime must produce exactly one nonempty final candidate; observed ${candidateCount}.`);
      }
      if (mode === 'pi-harness-terminal' && (terminalCount !== 1 || !terminal
        || terminal.completionScope && terminal.completionScope !== 'runtime')) {
        fail('Pi Harness requires exactly one completed runtime terminal receipt.');
      }
      if (terminalCount > 1) fail('Runtime emitted multiple terminal receipts.');
      if (mode === 'legacy-text' && !transcript.trim()) fail('Legacy runtime produced no text output.');
      return {
        ok: invalid === undefined,
        text: invalid ? '' : requiresCandidate ? candidateText : transcript,
        transcript,
        ...(invalid ? { error: invalid } : {}),
        metadata: {
          mode, candidateCount, terminalCount, doneReceived,
          ...(terminal ? { terminalStatus: terminal.status, cleanupStatus: terminal.cleanupStatus } : {}),
        },
      };
    },
  };
}
