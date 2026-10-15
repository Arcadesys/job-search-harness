import assert from 'node:assert/strict';
import test from 'node:test';
import { builtinJobUrl, parseBuiltinJob, parseBuiltinListing } from './job-collection';

const job = { '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Delivery Manager',
  description: `<p>${'Coordinate programs with approved experience. '.repeat(10)}</p>`, hiringOrganization: { name: 'Example Employer' },
  jobLocation: { address: { addressLocality: 'Chicago', addressRegion: 'IL' } },
  baseSalary: { currency: 'USD', value: { unitText: 'YEAR', minValue: 100000, maxValue: 150000 } } };
export const jobHtml = (changes: Record<string, unknown> = {}) => `<html><script type="application/ld&#x2B;json">${JSON.stringify({ '@graph': [{ ...job, ...changes }] })}</script></html>`;

test('Built In parser handles encoded JSON-LD types, graphs, unknown fields and bounded listings', () => {
  const record = parseBuiltinJob(jobHtml(), 'https://www.builtinchicago.org/job/delivery-manager/123');
  assert.equal(record.sourceKey, '123');
  assert.equal(record.organization, 'Example Employer');
  assert.equal(record.location, 'Chicago, IL');
  assert.equal(record.salary?.maximum, 150000);
  const missing = parseBuiltinJob(jobHtml({ baseSalary: undefined, jobLocation: undefined }), 'https://www.builtinchicago.org/job/delivery-manager/123');
  assert.equal(missing.salary, null); assert.equal(missing.location, null);
  assert.deepEqual(parseBuiltinListing('<main>No jobs found</main>').urls, []);
  assert.throws(() => parseBuiltinListing('<main>Sign in or enable Javascript</main>'), /extraction/);
  assert.throws(() => parseBuiltinJob('<script type="application/ld+json">bad json</script>', record.url), /valid JobPosting/);
  assert.deepEqual(parseBuiltinListing('<a href="/job/one/1">One</a><a href="/job/one/1">Duplicate</a><a href="/jobs?page=2">Next</a>').urls, ['https://www.builtinchicago.org/job/one/1']);
  assert.throws(() => builtinJobUrl('https://attacker.test/job/one/1'), /public/);
  assert.throws(() => builtinJobUrl('https://www.builtinchicago.org/jobs?page=2'), /public/);
});
