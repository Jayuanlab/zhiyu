import type { EvidenceOwnerHint } from './types';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const OBSERVATION_PREFIX = 'brain-observation:';

export function isEvidenceUuid(value: string): boolean { return UUID.test(value); }
export function uniqueEvidenceStrings(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }

/** Established typed references only; never a path or an untyped UUID. */
export function observationIdFromEvidenceRef(ref: string): string | null {
  const value = ref.startsWith(OBSERVATION_PREFIX) ? ref.slice(OBSERVATION_PREFIX.length) : null;
  return value !== null && isEvidenceUuid(value) ? value : null;
}

export function rawMessageRefValue(ref: string): string {
  for (const prefix of ['legacy-raw-message:', 'raw-message:', 'raw_message:']) {
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }
  return ref;
}

export function isRawMessageRef(ref: string, owners: EvidenceOwnerHint[]): boolean {
  return ref.startsWith('legacy-raw-message:') || ref.startsWith('raw-message:') || ref.startsWith('raw_message:')
    || owners.some(owner => owner.ownerType === 'raw_message');
}
