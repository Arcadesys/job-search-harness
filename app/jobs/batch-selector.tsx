'use client';

import { useActionState } from 'react';
import { createJobBatch, type BatchActionState } from './actions';

const initialState: BatchActionState = { message: '' };
type Candidate = { id: string; title: string; organization: string };

export default function BatchSelector({ leads, pursuedCount }: { leads: Candidate[]; pursuedCount: number }) {
  const [state, action, pending] = useActionState(createJobBatch, initialState);
  if (!leads.length) return pursuedCount ? <section className="jobsPanel" role="status"><h2>No pursued leads available to batch</h2><p>Your pursued leads already have an active or submitted application batch.</p></section> : null;
  return <form action={action} className="jobsPanel jobsBatchSelector" aria-labelledby="batch-heading">
    <h2 id="batch-heading">Start an application batch</h2>
    <p>Select pursued leads for the job-hunt MCP. Each lead will be prepared for your review.</p>
    <fieldset>
      <legend>Pursued leads · {leads.length}</legend>
      <div className="jobsBatchChoices">{leads.map((lead) => <label className="jobsBatchChoice" key={lead.id}>
        <input type="checkbox" name="leadId" value={lead.id} />
        <span><strong>{lead.title}</strong><small>{lead.organization || 'Organization unknown'}</small></span>
      </label>)}</div>
    </fieldset>
    <button className="jobsButtonPrimary" type="submit" disabled={pending}>{pending ? 'Starting batch…' : 'Start selected batch'}</button>
    {state.message ? <p role={state.error ? 'alert' : 'status'} aria-live="polite">{state.message}</p> : null}
  </form>;
}
