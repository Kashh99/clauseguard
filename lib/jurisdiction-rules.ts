import type { Jurisdiction } from '@/lib/types';

// Statutory rules sent to the model with the contract, for jurisdictions where its general
// knowledge has produced wrong ratings. Each rule cites its source and keeps the statute's own
// scope and exceptions, so it isn't applied to tenancies the statute doesn't cover.
// They go in the user message, not the system prompt, so each jurisdiction only sees its own.
//
// Sources (checked 2026-10-28):
// - NY Real Property Law § 238-a: https://www.nysenate.gov/legislation/laws/RPP/238-A
// - NY Real Property Law § 233(r): https://www.nysenate.gov/legislation/laws/RPP/233
const NEW_YORK_RULES = `New York late fees for residential tenancies (N.Y. Real Property Law § 238-a(2), https://www.nysenate.gov/legislation/laws/RPP/238-A):
- Scope: applies "in relation to a residential dwelling unit" (apartments, houses and other homes rented to live in).
- A landlord may not charge any late fee unless the rent has not been paid within five days of its due date. A fee charged on day 1 to 5 after the due date breaks this rule.
- The fee may not exceed $50 or 5% of the monthly rent, whichever is less. Work out the cap from the rent stated in the lease: $800 rent gives a $40 cap; $1,000 or more gives a $50 cap (for example, $2,600 rent: 5% is $130, so the cap is $50).
- Recurring, daily or percentage late charges count toward the same cap.
- § 238-a(3): a lease term waiving or limiting these protections is void, so a lease that sets a higher fee cannot make it lawful.
Exceptions, which must not be treated as ordinary apartment leases:
- Co-ops: a cooperative housing corporation may charge its own shareholder or dwelling-unit owner up to 8% of the monthly maintenance fee for late payment of that fee, if the proprietary lease or occupancy agreement provides for it. This exception does not cover co-ops under Private Housing Finance Law articles 2, 4, 5 or 11, and it does not cover a shareholder's own subtenant, who is an ordinary residential tenant.
- Manufactured home parks: lot rent paid by a manufactured home owner has its own late-charge rule in Real Property Law § 233(r) (https://www.nysenate.gov/legislation/laws/RPP/233): at most 3% of the late payment, none on payments received within ten days of the due date, none unless the lease or park rules provide for it, and no compounding. Don't apply the § 238-a figures to these lots; check against § 233(r) and tell the user to confirm which rule applies.
- Commercial leases are not residential dwelling units, and § 238-a does not apply to them.
- If you cannot tell whether the lease is residential, say so instead of applying or dismissing the cap.
How to rate a late-fee clause in a residential New York lease:
- If the fee is more than the cap or can be charged within the five days, rate it red. State the cap for this rent, cite Real Property Law § 238-a(2), and say the excess is not enforceable even though the tenant signed. Never rate it green or describe it as standard, even if such fees are common.
- If the fee is within the cap and the five days, it is lawful. Rate it on its other terms.
- If the lease doesn't state the monthly rent, explain the rule and that the cap is the lesser of $50 or 5% of rent.`;

const RULES: Partial<Record<Jurisdiction, string>> = {
  'New York': NEW_YORK_RULES,
};

export function jurisdictionRules(jurisdiction: Jurisdiction): string | null {
  return RULES[jurisdiction] ?? null;
}
