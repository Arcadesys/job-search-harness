/** Only these domain errors may cross the private broker boundary. */
export class JobdeskError extends Error {
  constructor(
    readonly code: 'STALE_LEASE' | 'STALE_DRAFT' | 'SUBMISSION_RECONCILIATION_REQUIRED',
    message: string,
  ) {
    super(message);
  }
}
