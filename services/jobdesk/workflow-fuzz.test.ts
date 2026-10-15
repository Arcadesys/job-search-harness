import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { JobdeskStore } from './store';
import { createService, initializeService } from './service';
import { tempRoot } from '../../tests/fixtures/temp-root';
import { loadSample } from '../../tests/fixtures/sample-resume';
import { leadIdForUrl } from '../../lib/job-discovery';
import { PACKET_LIMIT, TEMPLATE_VERSION } from '../../lib/job-workflow';
import { payloadBytes } from '../../lib/workflow-hash';
import { parseBuiltinJob, runCollection } from '../../lib/job-collection';
import { buildMaterials } from './materials';

// No wall-clock randomness, live services, or private stores. The seed controls
// commands and injected faults; generated UUIDs/timestamps are opaque identities.
function random(seed: number) {
  let state = seed >>> 0;
  return (limit: number) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) % limit;
  };
}
function boundedEnv(name: string, fallback: number, maximum: number) {
  if (process.env[name] === undefined) return fallback;
  const value = Number(process.env[name]);
  assert.ok(Number.isInteger(value) && value >= 0 && value <= maximum, `${name} must be an integer from 0 to ${maximum}`);
  return value;
}
const seeds = process.env.JOBDESK_FUZZ_SEED === undefined ? [1, 0xc0ffee, 0xdeadbeef]
  : [boundedEnv('JOBDESK_FUZZ_SEED', 1, 0xffffffff)];
const steps = boundedEnv('JOBDESK_FUZZ_STEPS', 64, 5000);
const posting = (version: number) => `Coordinate delivery and accessible analytics programs. Evidence revision ${version}. `.repeat(8);
const claimIds = ['experience.1.claim.1', 'experience.1.claim.2'];
type SavedWork = { id: string; hash: string; attempts: number; result?: any };

for (const seed of seeds) {
  test(`seeded workflow state machine seed=${seed}`, async () => {
    const pick = random(seed), trace: string[] = [];
    let root = await tempRoot('jobdesk-fuzz-');
    const roots = [root];
    let store = await JobdeskStore.open(root);
    await initializeService(store); await loadSample(store);
    await store.sql`UPDATE resume_truth_claims SET review_status='reviewed'`;
    let call = createService(store);
    const rpc = (method: string, ...args: any[]): Promise<any> => call({ method, args });
    const url = 'https://example.test/jobs/seeded-delivery';
    const leadId = leadIdForUrl(url);
    await rpc('leads.add', { url, title: 'Delivery Manager', organization: 'Fictional Employer' });
    await rpc('draft.posting', leadId, posting(0), 'Original posting verified for this fictional test.');
    let claims: any[] = await rpc('truth.list');
    let postingVersion = 0, criteria = 0, excluded = false, links = 0, revision = '', decision = 'review';
    const work = new Map<string, SavedWork>();
    const byId = new Map<string, SavedWork>();
    const materials = new Map<string, any>();
    const restored = new Set<string>();
    const corrupted = new Set<string>();
    const note = 'User note must survive every machine action.';
    await rpc('leads.update', { id: leadId, notes: note, decision, verification: 'verified' });
    // Reference keys describe user inputs directly. They deliberately do not
    // call production fingerprint/context helpers or predict database hashes.
    const assessmentKey = () => JSON.stringify([postingVersion, criteria, excluded,
      claims.filter((c) => c.reviewStatus === 'reviewed').map((c) => [c.id, c.version])]);
    const selectionKey = () => JSON.stringify([assessmentKey(), revision]);
    const configure = () => rpc('workflow.configure', { preferences: `Preference ${criteria}`,
      minimumAnnualSalary: 200000, excludedEmployers: excluded ? ['Fictional Employer'] : [],
      links: links ? [{ label: 'Example portfolio', url: 'https://example.test/portfolio' }] : [] });
    const key = (stage: string) => `${stage}:${stage === 'assessment' ? assessmentKey() : selectionKey()}`;
    const valid = (stage: string) => stage === 'assessment'
      ? { recommendation: 'candidate', reasons: [{ text: 'Delivery evidence.', evidence: 'Coordinate delivery' }], uncertainties: [], claimIds: [] }
      : { template: TEMPLATE_VERSION, sections: [{ kind: 'experience', claimIds: pick(2) ? claimIds : [...claimIds].reverse() }], outreach: false, unresolved: [] };
    async function packet(stage: 'assessment' | 'selection') {
      const packet = await rpc('workflow.packet', { leadId, stage, ...(stage === 'selection' ? { revision } : {}) });
      assert.ok(payloadBytes(packet) <= PACKET_LIMIT);
      const existing = work.get(key(stage));
      if (existing) {
        assert.equal(packet.id, existing.id, 'identical semantic inputs reuse the same durable stage');
        assert.equal(packet.inputHash, existing.hash);
        if (existing.result) { assert.equal(packet.reused, true); assert.deepEqual(packet.result, existing.result); }
        else if (existing.attempts >= 2) assert.equal(packet.state, 'needs_attention');
      } else {
        assert.equal(packet.reused, false);
        const entry = { id: packet.id, hash: packet.inputHash, attempts: 0 };
        work.set(key(stage), entry); byId.set(packet.id, entry);
      }
      return packet;
    }
    async function save(stage: 'assessment' | 'selection', invalid = false) {
      if (stage === 'selection' && !(await save('assessment'))) return false;
      const p = await packet(stage), expected = work.get(key(stage))!;
      const result = invalid ? { invented: 'unapproved text', claimIds: ['missing-claim'] } : valid(stage);
      const outcome = await rpc('workflow.save', { packetId: p.id, inputHash: p.inputHash, result });
      if (expected.result) { assert.equal(outcome.reused, true); return true; }
      if (expected.attempts >= 2) { assert.equal(outcome.state, 'needs_attention'); return false; }
      expected.attempts++;
      const approved = claimIds.every((id) => claims.some((c) => c.id === id && c.reviewStatus === 'reviewed'));
      if (invalid || (stage === 'selection' && !approved)) {
        assert.equal(outcome.state, expected.attempts === 2 ? 'needs_attention' : 'pending');
        return false;
      }
      assert.equal(outcome.state, 'complete'); expected.result = result;
      return true;
    }
    async function reopen(restoreBackup: boolean) {
      const before = await snapshot();
      if (restoreBackup && corrupted.size) {
        await assert.rejects(store.backup(), /checksum mismatch/, 'a backup must not silently accept a damaged historical artifact');
        restoreBackup = false;
      }
      if (restoreBackup) {
        const backup = await store.backup();
        await store.close();
        root = await tempRoot('jobdesk-fuzz-restored-'); roots.push(root);
        const dump = new Blob([new Uint8Array(await readFile(path.join(backup.directory, 'database.tar.gz')))]);
        store = await JobdeskStore.open(root, undefined, dump, async (destination) => {
          await mkdir(path.join(destination, 'artifacts'), { recursive: true });
          await cp(path.join(backup.directory, 'artifacts'), path.join(destination, 'artifacts'), { recursive: true });
        });
      } else { await store.close(); store = await JobdeskStore.open(root); }
      await initializeService(store); call = createService(store);
      assert.deepEqual(await snapshot(), before, 'restart/restore preserves decisions, stages, exclusions, artifacts and receipts');
    }
    async function snapshot() {
      const tables = ['job_leads', 'job_work_stages', 'job_exclusions', 'job_material_manifests', 'job_application_drafts', 'jobdesk_artifacts', 'job_application_receipts'];
      const result: Record<string, unknown> = {};
      for (const table of tables) result[table] = (await store.db.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
      return result;
    }
    async function invariants() {
      await rpc('workflow.status', { leadId });
      const [lead] = await store.sql`SELECT decision,notes FROM job_leads WHERE id=${leadId}`;
      assert.equal(lead.decision, decision); assert.equal(lead.notes, note);
      for (const row of await store.sql`SELECT * FROM job_work_stages WHERE lead_id=${leadId}`) {
        const expected = byId.get(row.id)!;
        assert.ok(expected, 'no spontaneous model work');
        assert.equal(row.attempts, expected.attempts);
        assert.ok(row.attempts <= 2, 'at most one targeted repair');
        assert.deepEqual(row.result ?? undefined, expected.result);
      }
      const current = await store.sql`SELECT * FROM job_material_manifests WHERE lead_id=${leadId} AND state='current'`;
      assert.ok(current.length <= 1, 'only one current material version');
      for (const row of await store.sql`SELECT attempts FROM job_material_manifests WHERE lead_id=${leadId}`)
        assert.ok(row.attempts <= 2, 'rendering also permits at most one repair');
      for (const row of current) for (const used of row.manifest.claims) {
        const claim = claims.find((c) => c.id === used.id);
        assert.equal(claim?.reviewStatus, 'reviewed'); assert.equal(used.claim, claim.claim); assert.equal(used.version, claim.version);
      }
      const jobs = await rpc('workflow.jobs', {});
      const visible = jobs.jobs.some((j: any) => j.id === leadId);
      assert.equal(visible, decision === 'keep' || (decision !== 'pass' && (!excluded || restored.has(assessmentKey()))), 'unknown salary never excludes; restore applies only to its input version');
    }
    const actions = {
      assess: () => save('assessment'),
      invalid: () => save(pick(2) ? 'assessment' : 'selection', true),
      select: () => save('selection'),
      criteria: async () => { criteria = pick(4); await configure(); },
      posting: async () => { postingVersion = pick(3); await rpc('draft.posting', leadId, posting(postingVersion), 'Original posting verified for this fictional test.'); },
      revision: async () => { revision = `Revision ${pick(3)}`; await save('selection'); },
      claim: async () => {
        const id = pick(2) ? claimIds[pick(claimIds.length)] : 'skills.1';
        const claim = claims.find((c) => c.id === id)!;
        const outcome = await rpc('truth.review', { changes: [{ id, expectedVersion: claim.version, reviewStatus: pick(2) ? 'reviewed' : 'rejected',
          ...(pick(3) === 0 ? { claim: `${claim.claim} Fictional corrected evidence.` } : {}) }] });
        assert.deepEqual(outcome.conflicts, []);
        claims = await rpc('truth.list');
      },
      stale: async () => {
        const p = await packet('assessment');
        criteria = (criteria + 1) % 4; await configure();
        await assert.rejects(rpc('workflow.save', { packetId: p.id, inputHash: p.inputHash, result: valid('assessment') }), /Inputs changed/);
      },
      exclusion: async () => {
        excluded = !excluded; await configure();
        if (excluded && pick(2)) {
          const exclusions: any[] = [];
          let offset: number | null = 0;
          while (offset !== null) {
            const page = await rpc('exclusions.list', { offset });
            exclusions.push(...page.exclusions); offset = page.nextOffset;
          }
          const current = exclusions.find((e: any) => e.current && e.lead_id === leadId && e.rule === 'employer');
          assert.ok(current?.evidence);
          await rpc('exclusions.restore', current.id); restored.add(assessmentKey());
        }
      },
      decision: async () => { decision = ['review', 'keep', 'pass'][pick(3)]; await rpc('leads.update', { id: leadId, notes: note, decision, verification: 'verified' }); },
      links: async () => { links = 1 - links; await configure(); },
      build: async () => {
        if (!(await save('selection'))) return;
        if (decision === 'pass') { await assert.rejects(rpc('workflow.build', { leadId }), /passed/); return; }
        const selection = work.get(key('selection'))!.result;
        const selected = selection.sections.flatMap((s: any) => s.claimIds);
        const usedIds = [...selected, ...claims.filter((c) => c.id.startsWith('profile.')).map((c) => c.id), 'experience.1.employer', 'experience.1.title', 'experience.1.dates'];
        const materialKey = JSON.stringify([postingVersion, links, selection, claims.filter((c) => usedIds.includes(c.id)).map((c) => [c.id, c.version])]);
        const built = await rpc('workflow.build', { leadId });
        const previous = materials.get(materialKey);
        if (previous) { assert.equal(built.id, previous.id); assert.equal(built.reused, true); }
        if (built.state !== 'current') { assert.equal(built.state, 'needs_attention'); return; }
        materials.set(materialKey, built);
        const repeat = await rpc('workflow.build', { leadId });
        assert.equal(repeat.reused, true); assert.deepEqual(repeat.artifacts, built.artifacts);
        await rpc('workflow.review', { id: built.id, inputHash: built.inputHash, passed: true, note: 'Synthetic state-machine assertion; rendered QA is separate.' });
        const [draft] = await store.sql`SELECT updated_at::text AS version FROM job_application_drafts WHERE lead_id=${leadId}`;
        await rpc('draft.approve', leadId, draft.version);
      },
      corrupt: async () => {
        const [current] = await store.sql`SELECT * FROM job_material_manifests WHERE lead_id=${leadId} AND state='current'`;
        if (!current || corrupted.has(current.id)) return;
        corrupted.add(current.id);
        await writeFile(path.join(root, current.artifacts[0].relativePath), 'injected corruption');
        await assert.rejects(rpc('workflow.review', { id: current.id, inputHash: current.input_hash, passed: true, note: 'Corruption must prevent approval.' }), /checksum/);
        const [draft] = await store.sql`SELECT updated_at::text AS version FROM job_application_drafts WHERE lead_id=${leadId}`;
        await assert.rejects(rpc('draft.approve', leadId, draft.version), /checksum|Materials need/);
      },
      restart: () => reopen(false),
      backup: () => reopen(true),
    };
    const names = Object.keys(actions) as (keyof typeof actions)[];
    try {
      await configure();
      // Start with a valid artifact; every round shuffles a complete action deck
      // so the default corpus guarantees each fault class, not just a lucky draw.
      await actions.build();
      await reopen(true);
      let deck: typeof names = [];
      for (let step = 0; step < steps; step++) {
        if (!deck.length) {
          deck = [...names];
          for (let i = deck.length - 1; i > 0; i--) { const j = pick(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
        }
        const action = deck.pop()!; trace.push(action);
        await actions[action](); await invariants();
      }
    } catch (error) {
      throw new Error(`Workflow fuzz seed=${seed} step=${trace.length}; replay JOBDESK_FUZZ_SEED=${seed} JOBDESK_FUZZ_STEPS=${trace.length} npm run test:jobdesk:fuzz\nTrace: ${trace.join(' -> ')}`, { cause: error });
    } finally { await store.close(); for (const directory of roots) await rm(directory, { recursive: true, force: true }); }
  });

  test(`seeded collection faults seed=${seed}`, async () => {
    const pick = random(seed), root = await tempRoot('jobdesk-collection-fuzz-');
    let store = await JobdeskStore.open(root);
    await initializeService(store);
    const urls = Array.from({ length: 4 }, (_, i) => `https://www.builtinchicago.org/job/fictional/${i + 1}`);
    const failures = urls.map((_, i) => (i + pick(3)) % 3); // 0 valid, 1 HTTP fault, 2 malformed JSON-LD
    failures[0] = 0; failures[1] = 1; failures[2] = 2;
    const requests: string[] = [];
    let recovered = false;
    const html = (title: string) => `<script type="application/ld&#x2B;json">${JSON.stringify({ '@type': 'JobPosting', title, description: posting(seed), hiringOrganization: { name: 'Fictional Employer' } })}</script>`;
    const fetcher: typeof fetch = async (url) => {
      requests.push(String(url));
      if (String(url).endsWith('/jobs')) return new Response(urls.flatMap((u) => [`<a href="${u}">Job</a>`, `<a href="${u}#duplicate">Duplicate</a>`]).join(''));
      const i = urls.indexOf(String(url)); assert.ok(i >= 0, 'collection stays within supplied fixture targets');
      if (!recovered && failures[i] === 1) return new Response('', { status: 503 });
      if (!recovered && failures[i] === 2) return new Response('<script type="application/ld+json">{bad JSON</script>');
      return new Response(html(`Fictional Role ${i}`));
    };
    try {
      const first = await runCollection({ source: 'builtin', urls: [] }, store, { fetcher, delayMs: 0 });
      const failed = failures.filter(Boolean).length;
      assert.equal(first.counts.saved, urls.length - failed); assert.equal(first.counts.failed, failed);
      assert.equal(requests.length, urls.length + 1, 'duplicate links fetched once');
      const id = leadIdForUrl(urls[0]);
      await store.sql`UPDATE job_leads SET notes='Human evidence',decision='keep' WHERE id=${id}`;
      await store.close(); store = await JobdeskStore.open(root); await initializeService(store);
      recovered = true;
      const resumed = await runCollection({ source: 'builtin', runId: first.id, urls: [] }, store, { fetcher, delayMs: 0 });
      assert.equal(resumed.counts.saved, urls.length); assert.equal(resumed.counts.failed, 0);
      assert.equal(requests.length, urls.length + 1 + failed, 'restart resumes only failures');
      const before = requests.length;
      await runCollection({ source: 'builtin', runId: first.id, urls: [] }, store, { fetcher, delayMs: 0 });
      assert.equal(requests.length, before, 'completed run never refetches');
      await runCollection({ source: 'builtin', urls: [urls[0], urls[0]] }, store, { fetcher, delayMs: 0 });
      assert.equal(Number((await store.sql`SELECT count(*) AS n FROM job_source_observations WHERE lead_id=${id}`)[0].n), 1, 'unchanged rediscovery adds no duplicate observations');
      const [lead] = await store.sql`SELECT decision,notes,location FROM job_leads WHERE id=${id}`;
      assert.equal(lead.decision, 'keep'); assert.equal(lead.notes, 'Human evidence'); assert.equal(lead.location, '');
    } catch (error) { throw new Error(`Collection fuzz seed=${seed}; replay JOBDESK_FUZZ_SEED=${seed} npm run test:jobdesk:fuzz`, { cause: error }); }
    finally { await store.close(); await rm(root, { recursive: true, force: true }); }
  });
}

for (const mutation of ['selection', 'pass', 'verification', 'criteria', 'claim'] as const) {
test(`render commit interleaving rejects ${mutation} changes`, async () => {
  const root = await tempRoot('jobdesk-render-race-');
  const store = await JobdeskStore.open(root);
  const originalRun = store.run.bind(store);
  let release!: () => void;
  try {
    await initializeService(store); await loadSample(store);
    await store.sql`UPDATE resume_truth_claims SET review_status='reviewed'`;
    const call = createService(store);
    const rpc = (method: string, ...args: any[]): Promise<any> => call({ method, args });
    const url = 'https://example.test/jobs/render-race', leadId = leadIdForUrl(url);
    await rpc('leads.add', { url, title: 'Fictional Role', organization: 'Example Employer' });
    await rpc('draft.posting', leadId, posting(0), 'Original verified for fictional render-race test.');
    async function select(reverse: boolean) {
      const a = await rpc('workflow.packet', { leadId, stage: 'assessment' });
      await rpc('workflow.save', { packetId: a.id, inputHash: a.inputHash,
        result: { recommendation: 'candidate', reasons: [{ text: 'Delivery.', evidence: 'Coordinate delivery' }], uncertainties: [], claimIds: [] } });
      const s = await rpc('workflow.packet', { leadId, stage: 'selection', revision: reverse ? 'Reverse priority' : '' });
      await rpc('workflow.save', { packetId: s.id, inputHash: s.inputHash,
        result: { template: TEMPLATE_VERSION, sections: [{ kind: 'experience', claimIds: reverse ? [...claimIds].reverse() : claimIds }], outreach: false, unresolved: [] } });
    }
    await select(false);
    let reached!: () => void, calls = 0;
    const atCommit = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // Hold exactly the renderer's second queue entry, after all files are
    // written but before its commit. Other service calls continue normally.
    store.run = async (fn) => {
      if (++calls === 2) { reached(); await gate; }
      return originalRun(fn);
    };
    const old = buildMaterials(leadId, store).then((value) => ({ value }), (error: unknown) => ({ error }));
    await Promise.race([atCommit, old.then(() => { throw new Error('Rendering finished before reaching the commit barrier.'); })]);
    let newer: any;
    if (mutation === 'selection') {
      await select(true);
      newer = await rpc('workflow.build', { leadId });
      assert.equal(newer.state, 'current');
    } else if (mutation === 'criteria') await rpc('workflow.configure', { preferences: 'New criteria while rendering' });
    else if (mutation === 'claim') {
      const claims: any[] = await rpc('truth.list'), claim = claims.find((c) => c.id === claimIds[0])!;
      await rpc('truth.review', { changes: [{ id: claim.id, expectedVersion: claim.version, reviewStatus: 'rejected' }] });
    } else await rpc('leads.update', { id: leadId, decision: mutation === 'pass' ? 'pass' : 'review', verification: mutation === 'verification' ? 'unverified' : 'verified' });
    release();
    const outcome = await old;
    assert.ok('error' in outcome, 'old rendering must reject its superseded selection at commit');
    assert.match(String(outcome.error), /changed|stale|selection/i);
    const [draft] = await store.sql`SELECT material_manifest_id FROM job_application_drafts WHERE lead_id=${leadId}`;
    assert.equal(draft?.material_manifest_id, newer?.id);
    const current = await store.sql`SELECT id FROM job_material_manifests WHERE lead_id=${leadId} AND state='current'`;
    assert.deepEqual(current.map((row) => row.id), newer ? [newer.id] : []);
    assert.deepEqual((await readdir(path.join(root, 'artifacts'))).sort(), (newer?.artifacts.map((a: any) => `${a.id}.pdf`) ?? []).sort(), 'rejected render leaves no orphaned files');
    if (newer) {
      await select(false);
      const replacement = await rpc('workflow.build', { leadId, repair: true });
      assert.equal(replacement.state, 'current');
      await assert.rejects(rpc('workflow.review', { id: newer.id, inputHash: newer.inputHash, passed: true, note: 'Late review must not resurrect superseded materials.' }), /changed|current|superseded/i);
      const active = await store.sql`SELECT id FROM job_material_manifests WHERE lead_id=${leadId} AND state='current'`;
      assert.deepEqual(active.map((row) => row.id), [replacement.id]);
    }
  } finally { release?.(); store.run = originalRun; await store.close(); await rm(root, { recursive: true, force: true }); }
});
}

test('seeded source mutations preserve evidence or reject unusable records', () => {
  const seed = seeds[0], pick = random(seed);
  const url = 'https://www.builtinchicago.org/job/fictional/123';
  for (let iteration = 0; iteration < 600; iteration++) {
    const invalid = pick(5) === 0;
    const title = invalid ? ['   ', '<script>irrelevant()</script>', ''][pick(3)] : `Fictional role ${iteration} — café 行業`;
    const record = { '@type': pick(2) ? 'JobPosting' : ['Thing', 'JobPosting'], title, description: `<p>${posting(iteration)}</p><script>not evidence</script>` };
    const wrapped = [{ '@graph': [record] }, [record], record][pick(3)];
    const mime = pick(2) ? 'application/ld+json' : 'application/ld&#x2B;json';
    const html = `<script type="application/ld+json">{invalid unrelated data</script><script type="${mime}">${JSON.stringify(wrapped).replace(/</g, '\\u003c')}</script>`;
    try {
      if (invalid) assert.throws(() => parseBuiltinJob(html, url), /title|JobPosting/);
      else {
        const parsed = parseBuiltinJob(html, url);
        assert.equal(parsed.title, title); assert.equal(parsed.postingText, posting(iteration).trim());
        assert.equal(parsed.location, null); assert.equal(parsed.salary, null); assert.equal(parsed.organization, '');
      }
    } catch (error) { throw new Error(`Source mutation seed=${seed} iteration=${iteration}`, { cause: error }); }
  }
});
