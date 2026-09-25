import { selectJobBatch } from './actions';

type Batch = { id: string; isSelected: boolean; createdAt: string; itemCount: number; queued: number; preparing: number; awaitingApproval: number; submitted: number; blocked: number; skipped: number };

export default function ApplicationBatches({ batches }: { batches: Batch[] }) {
  if (!batches.length) return null;
  return <section className="jobsPanel jobsBatchHistory" aria-labelledby="batch-history-heading">
    <h2 id="batch-history-heading">Application batches</h2>
    <p>One batch is selected for the local MCP. Select another here to change which batch it should work on.</p>
    <ul>{batches.map((batch) => <li key={batch.id}>
      <div><strong>{batch.isSelected ? 'Selected batch' : 'Batch'} · {batch.createdAt ? new Date(batch.createdAt).toLocaleString() : batch.id}</strong>
        <span>{batch.itemCount} leads · {batch.queued} queued · {batch.preparing} preparing · {batch.awaitingApproval} awaiting approval · {batch.submitted} submitted · {batch.blocked} blocked · {batch.skipped} skipped</span>
        <code>{batch.id}</code>
      </div>
      {!batch.isSelected ? <form action={selectJobBatch}><input type="hidden" name="batchId" value={batch.id} /><button type="submit">Select this batch</button></form> : <span className="jobsStatus" aria-current="true">Selected for MCP</span>}
    </li>)}</ul>
  </section>;
}
