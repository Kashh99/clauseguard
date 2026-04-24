export type RiskLevel = 'green' | 'amber' | 'red';

export const JURISDICTIONS = ['Ontario', 'BC', 'California', 'New York'] as const;
export type Jurisdiction = (typeof JURISDICTIONS)[number];

export interface ClauseAnalysis {
  title: string;
  excerpt: string;
  riskLevel: RiskLevel;
  explanation: string;
  negotiationTip: string | null;
}

export interface ContractAnalysis {
  summary: string;
  contractType: string;
  jurisdiction: Jurisdiction;
  clauses: ClauseAnalysis[];
}
