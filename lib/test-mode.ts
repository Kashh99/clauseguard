import type { ContractAnalysis, Jurisdiction } from './types';

export const TEST_MODE_MARKER = 'TEST_MODE_ACTIVE';

// Preview deployments always run in test mode, so a preview can never bill the model API.
// CLAUSEGUARD_TEST_MODE=1 turns it on elsewhere (local runs, tests). Production ignores the
// flag, so a stray setting can't replace real analyses with mock ones.
export function isTestMode(env: Record<string, string | undefined> = process.env): boolean {
  if (env.VERCEL_ENV === 'production') return false;
  return env.VERCEL_ENV === 'preview' || env.CLAUSEGUARD_TEST_MODE === '1';
}

// A fixed, clearly labelled stand-in for a model response. It never echoes contract text.
export function mockAnalysis(jurisdiction: Jurisdiction, source: 'upload' | 'sample'): ContractAnalysis {
  const clause = (riskLevel: 'green' | 'amber' | 'red', negotiationTip: string | null) => ({
    title: `${TEST_MODE_MARKER}: mock ${riskLevel} clause`,
    excerpt: `${TEST_MODE_MARKER}: placeholder excerpt, not taken from the contract.`,
    riskLevel,
    explanation: `${TEST_MODE_MARKER}: placeholder explanation. No model was called.`,
    negotiationTip,
  });
  return {
    summary: `${TEST_MODE_MARKER}: mock response for ${source === 'upload' ? 'an upload' : 'a sample'} on a test deployment. No contract was analysed and no model was called.`,
    contractType: TEST_MODE_MARKER,
    jurisdiction,
    clauses: [
      clause('green', null),
      clause('amber', `${TEST_MODE_MARKER}: placeholder tip.`),
      clause('red', `${TEST_MODE_MARKER}: placeholder tip.`),
    ],
    testMode: true,
  };
}

export function mockResponse(jurisdiction: Jurisdiction, source: 'upload' | 'sample'): Response {
  // Lets deployment logs confirm test mode served a request; carries no contract content.
  console.info(`analyze: ${TEST_MODE_MARKER} mock served`, { source, jurisdiction });
  return Response.json(mockAnalysis(jurisdiction, source), {
    headers: { 'X-ClauseGuard-Test-Mode': 'active' },
  });
}
