/** Only these domain errors may cross the private broker boundary. */
export class JobdeskError extends Error {
  constructor(
    readonly code: 'STALE_LEASE' | 'STALE_DRAFT' | 'SUBMISSION_RECONCILIATION_REQUIRED' | 'TRUTH_CONFLICT' | 'IMPORT_REJECTED' | 'STALE_WORK' | 'WORKFLOW_REJECTED',
    message: string,
  ) {
    super(message);
  }
}
