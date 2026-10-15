import { useState } from 'react';
import { PageHead } from './common';
import type { Method } from '../contract';

type Rpc = (method: Method, args?: unknown[]) => Promise<any>;
type Assistant = { id: 'claude' | 'codex'; name: string; detected: boolean; connected: boolean; current: boolean; foreign: boolean; error: string };
const STEPS = ['Connect your AI', 'What you want', 'Your résumé', 'Done'];
const DOWNLOADS: Record<Assistant['id'], [string, string]> = {
  claude: ['Get Claude Desktop', 'https://claude.ai/download'],
  codex: ['Get the ChatGPT desktop app', 'https://openai.com/chatgpt/download/'],
};
const KEY_PAGES = { anthropic: 'https://console.anthropic.com/settings/keys', openai: 'https://platform.openai.com/api-keys' };
export const WELCOMED_KEY = 'jobdesk.welcomed';
const field = (form: HTMLFormElement, name: string) => String(new FormData(form).get(name) ?? '').trim();
const lines = (value: string) => value.split('\n').map((line) => line.trim()).filter(Boolean);
const today = () => new Date().toISOString().slice(0, 10);
const markWelcomed = () => { try { localStorage.setItem(WELCOMED_KEY, '1'); } catch { /* optional */ } };

function Stepper({ step, go }: { step: number; go: (step: number) => void }) {
  return <ol className="ck-stepper" aria-label="Setup steps">
    {STEPS.map((label, index) => <li key={label} aria-current={index === step ? 'step' : undefined} className={index < step ? 'is-done' : undefined}>
      <button type="button" onClick={() => go(index)}><span aria-hidden="true">{index < step ? '✓' : index + 1}</span>{label}
        {index < step && <span className="sr-only"> (done)</span>}</button>
    </li>)}
  </ol>;
}

function ConnectStep({ data, rpc, next }: { data: any; rpc: Rpc; next: () => void }) {
  const [assistants, setAssistants] = useState<Assistant[]>(data.assistants);
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<'anthropic' | 'openai'>(data.settings.drafting.provider === 'openai' ? 'openai' : 'anthropic');
  const connect = async (assistant: Assistant, replace = false) => {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await rpc('assistant.connect', replace ? [assistant.id, { replace }] : [assistant.id]);
      setAssistants(await rpc('assistant.status'));
      setMessage(`${assistant.name} is connected. ${result.restart}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not connect.'); } finally { setBusy(false); }
  };
  return <section className="ck-stack" aria-labelledby="connect-title">
    <div className="ck-card ck-card--strong">
      <h2 id="connect-title">Connect the AI assistant you already use</h2>
      <p className="ck-muted" style={{ margin: 0 }}>Your assistant does the reading and preparation through this app. You stay signed in to it as usual; this app never sees your password. One click adds Job Search Harness to its settings.</p>
    </div>
    {message && <p role="status" className="ck-notice" style={{ margin: 0 }}>{message}</p>}
    {error && <p role="alert" className="ck-alert" style={{ margin: 0 }}>{error}</p>}
    <div className="ck-grid">
      {assistants.map((assistant) => <div className="ck-card" key={assistant.id}>
        <div className="ck-card-head"><h3 style={{ margin: 0 }}>{assistant.name}</h3>
          <strong className={assistant.connected ? 't-ok' : assistant.detected ? 't-accent' : 't-muted'}>
            {assistant.foreign ? 'Set up differently' : assistant.connected ? 'Connected' : assistant.detected ? 'Found on this computer' : 'Not found'}</strong></div>
        {assistant.foreign && <p style={{ margin: 0 }}>It already has a <q>job-search-harness</q> connection that this app did not create. Replace it only if you no longer use that setup.</p>}
        {assistant.error && <p className="t-bad" style={{ margin: 0 }}>{assistant.error}</p>}
        {!assistant.detected && !assistant.connected && <p className="ck-muted" style={{ margin: 0 }}>Install it first, then come back and connect. <a href={DOWNLOADS[assistant.id][1]}>{DOWNLOADS[assistant.id][0]}</a></p>}
        {assistant.foreign
          ? <button type="button" className="ck-btn" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => void connect(assistant, true)}>{`Replace the ${assistant.name} connection`}</button>
          : <button type="button" className={`ck-btn${assistant.connected ? '' : ' ck-btn--primary'}`} style={{ alignSelf: 'flex-start' }} disabled={busy}
            onClick={() => void connect(assistant)}>{assistant.connected ? `Reconnect ${assistant.name}` : `Connect ${assistant.name}`}</button>}
      </div>)}
    </div>
    <details className="ck-card">
      <summary>Or draft inside this app with your own API key</summary>
      <form className="ck-stack" style={{ marginTop: '.75rem', gap: '.6rem' }} onSubmit={(event) => {
        event.preventDefault(); const key = field(event.currentTarget, 'apiKey');
        setBusy(true); setError(''); setMessage('');
        void (async () => {
          try {
            await rpc('settings.saveApiKey', [provider, key]);
            await rpc('settings.save', [{ timeZone: data.settings.timeZone, drafting: { provider, model: data.settings.drafting.model } }]);
            setMessage('Key saved. It stays in a private file on this computer.');
          } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save the key.'); } finally { setBusy(false); }
        })();
      }}>
        <p className="ck-muted" style={{ margin: 0 }}>Optional. Usage is billed by the provider and stops at this app’s monthly budget.</p>
        <div className="ck-segmented" role="group" aria-label="Provider" style={{ alignSelf: 'flex-start' }}>
          {([['anthropic', 'Anthropic (Claude)'], ['openai', 'OpenAI']] as const).map(([id, label]) =>
            <button key={id} type="button" aria-pressed={provider === id} onClick={() => setProvider(id)}>{label}</button>)}
        </div>
        <label>API key<input name="apiKey" type="password" autoComplete="off" required maxLength={500} /></label>
        <a href={KEY_PAGES[provider]}>Create a {provider === 'anthropic' ? 'Claude' : 'OpenAI'} API key</a>
        <button className="ck-btn" style={{ alignSelf: 'flex-start' }} disabled={busy}>Save key</button>
      </form>
    </details>
    <div className="ck-row"><button type="button" className="ck-btn ck-btn--primary" onClick={next}>Continue</button>
      {!assistants.some((assistant) => assistant.connected) && <span className="ck-muted">You can connect later from Settings.</span>}</div>
  </section>;
}

function PreferencesStep({ data, rpc, next }: { data: any; rpc: Rpc; next: () => void }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const zone = data.settings.timeZone === 'UTC' ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' : data.settings.timeZone;
  const [role, setRole] = useState(''), [place, setPlace] = useState(''), [query, setQuery] = useState('');
  const suggested = [role, 'jobs', place].filter(Boolean).join(' ');
  const workflow = data.workflow;
  return <form className="ck-stack" aria-labelledby="prefs-title" onSubmit={(event) => {
    event.preventDefault(); const f = event.currentTarget;
    setBusy(true); setError('');
    void (async () => {
      try {
        const existing = data.search.queries.map((q: any) => ({ id: String(q.id), lane: q.lane, location: q.location ?? '', query: q.query, feedUrl: q.feedUrl ?? '', enabled: Boolean(q.enabled) }));
        if (role) await rpc('search.save', [[...existing, { lane: role, location: place, query: query || suggested, feedUrl: field(f, 'feed'), enabled: true }]]);
        const salary = field(f, 'salary');
        await rpc('workflow.configure', [{ ...workflow, preferences: field(f, 'preferences'), currency: field(f, 'currency') || 'USD',
          ...(salary ? { minimumAnnualSalary: Number(salary) } : { minimumAnnualSalary: undefined }), excludedEmployers: lines(field(f, 'employers')) }]);
        await rpc('settings.save', [{ timeZone: field(f, 'timeZone'), drafting: data.settings.drafting }]);
        next();
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save.'); } finally { setBusy(false); }
    })();
  }}>
    <div className="ck-card ck-card--strong"><h2 id="prefs-title">What kind of job are you looking for?</h2>
      <p className="ck-muted" style={{ margin: 0 }}>This becomes your first saved search. You can add more, one per kind of role and place, in Settings.</p></div>
    {error && <p role="alert" className="ck-alert" style={{ margin: 0 }}>{error}</p>}
    <div className="ck-card">
      <div className="jobsFormGrid">
        <label>Role or field<input name="role" maxLength={120} placeholder="For example: data analyst" value={role} onChange={(event) => setRole(event.target.value)} /></label>
        <label>Location<input name="location" maxLength={120} placeholder="Remote, a city, or leave blank" value={place} onChange={(event) => setPlace(event.target.value)} /></label>
      </div>
      <label>Search words<input name="query" minLength={role ? 8 : undefined} maxLength={500} placeholder={suggested || 'Filled in from the role and location'} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <details><summary>Add a Google Alert feed (optional)</summary>
        <p>Create a Google Alert for these words, choose <q>Deliver to: RSS feed</q>, and paste its address.</p>
        <label>Google Alert RSS feed address<input name="feed" type="url" /></label></details>
    </div>
    <div className="ck-card">
      <div className="jobsFormGrid">
        <label>Minimum yearly salary (optional)<input name="salary" type="number" min={0} step={1000} defaultValue={workflow.minimumAnnualSalary} /></label>
        <label>Currency<input name="currency" pattern="[A-Z]{3}" maxLength={3} defaultValue={workflow.currency} /></label>
      </div>
      <label>Employers to skip, one per line<textarea name="employers" rows={3} defaultValue={workflow.excludedEmployers.join('\n')} /></label>
      <label>Anything else your assistant should know<textarea name="preferences" rows={3} maxLength={5000} placeholder="For example: I want hybrid roles near the Blue Line, and I prefer smaller teams." defaultValue={workflow.preferences} /></label>
      <label>Your time zone<input name="timeZone" list="welcomeZones" required defaultValue={zone} /></label>
      <datalist id="welcomeZones">{Intl.supportedValuesOf('timeZone').map((name) => <option key={name} value={name} />)}</datalist>
    </div>
    <div className="ck-row"><button className="ck-btn ck-btn--primary" disabled={busy}>Save and continue</button>
      <button type="button" className="ck-btn ck-btn--ghost" onClick={next}>Skip for now</button></div>
  </form>;
}

function ResumeStep({ data, rpc, next }: { data: any; rpc: Rpc; next: () => void }) {
  const [text, setText] = useState(''), [source, setSource] = useState(''), [error, setError] = useState(''), [status, setStatus] = useState(''), [busy, setBusy] = useState(false);
  const count = lines(text).length;
  const read = async (file: File) => {
    setBusy(true); setError(''); setStatus(`Reading ${file.name}…`);
    try {
      const response = await fetch('/api/resume/extract', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'This file could not be read.');
      setText(result.data.text); setSource(`Imported from ${file.name} on ${today()}`);
      setStatus(`Read ${result.data.lines} lines from ${file.name}. Check them below before adding.`);
    } catch (cause) { setStatus(''); setError(cause instanceof Error ? cause.message : 'This file could not be read.'); } finally { setBusy(false); }
  };
  return <section className="ck-stack" aria-labelledby="resume-title">
    <div className="ck-card ck-card--strong"><h2 id="resume-title">Add your current résumé</h2>
      <p className="ck-muted" style={{ margin: 0 }}>Each line becomes one claim. Nothing is used in an application until you approve it, and your words are never rewritten. The file is read on this computer and is not uploaded anywhere.</p>
      {data.truthCount > 0 && <p className="t-ok" style={{ margin: 0 }}>You already have {data.truthCount} claims. New lines are added; lines you already have are skipped.</p>}</div>
    {error && <p role="alert" className="ck-alert" style={{ margin: 0 }}>{error}</p>}
    {status && <p role="status" style={{ margin: 0 }}>{status}</p>}
    <div className="ck-card">
      <label className="ck-drop">Choose a résumé file (PDF, Word .docx or text)
        <input type="file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" disabled={busy}
          onChange={(event) => { const file = event.target.files?.[0]; if (file) void read(file); }} /></label>
      <label>Résumé text{count ? ` · ${count} line${count === 1 ? '' : 's'}` : ''}
        <textarea rows={14} value={text} maxLength={100000} placeholder="Or paste your résumé here." onChange={(event) => { setText(event.target.value); if (!source) setSource(`Pasted into the setup guide on ${today()}`); }} /></label>
      <label>Where this came from<input value={source} minLength={8} maxLength={1000} onChange={(event) => setSource(event.target.value)} placeholder="For example: My 2026 résumé" /></label>
      <p className="ck-muted" style={{ margin: 0 }}>Prefer your assistant? Attach the file in Claude or ChatGPT and say <q>Import my résumé into Job Search Harness.</q> It keeps roles grouped.</p>
    </div>
    <div className="ck-row">
      <button type="button" className="ck-btn ck-btn--primary" disabled={busy || !count || source.trim().length < 8} onClick={() => {
        setBusy(true); setError('');
        void rpc('truth.importText', [text, source.trim()]).then(() => next()).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not add these claims.')).finally(() => setBusy(false));
      }}>Add {count || ''} claims to review</button>
      <button type="button" className="ck-btn ck-btn--ghost" onClick={next}>Skip for now</button>
    </div>
  </section>;
}

export function Welcome({ data, rpc }: { data: any; rpc: Rpc }) {
  const [step, setStep] = useState(0);
  const go = (next: number) => { setStep(next); window.scrollTo({ top: 0 }); };
  return <>
    <PageHead kicker="Setup" title="Welcome to Job Search Harness" description="Three short steps and you’re ready. Everything stays on this computer." />
    <Stepper step={step} go={go} />
    {step === 0 ? <ConnectStep data={data} rpc={rpc} next={() => go(1)} />
      : step === 1 ? <PreferencesStep data={data} rpc={rpc} next={() => go(2)} />
        : step === 2 ? <ResumeStep data={data} rpc={rpc} next={() => { markWelcomed(); go(3); }} />
          : <section className="ck-card ck-card--strong" aria-labelledby="done-title">
            <h2 id="done-title">You’re set up</h2>
            <ol style={{ margin: 0, paddingLeft: '1.4rem' }}>
              <li><strong>Approve your claims.</strong> Only approved wording can go into an application.</li>
              <li><strong>Ask your assistant</strong> something like <q>Find jobs that fit my Job Search Harness preferences.</q></li>
              <li><strong>Choose the roles you want</strong> on Leads, and approve each application before anything is sent.</li>
            </ol>
            <div className="ck-row">
              <a className="ck-btn ck-btn--primary" href="/jobs/truths" onClick={markWelcomed}>Review my claims</a>
              <a className="ck-btn" href="/jobs" onClick={markWelcomed}>Go to Today</a>
            </div>
          </section>}
  </>;
}
