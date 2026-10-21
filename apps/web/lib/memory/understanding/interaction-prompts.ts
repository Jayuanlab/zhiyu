import type { InteractionEvent } from "@/lib/db/schema";
import type { InteractionAnalysis } from "./interaction-candidates";

function compact(value: string | null | undefined, max = 800) {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function eventLine(event: InteractionEvent) {
  const sender =
    event.senderDisplayName ?? event.senderName ?? event.conversationName;
  const time =
    event.messageTime instanceof Date
      ? event.messageTime.toISOString()
      : String(event.messageTime);
  return [
    `id=${event.id}`,
    `time=${time}`,
    `conversation=${event.conversationName}`,
    `sender=${sender}`,
    `direction=${event.direction}`,
    `type=${event.contentType}`,
    `content=${compact(event.content || event.contentPreview, 900)}`,
  ].join(" | ");
}

export function buildInteractionAnalysisPrompt(events: InteractionEvent[]) {
  return [
    "You are the analysis stage for the owner's workbench knowledge base.",
    "Return valid JSON only. Do not return Markdown or explanations.",
    "Analyze the WeChat events as factual source material for the whole workbench, not as a chat archive. Do not invent relationships, intent, or long-term facts.",
    "Every factual claim must cite sourceEventIds that exist in the input.",
    "Separate facts, decisions, commitments, risks, contradictions, and recommendations.",
    JSON.stringify(
      {
        summary: "Chinese conversation summary",
        topics: ["topic"],
        entities: [
          {
            name: "name",
            type: "person|organization|project|product|other",
            role: "role",
          },
        ],
        facts: [
          {
            claim: "verifiable factual claim in Chinese",
            sourceEventIds: ["event id"],
            evidenceStrength: "high|medium|low",
          },
        ],
        decisions: [],
        commitments: [],
        risks: [],
        contradictions: [],
        recommendations: [],
      },
      null,
      2,
    ),
    "Events:",
    events.map(eventLine).join("\n"),
  ].join("\n");
}

export function buildInteractionCandidatePrompt(
  events: InteractionEvent[],
  analysis?: InteractionAnalysis,
) {
  return [
    "You are a Chinese Owner Context processor for a personal AI workbench.",
    "Your job is to distill raw WeChat events into traceable Owner Knowledge candidates: notes, tasks, and long-term context memories.",
    "Return valid JSON only. Do not return Markdown, comments, code fences, or explanations.",
    "Use Simplified Chinese for title, body, description, subject, content, and tags, except for names, product names, group names, URLs, and enum values.",
    "",
    "Rules:",
    "- Raw messages are source facts and evidence. They are not themselves long-term knowledge.",
    "- The output is a candidate layer. It must not be treated as confirmed Owner Context until the owner/system confirms it.",
    "- Every note, task, and memory must cite sourceEventIds from the input events.",
    "- Create notes for useful context, group-chat topics, relationship signals, risks, project background, or reply-needed situations that may help any workbench module later.",
    "- Create tasks only when there is an explicit request, promise, follow-up, reminder, confirmation need, or reply need.",
    "- Create memories only for stable Owner Context that will be useful later: preferences, long-term identity, people background, project context, commitments, routines, boundaries, or repeated problems.",
    "- Assign atomType to each task and memory: todo, reply_needed, commitment, fact, preference, relationship, risk, or decision.",
    "- Assign privacyClass: normal for ordinary work context, private for personal relationship details, sensitive for finance/health/legal/account/private identity data, regulated for medical/legal/financial compliance-like material.",
    "- Assign riskLevel: high for money, trading, contract, medical, legal, credentials, privacy, external commitments, or anything that could cause harm if used incorrectly; medium for relationship-sensitive or ambiguous obligations; low only for safe durable context.",
    "- Add scenarioHints for the person, group, project, topic, transaction, family, or work scenario that should later receive an L2 state update.",
    "- Prefer information about the owner, owner relationships, owner commitments, owner projects, and persistent operating rules.",
    "- Do not store market spam, ads, listings, forwarded promotion text, or group noise as memory unless it clearly affects the owner's durable goals, relationships, or decisions.",
    "- Do not put temporary state into memory, such as traffic, current location, one-off meeting status, or just-left/just-arrived messages.",
    "- Ignore jokes, casual banter, greetings, memes, low-value game chatter, and short ambiguous messages unless they reveal a stable preference or long-term relationship.",
    "- If the content is low value, too sparse, or lacks evidence, return empty arrays.",
    "- Prefer fewer high-confidence items over many weak items.",
    "",
    "Confidence:",
    "- 80-100: clear message, strong evidence, high future reuse value.",
    "- 60-79: evidenced but context or long-term value is moderate.",
    "- Below 60: do not emit the item.",
    "- Do not use confidence 0. If unsure, omit the item.",
    "",
    "Field requirements:",
    "- noteType and memoryType must use the enum values shown in the JSON schema below.",
    "- dueAt must be null unless an explicit due time exists in the messages.",
    "- assigneeName and requesterName must be null when unclear.",
    "- sourceEventIds must only contain ids from the input Events.",
    "",
    "Required JSON shape:",
    JSON.stringify(
      {
        notes: [
          {
            noteType:
              "summary|classification|reply_need|risk|relationship|project_context",
            title: "Chinese short title",
            body: "Chinese distilled content with facts and evidence basis",
            confidence: 80,
            sourceEventIds: ["event id"],
            privacyClass: "normal|private|sensitive|regulated",
            riskLevel: "low|medium|high",
            scenarioHints: [
              {
                type: "person|group|project|topic|transaction|family|work",
                key: "stable scenario key",
                title: "display title",
              },
            ],
          },
        ],
        tasks: [
          {
            title: "Chinese task candidate title",
            description:
              "Chinese explanation of why this is a task and what to follow up",
            dueAt: "ISO time or null",
            assigneeName: "person name or null",
            requesterName: "person name or null",
            confidence: 80,
            sourceEventIds: ["event id"],
            atomType: "todo|reply_needed|commitment",
            privacyClass: "normal|private|sensitive|regulated",
            riskLevel: "low|medium|high",
            scenarioHints: [],
          },
        ],
        memories: [
          {
            memoryType:
              "person|preference|project|relationship|commitment|routine|boundary|mistake",
            subject: "person/project/topic",
            content: "Chinese stable long-term memory content",
            confidence: 80,
            tags: ["Chinese tag"],
            sourceEventIds: ["event id"],
            atomType:
              "fact|preference|relationship|commitment|risk|decision",
            privacyClass: "normal|private|sensitive|regulated",
            riskLevel: "low|medium|high",
            scenarioHints: [],
            expiresAt: "ISO time or null",
          },
        ],
      },
      null,
      2,
    ),
    "",
    analysis
      ? `Stage-one analysis for reference only:\n${JSON.stringify(analysis)}`
      : "",
    "Events:",
    events.map(eventLine).join("\n"),
  ].join("\n");
}
