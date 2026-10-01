import { writeFile } from 'node:fs/promises';
import path from 'node:path';
/** Entirely synthetic private bootstrap: no actual applications or receipts. */
export async function fixtureReports(root: string) {
  const sourceNote = 'Synthetic test attestation. No employer was contacted.';
  await writeFile(
    path.join(root, 'bootstrap.json'),
    JSON.stringify([
      {
        id: 'fixture-submitted-a',
        organization: 'Fixture employer A',
        externalJobId: 'fixture-role-001',
        state: 'user_reported_submitted',
        reportedOn: '2026-10-01',
        sourceNote,
      },
      {
        id: 'fixture-submitted-b',
        organization: 'Fixture employer B',
        externalJobId: 'fixture-role-002',
        state: 'user_reported_submitted',
        reportedOn: '2026-10-01',
        sourceNote,
      },
      {
        id: 'fixture-referral-c',
        organization: 'Fixture employer C',
        externalJobId: '',
        state: 'referral_expected',
        reportedOn: '2026-10-01',
        sourceNote,
      },
    ]),
    { mode: 0o600 },
  );
}
