/** Source contracts describe what a record represents, never certify its claims. */
type RecordLayer = "raw_observation" | "derived_interpretation" | "configuration"
  | "control_record" | "execution_record" | "runtime_binding" | "evidence_capture" | "unclassified";

type SourceContract = {
  layer: RecordLayer;
  statusScope?: string;
  doesNotEstablish: string[];
  requiredEvidence?: string[];
};

const contracts: Record<string, SourceContract> = {
  interactionevents: { layer: "raw_observation", doesNotEstablish: ["claim_truth", "derived_task_accuracy", "external_delivery"] },
  brainobservations: { layer: "raw_observation", doesNotEstablish: ["claim_truth", "memory_selected_by_a_run"] },
  interactionnotes: { layer: "derived_interpretation", doesNotEstablish: ["verbatim_original_text"],
    requiredEvidence: ["owner_visible_source_events", "comparison_with_original_content"] },
  interactionthreads: { layer: "derived_interpretation", doesNotEstablish: ["summary_is_verbatim_original_text"] },
  interactiontasks: { layer: "derived_interpretation", statusScope: "extracted_task_state",
    doesNotEstablish: ["original_commitment_or_deadline_accuracy"], requiredEvidence: ["owner_visible_source_events"] },
  interactionmemories: { layer: "derived_interpretation", statusScope: "stored_memory_state",
    doesNotEstablish: ["original_text", "memory_selected_by_a_run"] },
  brainmemories: { layer: "derived_interpretation", statusScope: "stored_memory_state",
    doesNotEstablish: ["claim_truth", "memory_selected_by_a_run"] },
  memorygraphrelations: { layer: "derived_interpretation", statusScope: "stored_relation_state",
    doesNotEstablish: ["claim_truth"], requiredEvidence: ["original_source_evidence"] },
  memorygraphevidence: { layer: "derived_interpretation", doesNotEstablish: ["quote_verified_against_original"] },
  workshops: { layer: "configuration", statusScope: "workshop_configuration_state",
    doesNotEstablish: ["current_executor_activity", "configuration_loaded_by_a_run"] },
  loops: { layer: "configuration", statusScope: "loop_configuration_state",
    doesNotEstablish: ["current_executor_activity", "configuration_loaded_by_a_run"] },
  loopstates: { layer: "derived_interpretation", statusScope: "last_persisted_loop_phase",
    doesNotEstablish: ["current_executor_activity", "historical_recovery"] },
  loopruns: { layer: "execution_record", statusScope: "recorded_run_state",
    doesNotEstablish: ["business_acceptance", "external_action_success", "current_executor_activity"] },
  workshopruns: { layer: "execution_record", statusScope: "recorded_run_state",
    doesNotEstablish: ["business_acceptance", "external_action_success", "current_executor_activity"] },
  workshopreviewitems: { layer: "control_record", statusScope: "review_item_disposition",
    doesNotEstablish: ["configuration_saved", "configuration_approved", "configuration_loaded", "proposed_action_executed"] },
  loopapprovalrequests: { layer: "control_record", statusScope: "action_approval_state",
    doesNotEstablish: ["approved_action_executed", "external_action_success"] },
  workshopdirectives: { layer: "control_record", statusScope: "directive_record_state",
    doesNotEstablish: ["directive_executed", "business_acceptance"] },
  workshopoutbox: { layer: "control_record", statusScope: "recorded_message_queue_state",
    doesNotEstablish: ["provider_confirmed_delivery", "recipient_received_message"],
    requiredEvidence: ["matching_send_attempt_and_provider_receipt"] },
  workcommands: { layer: "control_record", statusScope: "control_command_processing_state",
    doesNotEstablish: ["external_action_success", "business_acceptance"], requiredEvidence: ["action_result_and_business_receipt"] },
  workshopworkversions: { layer: "configuration", statusScope: "saved_work_version_record",
    doesNotEstablish: ["configuration_approved", "configuration_loaded_by_a_run"] },
  workshopruntimesnapshots: { layer: "runtime_binding", doesNotEstablish: ["current_executor_activity", "configuration_approved"],
    requiredEvidence: ["matching_run_id_and_runtime_policy_hashes"] },
  workrunevidencebundles: { layer: "evidence_capture", statusScope: "evidence_capture_state",
    doesNotEstablish: ["business_acceptance", "all_evidence_complete_or_correct"],
    requiredEvidence: ["bundle_completeness_and_warnings", "task_specific_acceptance_evidence"] },
  workrundiagnostics: { layer: "derived_interpretation", statusScope: "diagnostic_record_state",
    doesNotEstablish: ["root_cause_confirmed", "repair_applied"] },
  quanttradeplans: { layer: "control_record", statusScope: "simulated_trade_plan_state",
    doesNotEstablish: ["order_submitted", "actual_fill"], requiredEvidence: ["matching_order_and_fill_ledger"] },
  paperorders: { layer: "execution_record", statusScope: "simulated_order_state",
    doesNotEstablish: ["actual_fill"], requiredEvidence: ["matching_fill_ledger"] },
};

/** Supports application names and published exporter names, including dimensions. */
export function platformRecordSemantics(source: string) {
  const key = source.split(".")[0].replaceAll("_", "").toLowerCase();
  const contract = contracts[key] ?? { layer: "unclassified" as const, doesNotEstablish: ["independent_verification"] };
  return { schemaVersion: "platform-record-semantics.v1" as const, ...contract,
    verification: "not_assessed" as const };
}

const relations: Record<string, Record<string, string>> = {
  loops: { workshopId: "workshops" },
  loopstates: { loopId: "loops" },
  loopruns: { loopId: "loops" },
  loopapprovalrequests: { loopId: "loops", loopRunId: "loopRuns" },
  workshopruns: { workshopId: "workshops" },
  workshopevents: { workshopId: "workshops", runId: "workshopRuns", loopId: "loops", loopRunId: "loopRuns" },
  workshopsources: { workshopId: "workshops" },
  workshopdirectives: { workshopId: "workshops", runId: "workshopRuns" },
  workshopreviewitems: { workshopId: "workshops", sourceEventId: "workshopEvents" },
  workshopoutbox: { workshopId: "workshops", runId: "workshopRuns" },
  workshopworkversions: { workshopId: "workshops" },
  workshopruntimesnapshots: { workshopId: "workshops", runId: "workshopRuns" },
  interactiontasks: { eventId: "interactionEvents", threadId: "interactionThreads", sourceEventIds: "interactionEvents" },
  interactionnotes: { eventId: "interactionEvents", threadId: "interactionThreads", sourceEventIds: "interactionEvents" },
  interactionmemories: { sourceEventIds: "interactionEvents" },
  memorygraphrelations: { subjectEntityId: "memoryGraphEntities", objectEntityId: "memoryGraphEntities" },
  memorygraphevidence: { relationId: "memoryGraphRelations" },
  workrunevidencebundles: { workshopId: "workshops", workshopRunId: "workshopRuns", loopId: "loops", loopRunId: "loopRuns" },
  workrundiagnostics: { evidenceBundleId: "workRunEvidenceBundles" },
  message: { chatId: "chat" },
  messagev2: { chatId: "chat" },
  chatmessages: { chatId: "chat" },
};

/** Follow known provenance only; refs remain unread and confer no permission. */
export function platformRecordRelatedReads(source: string, fields: Record<string, unknown>) {
  const key = source.split(".")[0].replaceAll("_", "").toLowerCase();
  const refs: Array<{ source: string; id: string; via: string }> = [];
  const seen = new Set<string>();
  for (const [field, target] of Object.entries(relations[key] ?? {})) {
    const aliases = [field, field.replace(/[A-Z]/g, character => `_${character.toLowerCase()}`)];
    if (key === "memorygraphrelations") {
      // Both published roles are scalar UUIDs. Conflicting aliases are not two
      // alternative entity references; withhold that role, preserving the other.
      const present = aliases.filter(alias => Object.hasOwn(fields, alias));
      const values = present.map(alias => fields[alias]);
      if (!values.length || values.some(value => typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value))) continue;
      const ids = values.map(value => String(value).toLowerCase());
      const id = ids[0], identity = target + ":" + id;
      if (ids.some(value => value !== id) || seen.has(identity)) continue;
      seen.add(identity);
      refs.push({ source: target, id, via: present[0] });
      continue;
    }
    for (const alias of new Set(aliases)) {
      const value = fields[alias];
      for (const id of Array.isArray(value) ? value : [value]) {
        if (typeof id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) continue;
        const identity = `${target}:${id}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        if (refs.length < 8) refs.push({ source: target, id, via: alias });
      }
    }
  }
  return { status: "unread" as const, ownershipCheck: "required_on_read" as const, refs,
    hasMoreRefs: seen.size > refs.length };
}

/** Describes actual published values independently of the delivered projection. */
export function platformRecordFieldAvailability(fields: Record<string, unknown>, shownFields: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key,
    value === undefined ? "missing" : value === null ? "not_recorded"
      : !(key in shownFields) ? "present_unread"
      : Array.isArray(value) && value.length === 0 ? "empty_array"
      : value === "" ? "empty_string"
      : typeof value === "object" && !(value instanceof Date) && Object.keys(value).length === 0 ? "empty_object"
      : "shown"]));
}
