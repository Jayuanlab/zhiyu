import { z } from 'zod';

const text = z.string().trim().min(1);
const finding = z.object({
  location: text,
  excerpt: text,
  readerQuestion: text,
  reason: text,
  severity: z.enum(['low', 'medium', 'high']),
  suggestedRewrite: text,
  resolution: z.enum(['revised', 'unresolved', 'needs_owner_decision']),
});

const contentReview = z.object({
  contentMarkdown: z.string(),
  readerReview: z.object({
    checkedDimensions: z.array(text).min(1),
    findings: z.array(finding),
  }),
  revisionSummary: text,
  contentDecision: z.enum(['ready_for_owner_review', 'blocked']),
  blockers: z.array(text),
});

const sourceEvidence = z.array(z.object({
  source: text,
  url: z.url().refine(value => /^https?:\/\//i.test(value), 'Expected an HTTP(S) source URL'),
  authority: z.enum(['primary', 'secondary']),
  contentLevel: text,
  supportedClaims: z.array(text),
})).min(1);
const discoveryCoverage = z.object({
  window: text,
  checkedAreas: z.array(z.object({
    area: text,
    queries: z.array(text),
    sourceUrls: z.array(z.url().refine(value => /^https?:\/\//i.test(value), 'Expected an HTTP(S) source URL')),
    status: z.enum(['checked', 'partial', 'failed', 'skipped']),
    reason: text,
  })).min(1),
  gaps: z.union([z.string(), z.array(text)]),
});

function canonicalUrl(value: string) {
  const url = new URL(value);
  url.hash = '';
  return url.href.replace(/\/$/, '');
}

/** Checks delivery integrity, not factual truth or actual reader comprehension. */
export function verifyContentReview(requiredFields: string[], report: unknown): string[] {
  if (!['contentMarkdown', 'readerReview'].every(field => requiredFields.includes(field))) return [];
  const parsed = contentReview.safeParse(report);
  if (!parsed.success) return parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
  const value = parsed.data;
  if (value.contentDecision === 'blocked') {
    return value.blockers.length ? [] : ['Blocked content must explain at least one blocker'];
  }
  const issues: string[] = [];
  if (!value.contentMarkdown.trim()) issues.push('Ready content must contain a non-empty revised article');
  if (/^[\s（(【\[]*(?:见(?:上|下)方(?:完整)?(?:文章|正文|内容)?|同上|正文同上|see (?:above|below)|as above)[\s）)】\]。.!]*$/i.test(value.contentMarkdown.trim())) {
    issues.push('Ready content must include the actual article, not a cross-reference placeholder');
  }
  if (value.blockers.length) issues.push('Ready content cannot retain blocking issues');
  if (value.readerReview.findings.some(item => item.severity === 'high' && item.resolution !== 'revised')) {
    issues.push('Unresolved high-severity findings must block ready content');
  }
  const raw = report as Record<string, unknown>;
  if (requiredFields.includes('sourceEvidence')) {
    const sources = sourceEvidence.safeParse(raw.sourceEvidence);
    if (!sources.success) {
      issues.push(...sources.error.issues.map(issue => `sourceEvidence.${issue.path.join('.')}: ${issue.message}`));
    } else {
      const primary = sources.data.filter(source => source.authority === 'primary');
      if (!primary.some(source => /^(full[ _-]?text|正文|全文)$/i.test(source.contentLevel) && source.supportedClaims.length > 0)) {
        issues.push('Ready content needs a full-text primary source with explicit supported claims');
      }
      for (const source of primary) {
        if (/转载|转引|repost|syndicat/i.test(source.source)) issues.push('A source explicitly described as a repost cannot be marked primary');
        if (sources.data.some(other => other.authority === 'secondary' && canonicalUrl(other.url) === canonicalUrl(source.url))) {
          issues.push('The same source URL cannot be both primary and secondary evidence');
        }
      }
    }
  }
  if (requiredFields.includes('discoveryCoverage')) {
    const coverage = discoveryCoverage.safeParse(raw.discoveryCoverage);
    if (!coverage.success) issues.push(...coverage.error.issues.map(issue => `discoveryCoverage.${issue.path.join('.')}: ${issue.message}`));
  }
  return issues;
}
