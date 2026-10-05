export interface SampleContract {
  contractType: string;
  text: string;
}

// Sample contracts live server-side only. The client sends a sample ID, never contract text,
// so the rate-limit exemption for samples can't be used to analyze arbitrary documents.
export const SAMPLE_CONTRACTS: Record<string, SampleContract> = {
  'ontario-lease': {
    contractType: 'Lease Agreement',
    text: `RESIDENTIAL LEASE AGREEMENT

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
This Agreement is governed by the laws of the Province of Ontario.`,
  },
};
