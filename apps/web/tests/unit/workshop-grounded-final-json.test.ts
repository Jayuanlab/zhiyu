import { describe, expect, it } from 'vitest';
import { parseGroundedResearchFinalJson } from '@/lib/workshops/grounded-final-json';

describe('grounded final JSON protocol', () => {
  it.each([
    '{"researchEvidence":{"works":[],"gaps":[]}}',
    ' \n{"researchEvidence":{"works":[],"gaps":[]}}\r\n ',
    '```json\n{"researchEvidence":{"works":[],"gaps":[]}}\n```',
    '```json\r\n{"researchEvidence":{"works":[],"gaps":[]}}\r\n```',
  ])('accepts the whole single object: %j', (text) => {
    expect(parseGroundedResearchFinalJson(text)).toEqual({ researchEvidence: { works: [], gaps: [] } });
  });

  it('does not mistake fence markers inside a JSON string for a second report', () => {
    const report = { researchEvidence: { gaps: ['Quoted ```json\n{"example":true}\n``` notation.'] } };
    expect(parseGroundedResearchFinalJson(JSON.stringify(report))).toEqual(report);
    expect(parseGroundedResearchFinalJson(`\`\`\`json\n${JSON.stringify(report)}\n\`\`\``)).toEqual(report);
  });

  it.each([
    'First report.\n{"researchEvidence":{}}',
    '{"researchEvidence":{}}\nSecond report.',
    '{"researchEvidence":{}}\n{"researchEvidence":{}}',
    '```json\n{"researchEvidence":{}}\n```\n```json\n{"researchEvidence":{}}\n```',
    '```json\n{"researchEvidence":{}}\n```\nSecond report.',
    'Now compile.\n```json\n{"researchEvidence":{}}\n```',
    '{"presentation":{"reportMarkdown":"unfinished\n{"researchEvidence":{}}',
    '```json\n{"presentation":{"reportMarkdown":"unfinished\n```\n```json\n{"researchEvidence":{}}\n```',
    '[{"researchEvidence":{}}]',
    'null',
    'true',
    '"text"',
    '/* note */ {"researchEvidence":{}}',
    '{"researchEvidence":{}} // note',
    '```\n{"researchEvidence":{}}\n```',
    '````json\n{"researchEvidence":{}}\n````',
    '```json\n{"researchEvidence":{}}',
    '',
  ])('rejects extra text, repeated objects or malformed candidates: %j', (text) => {
    expect(parseGroundedResearchFinalJson(text)).toBeNull();
  });
});
