import { ingestLinkedInEmailLeads, type LinkedInEmailLead } from '../lib/job-discovery';

async function main() {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  const records = JSON.parse(chunks.join('')) as LinkedInEmailLead[];
  if (!Array.isArray(records) || records.length > 100) throw new Error('Provide up to 100 extracted LinkedIn job alert leads.');
  const result = await ingestLinkedInEmailLeads(records);
  console.log(JSON.stringify(result));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : 'Import failed.'); process.exitCode = 1; });
