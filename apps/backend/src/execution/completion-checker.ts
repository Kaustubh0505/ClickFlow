import { isDeepStrictEqual } from 'node:util';
import { completionProposalSchema, completionResultSchema, containsSensitiveText, isSupportedPageUrl, needsFreshGoalCheck, type CompletionProposal, type GoalCheck, type Observation, type TaskState, type VerificationResult } from '@clickflow/shared';

export class CompletionError extends Error {}
export function evidenceCatalog(task: TaskState, goalChecks: GoalCheck[] = [], observation: Observation | null = task.currentContext) {
  const catalog: Array<{ evidence: VerificationResult['evidence'][number]; stepId: string; criterionId?: string; condition: VerificationResult['condition']; content: string }> = [];
  for (const outcome of task.actionHistory) {
    const step = task.plan?.steps.find((entry) => entry.id === outcome.authorization.stepId);
    const verified = outcome.verification;
    const reconciled = task.reconciliationHistory.some((entry) => entry.actionId === outcome.authorization.actionId && entry.resolution === 'state_verified');
    if (step?.status !== 'completed' || verified?.status !== 'passed' || outcome.error || !(outcome.dispatchStatus === 'dispatched' || reconciled)) continue;
    for (const evidence of verified.evidence.filter((entry) => step.evidenceIds.includes(entry.id))) {
      if (!isSupportedPageUrl(evidence.sourceUrl) || Math.abs(Date.parse(evidence.capturedAt) - Date.parse(verified.checkedAt)) > 5000) throw new CompletionError('Recorded evidence has inconsistent source metadata.');
      const content = `Verified condition: ${JSON.stringify(verified.condition)}\n${evidence.summary}${outcome.extraction ? `\nExtracted text: ${outcome.extraction.text}` : ''}`;
      if (containsSensitiveText(content)) throw new CompletionError('Private information cannot be sent for completion assessment.');
      const entry = { evidence, stepId: step.id, condition: verified.condition, content };
      const duplicate = catalog.find((item) => item.evidence.id === evidence.id);
      if (duplicate && !isDeepStrictEqual(duplicate, entry)) throw new CompletionError('Conflicting evidence IDs prevent completion assessment.');
      if (!duplicate) catalog.push(entry);
    }
  }
  const checked = new Set<string>();
  for (const check of goalChecks) {
    const original = task.plan?.goalCriteria.find((entry) => entry.id === check.criterionId);
    const verification = check.verification;
    if (!original?.verification || !needsFreshGoalCheck(original.verification) || checked.has(check.criterionId) || !isDeepStrictEqual(verification.condition, original.verification)
      || !observation || Math.abs(Date.parse(verification.checkedAt) - Date.parse(observation.capturedAt)) > 5000
      || verification.evidence.some((entry) => entry.observationId !== observation.id || entry.sourceUrl !== observation.url || entry.capturedAt !== observation.capturedAt)) throw new CompletionError('A fresh goal check does not match the original criterion and current observation.');
    checked.add(check.criterionId);
    if (verification.status !== 'passed') continue;
    for (const evidence of verification.evidence) {
      const content = `Verified condition: ${JSON.stringify(verification.condition)}\n${evidence.summary}`;
      if (containsSensitiveText(content) || catalog.some((entry) => entry.evidence.id === evidence.id)) throw new CompletionError('Invalid or private fresh goal evidence.');
      catalog.push({ evidence, stepId: 'goal-check', criterionId: check.criterionId, condition: verification.condition, content });
    }
  }
  if (catalog.length > 200 || JSON.stringify(catalog).length > 160_000) throw new CompletionError('The evidence exceeds the assessment context limit. Inspect the recorded sources and use a narrower task.');
  return catalog;
}
export type EvidenceCatalog = ReturnType<typeof evidenceCatalog>;
const resolved = (task: TaskState) => task.plan!.steps.filter((step) => step.action.type !== 'finish').every((step) => ['completed', 'skipped'].includes(step.status));

/** Typed criteria can be assessed without inference. No evidence never becomes a positive claim. */
export function deterministicAssessment(task: TaskState, catalog: EvidenceCatalog): CompletionProposal | null {
  if (!task.plan) return null;
  if (catalog.length && task.plan.goalCriteria.some((criterion) => !criterion.verification || criterion.verification.type === 'semantic_assessment_required')) return null;
  const criteria = task.plan.goalCriteria.map((criterion) => {
    const matches = criterion.verification && criterion.verification.type !== 'semantic_assessment_required' ? catalog.filter((item) => isDeepStrictEqual(item.condition, criterion.verification) && (!needsFreshGoalCheck(criterion.verification!) || item.criterionId === criterion.id)) : [];
    return { criterionId: criterion.id, status: matches.length ? 'met' as const : 'unknown' as const,
      evidenceIds: matches.map((item) => item.evidence.id), citations: matches.map((item) => ({ evidenceId: item.evidence.id, quote: item.evidence.summary })) };
  });
  return { status: criteria.every((criterion) => criterion.status === 'met') && resolved(task) ? 'completed' : criteria.some((criterion) => criterion.status === 'met') ? 'partial' : 'blocked', criteria };
}

/** Evidence and summaries come from persisted browser facts, never model-provided source objects. */
export function validateCompletion(task: TaskState, raw: unknown, catalog = evidenceCatalog(task)) {
  const proposal = completionProposalSchema.parse(raw);
  if (!task.plan || proposal.criteria.length !== task.plan.goalCriteria.length) throw new CompletionError('Every original goal criterion must be assessed.');
  const byId = new Map(catalog.map((entry) => [entry.evidence.id, entry]));
  const seen = new Set<string>();
  for (const criterion of proposal.criteria) {
    const original = task.plan.goalCriteria.find((entry) => entry.id === criterion.criterionId);
    if (!original || seen.has(criterion.criterionId)) throw new CompletionError('The assessment changed or duplicated an original criterion.');
    seen.add(criterion.criterionId);
    if (new Set(criterion.evidenceIds).size !== criterion.evidenceIds.length || criterion.evidenceIds.some((id) => !byId.has(id))) throw new CompletionError('The assessment cited unavailable or unverified evidence.');
    if (criterion.citations.some((citation) => !criterion.evidenceIds.includes(citation.evidenceId) || !byId.get(citation.evidenceId)?.content.includes(citation.quote))) throw new CompletionError('An assessment quotation is not present in its recorded source.');
    if (criterion.status === 'met') {
      if (!criterion.evidenceIds.length || criterion.evidenceIds.some((id) => !criterion.citations.some((citation) => citation.evidenceId === id))) throw new CompletionError('Every met criterion needs exact recorded-source citations.');
      if (criterion.evidenceIds.some((id) => byId.get(id)!.criterionId && byId.get(id)!.criterionId !== criterion.criterionId)) throw new CompletionError('Fresh evidence belongs to another original criterion.');
      if (original.verification && original.verification.type !== 'semantic_assessment_required' && !criterion.evidenceIds.some((id) => isDeepStrictEqual(byId.get(id)!.condition, original.verification) && (!needsFreshGoalCheck(original.verification!) || byId.get(id)!.criterionId === original.id))) throw new CompletionError('The original typed criterion was not freshly verified.');
    }
  }
  const met = proposal.criteria.filter((criterion) => criterion.status === 'met').length;
  const status = met === proposal.criteria.length && resolved(task) ? 'completed' : met ? 'partial' : 'blocked';
  if (proposal.status !== status) throw new CompletionError('The completion claim is inconsistent with verified criteria and remaining work.');
  const used = new Set(proposal.criteria.flatMap((criterion) => criterion.evidenceIds));
  return completionResultSchema.parse({ status,
    summary: status === 'completed' ? `All ${met} original goal criteria are supported by recorded evidence.` : `${met} of ${proposal.criteria.length} original goal criteria are supported. ${resolved(task) ? 'Required information is missing or unverified.' : 'Planned work remains unfinished.'}`,
    criteria: proposal.criteria, evidence: catalog.filter((entry) => used.has(entry.evidence.id)).map((entry) => entry.evidence) });
}
