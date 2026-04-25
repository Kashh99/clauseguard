'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import type { ContractAnalysis, ClauseAnalysis, RiskLevel } from '@/lib/types';
import { JURISDICTIONS } from '@/lib/types';

const MAX_FILE_BYTES = 20 * 1024 * 1024;

const CONTRACT_TYPES = ['Lease Agreement', 'Employment Contract'] as const;
type ContractType = (typeof CONTRACT_TYPES)[number] | '';

const RISK = {
  green: {
    label: 'Standard',
    badge: 'bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20',
    border: 'border-l-emerald-500',
  },
  amber: {
    label: 'Review',
    badge: 'bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/20',
    border: 'border-l-amber-500',
  },
  red: {
    label: 'Risky',
    badge: 'bg-red-500/10 text-red-400 ring-1 ring-red-500/20',
    border: 'border-l-red-500',
  },
} as const;

const SAMPLE_LEASE_TEXT = `RESIDENTIAL LEASE AGREEMENT

This Residential Lease Agreement is entered into as of January 1, 2024, between 123 Properties Inc. ("Landlord") and the undersigned Tenant(s).

1. PREMISES
The Landlord agrees to lease to the Tenant the property located at 456 Main Street, Unit 3B, Toronto, Ontario M5V 2H1 ("the Premises").

2. TERM AND AUTOMATIC RENEWAL
The initial lease term begins February 1, 2024 and ends January 31, 2025. UPON EXPIRY OF THE INITIAL TERM, THIS LEASE SHALL AUTOMATICALLY RENEW FOR SUCCESSIVE ONE-YEAR PERIODS UNLESS EITHER PARTY PROVIDES WRITTEN NOTICE OF TERMINATION NO LESS THAN 90 DAYS PRIOR TO THE END OF THE THEN-CURRENT TERM. Failure to provide such notice shall bind the Tenant to an additional full year's lease obligations, including all rent payments.

3. RENT AND INCREASES
Monthly rent is $2,200 CAD, due on the first day of each month. THE LANDLORD RESERVES THE RIGHT TO INCREASE THE MONTHLY RENT AT ANY TIME UPON 30 DAYS WRITTEN NOTICE, AT THE LANDLORD'S SOLE DISCRETION AND WITHOUT LIMITATION AS TO AMOUNT OR FREQUENCY.

4. LATE PAYMENT FEE
If rent is not received in full by the 3rd day of the month, a late fee of $200.00 shall be immediately due and payable in addition to the monthly rent, regardless of the reason for the delay.

5. REPAIRS AND MAINTENANCE
The Tenant shall be solely responsible for all repairs and maintenance to the Premises costing less than $500.00, including but not limited to plumbing repairs, appliance servicing, window repairs, door hardware, and damage arising from ordinary wear and tear. The Landlord assumes responsibility only for repairs exceeding $500.00.

6. PETS
No pets of any kind are permitted on or within the Premises at any time, including temporary or visiting animals. Discovery of any pet shall constitute grounds for immediate termination of this lease and automatic forfeiture of the entire security deposit.

7. LANDLORD ENTRY
The Landlord or the Landlord's agents may enter the Premises at any time for the purposes of inspection, repair, maintenance, or showing to prospective tenants or purchasers. VERBAL NOTICE BY TELEPHONE OR IN PERSON IS SUFFICIENT AND THE LANDLORD IS NOT REQUIRED TO PROVIDE ADVANCE WRITTEN NOTICE WHEN ENTRY IS DEEMED NECESSARY BY THE LANDLORD.

8. SECURITY DEPOSIT
A security deposit of $4,400.00 (equivalent to two months' rent) is required prior to occupancy. The Landlord may apply any or all of the security deposit toward unpaid rent, damages beyond normal wear and tear, or cleaning costs at the Landlord's sole discretion.

9. SUBLETTING AND ASSIGNMENT
The Tenant shall not sublet the Premises, assign this lease, or permit any other person to occupy the Premises without the prior written consent of the Landlord. Such consent may be withheld by the Landlord for any reason or no reason, at the Landlord's absolute discretion.

10. GOVERNING LAW
This Agreement is governed by the laws of the Province of Ontario.`;

// ─── Icons ───────────────────────────────────────────────────────────────────

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
    </svg>
  );
}

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
    </svg>
  );
}

function FileIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  );
}

function XCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function BulbIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
    </svg>
  );
}

function ChevronIcon({ down }: { down?: boolean }) {
  return (
    <svg className="w-3 h-3 transition-transform" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d={down ? 'M19.5 8.25l-7.5 7.5-7.5-7.5' : 'M4.5 15.75l7.5-7.5 7.5 7.5'} />
    </svg>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function RiskBadge({ level }: { level: RiskLevel }) {
  const cfg = RISK[level];
  const dots = { green: '🟢', amber: '🟡', red: '🔴' };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${cfg.badge}`}>
      <span>{dots[level]}</span>
      {cfg.label}
    </span>
  );
}

function ClauseCard({
  clause,
  expanded,
  onToggle,
}: {
  clause: ClauseAnalysis;
  expanded: boolean;
  onToggle: () => void;
}) {
  const cfg = RISK[clause.riskLevel];
  const hasTip = clause.negotiationTip !== null && clause.negotiationTip !== undefined;

  return (
    <div className={`bg-zinc-900 border border-zinc-800 border-l-4 ${cfg.border} rounded-xl p-5 animate-fade-in-up`}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <h3 className="text-sm font-semibold text-zinc-100">{clause.title}</h3>
        <RiskBadge level={clause.riskLevel} />
      </div>

      {clause.excerpt && (
        <blockquote className="mb-3 pl-3 border-l-2 border-zinc-700 text-xs text-zinc-500 italic font-mono line-clamp-2">
          {clause.excerpt}
        </blockquote>
      )}

      <p className="text-sm text-zinc-300 leading-relaxed">{clause.explanation}</p>

      {hasTip && (
        <div className="mt-4">
          <button
            onClick={onToggle}
            className="flex items-center gap-2 text-xs font-medium text-violet-400 hover:text-violet-300 transition-colors"
          >
            <BulbIcon className="w-3.5 h-3.5" />
            Negotiation tip
            <ChevronIcon down={!expanded} />
          </button>

          <div
            className={`overflow-hidden transition-all duration-300 ${
              expanded ? 'max-h-48 opacity-100 mt-3' : 'max-h-0 opacity-0'
            }`}
          >
            <p className="text-xs text-zinc-400 bg-zinc-800/60 rounded-lg px-4 py-3 leading-relaxed border border-zinc-700/50">
              {clause.negotiationTip}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function RiskOverview({ clauses }: { clauses: ClauseAnalysis[] }) {
  const counts = {
    green: clauses.filter(c => c.riskLevel === 'green').length,
    amber: clauses.filter(c => c.riskLevel === 'amber').length,
    red: clauses.filter(c => c.riskLevel === 'red').length,
  };

  const items = [
    { level: 'green' as const, label: 'Standard', count: counts.green, badge: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20' },
    { level: 'amber' as const, label: 'Review',   count: counts.amber, badge: 'bg-amber-500/10 text-amber-400 ring-amber-500/20' },
    { level: 'red'   as const, label: 'Risky',    count: counts.red,   badge: 'bg-red-500/10 text-red-400 ring-red-500/20' },
  ];

  return (
    <div className="flex flex-wrap gap-3">
      {items.map(item => (
        <div key={item.level} className={`flex items-center gap-2 rounded-full px-4 py-1.5 text-sm ring-1 ${item.badge}`}>
          <span className="text-lg font-bold leading-none">{item.count}</span>
          <span className="font-medium">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Home() {
  const [file, setFile]               = useState<File | null>(null);
  const [sampleText, setSampleText]   = useState<string | null>(null);
  const [jurisdiction, setJurisdiction] = useState('');
  const [contractType, setContractType] = useState<ContractType>('');
  const [isDragging, setIsDragging]   = useState(false);
  const [isLoading, setIsLoading]     = useState(false);
  const [analysis, setAnalysis]       = useState<ContractAnalysis | null>(null);
  const [error, setError]             = useState<string | null>(null);
  const [expandedTips, setExpandedTips] = useState<Set<number>>(new Set());
  const [loadingStage, setLoadingStage] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const resultsRef   = useRef<HTMLDivElement>(null);

  const LOADING_STAGES = useMemo(() => [
    'Extracting contract text…',
    'Identifying key clauses…',
    `Assessing risks for ${jurisdiction}…`,
    'Generating explanations…',
    'Preparing your analysis…',
  ], [jurisdiction]);

  useEffect(() => {
    if (!isLoading) return;
    const timer = setInterval(() => setLoadingStage(s => (s + 1) % LOADING_STAGES.length), 2500);
    return () => clearInterval(timer);
  }, [isLoading, LOADING_STAGES]);

  const loadSample = () => {
    setSampleText(SAMPLE_LEASE_TEXT);
    setFile(null);
    setJurisdiction('Ontario');
    setContractType('Lease Agreement');
    setAnalysis(null);
    setError(null);
    setExpandedTips(new Set());
  };

  const acceptFile = (f: File) => {
    if (f.type !== 'application/pdf') {
      setError('Only PDF files are supported.');
      return;
    }
    if (f.size > MAX_FILE_BYTES) {
      setError('File is too large (max 20 MB). Contract PDFs are usually much smaller.');
      return;
    }
    setFile(f);
    setSampleText(null);
    setAnalysis(null);
    setError(null);
    setExpandedTips(new Set());
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) acceptFile(f);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) acceptFile(f);
    e.target.value = '';
  };

  const handleAnalyze = async () => {
    if ((!file && !sampleText) || !jurisdiction || isLoading) return;

    setIsLoading(true);
    setError(null);
    setAnalysis(null);
    setLoadingStage(0);
    setExpandedTips(new Set());

    const fd = new FormData();
    if (file) {
      fd.append('file', file);
    } else {
      fd.append('text', sampleText!);
    }
    fd.append('jurisdiction', jurisdiction);
    if (contractType) fd.append('contractType', contractType);

    try {
      const res  = await fetch('/api/analyze', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Analysis failed.');
        return;
      }
      setAnalysis(data);
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth' }), 150);
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const toggleTip = (i: number) => {
    setExpandedTips(prev => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };

  const hasInput   = file !== null || sampleText !== null;
  const canAnalyze = hasInput && jurisdiction !== '' && !isLoading;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">

      {/* Header */}
      <header className="sticky top-0 z-20 bg-zinc-950/80 backdrop-blur-md border-b border-zinc-800/60">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <ShieldIcon className="w-6 h-6 text-violet-400" />
            <span className="text-lg font-bold">ClauseGuard</span>
          </div>
          <p className="hidden sm:block text-sm text-zinc-500">Understand every clause before you sign</p>
        </div>
      </header>

      <main className="flex-1 max-w-4xl mx-auto w-full px-4 sm:px-6 py-14 space-y-8">

        {/* Hero */}
        <div className="text-center space-y-3">
          <h1 className="text-3xl sm:text-4xl font-bold">Know what you&apos;re signing</h1>
          <p className="text-zinc-500 max-w-lg mx-auto">
            Upload a contract and get an instant plain-English breakdown with color-coded risk flags.
          </p>
        </div>

        {/* Upload card */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 sm:p-8">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf"
            className="hidden"
            onChange={handleFileInput}
          />

          {/* Drop zone */}
          <div
            onDragOver={e => (e.preventDefault(), setIsDragging(true))}
            onDragLeave={e => (e.preventDefault(), setIsDragging(false))}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 cursor-pointer transition-all ${
              isDragging
                ? 'border-violet-500 bg-violet-500/5'
                : sampleText && !file
                  ? 'border-violet-600/50 bg-violet-500/5'
                  : file
                    ? 'border-emerald-600/50 bg-emerald-500/5'
                    : 'border-zinc-700 bg-zinc-800/30 hover:border-zinc-600'
            }`}
          >
            {sampleText && !file ? (
              <>
                <FileIcon className="w-10 h-10 text-violet-400" />
                <div className="text-center">
                  <p className="text-sm font-semibold text-violet-400">Sample: Ontario Lease Agreement</p>
                  <p className="text-xs text-zinc-500 mt-0.5">Click to upload your own contract instead</p>
                </div>
                <span className="absolute top-3 right-3 text-xs font-bold bg-violet-500/20 text-violet-400 ring-1 ring-violet-500/30 rounded-full px-2.5 py-0.5 tracking-wide">
                  SAMPLE
                </span>
              </>
            ) : file ? (
              <>
                <FileIcon className="w-10 h-10 text-emerald-400" />
                <div className="text-center">
                  <p className="text-sm font-semibold text-emerald-400 truncate max-w-xs">{file.name}</p>
                  <p className="text-xs text-zinc-500 mt-0.5">{(file.size / 1024).toFixed(0)} KB</p>
                </div>
              </>
            ) : (
              <>
                <UploadIcon className={`w-10 h-10 transition-colors ${isDragging ? 'text-violet-400' : 'text-zinc-600'}`} />
                <div className="text-center">
                  <p className="text-sm font-medium text-zinc-300">
                    {isDragging ? 'Drop your PDF here' : 'Drag & drop your contract'}
                  </p>
                  <p className="text-xs text-zinc-600 mt-1">
                    or <span className="text-violet-400 underline">click to browse</span>
                  </p>
                </div>
              </>
            )}
          </div>

          {/* Sample button — visible only when no input is loaded */}
          {!hasInput && (
            <div className="mt-4 flex items-center gap-3">
              <div className="flex-1 h-px bg-zinc-800" />
              <button
                onClick={loadSample}
                className="text-xs text-zinc-500 hover:text-violet-400 transition-colors whitespace-nowrap"
              >
                Try a sample lease →
              </button>
              <div className="flex-1 h-px bg-zinc-800" />
            </div>
          )}

          {/* Selectors */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-5">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Jurisdiction</label>
              <select
                value={jurisdiction}
                onChange={e => setJurisdiction(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              >
                <option value="">Select jurisdiction…</option>
                {JURISDICTIONS.map(j => (
                  <option key={j} value={j}>{j}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Contract type (optional)</label>
              <select
                value={contractType}
                onChange={e => setContractType(e.target.value as ContractType)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
              >
                <option value="">Auto-detect</option>
                {CONTRACT_TYPES.map(ct => (
                  <option key={ct} value={ct}>{ct}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Analyze button */}
          <button
            onClick={handleAnalyze}
            disabled={!canAnalyze}
            className={`mt-5 w-full rounded-xl px-6 py-3 text-sm font-semibold transition-all flex items-center justify-center gap-2 ${
              canAnalyze
                ? 'bg-violet-600 hover:bg-violet-500 text-white shadow-lg shadow-violet-900/40 hover:-translate-y-0.5'
                : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
            }`}
          >
            {isLoading ? (
              <>
                <span className="h-4 w-4 rounded-full border-2 border-zinc-600 border-t-violet-400 animate-spin" />
                {LOADING_STAGES[loadingStage]}
              </>
            ) : (
              <>
                <ShieldIcon className="w-4 h-4" />
                Analyze Contract
              </>
            )}
          </button>
        </div>

        {/* Error state */}
        {error && (
          <div className="bg-red-500/5 border border-red-500/20 rounded-2xl p-6 animate-fade-in-up">
            <div className="flex items-start gap-4">
              <XCircleIcon className="w-6 h-6 text-red-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-red-300">
                  Something went wrong analyzing your contract
                </p>
                <p className="text-xs text-red-400/70 mt-1 leading-relaxed">{error}</p>
              </div>
            </div>
            <button
              onClick={() => setError(null)}
              className="mt-4 ml-10 text-xs font-medium text-red-400 hover:text-red-300 underline underline-offset-2 transition-colors"
            >
              Try again
            </button>
          </div>
        )}

        {/* Loading state */}
        {isLoading && (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-2 py-4">
              <div className="flex items-center gap-3">
                <span className="h-5 w-5 rounded-full border-2 border-zinc-700 border-t-violet-500 animate-spin" />
                <span className="text-base font-medium text-zinc-200">Analyzing your contract…</span>
              </div>
              <p className="text-sm text-zinc-500">This usually takes 10–15 seconds</p>
            </div>
            {[...Array(4)].map((_, i) => (
              <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3 animate-pulse">
                <div className="flex justify-between items-center">
                  <div className="h-4 w-40 bg-zinc-800 rounded" />
                  <div className="h-6 w-20 bg-zinc-800 rounded-full" />
                </div>
                <div className="h-3 w-full bg-zinc-800 rounded" />
                <div className="h-3 w-4/5 bg-zinc-800 rounded" />
              </div>
            ))}
          </div>
        )}

        {/* Results */}
        {analysis && !isLoading && (
          <div ref={resultsRef} className="space-y-6 animate-fade-in-up">
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <span className="bg-violet-500/10 text-violet-400 ring-1 ring-violet-500/20 text-xs font-medium rounded-full px-3 py-1">
                  {analysis.contractType}
                </span>
                <span className="bg-zinc-800 text-zinc-400 text-xs font-medium rounded-full px-3 py-1">
                  {analysis.jurisdiction}
                </span>
              </div>
              <p className="text-sm text-zinc-300 leading-relaxed">{analysis.summary}</p>

              <div className="mt-5 pt-5 border-t border-zinc-800">
                <p className="text-xs font-medium text-zinc-500 uppercase tracking-widest mb-3">Risk breakdown</p>
                <RiskOverview clauses={analysis.clauses} />
              </div>
            </div>

            <div className="space-y-3">
              {analysis.clauses.map((clause, i) => (
                <ClauseCard
                  key={i}
                  clause={clause}
                  expanded={expandedTips.has(i)}
                  onToggle={() => toggleTip(i)}
                />
              ))}
            </div>

            <p className="text-center text-xs text-zinc-600 pb-4">
              AI-generated analysis for informational purposes only. For significant contracts, consult a qualified lawyer.
            </p>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-800/60">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-zinc-500">
              <ShieldIcon className="w-4 h-4 text-violet-500/60" />
              <span>ClauseGuard — AI-powered contract analysis</span>
            </div>
            <a
              href="https://github.com/Kashh99"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Built by Kashyap Mavani
            </a>
          </div>
          <p className="text-center text-xs text-zinc-700 mt-3">
            For informational purposes only. Not legal advice.
          </p>
        </div>
      </footer>

    </div>
  );
}
