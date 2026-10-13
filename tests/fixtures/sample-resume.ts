import { resumeImportClaims, type ResumeImport } from '../../lib/resume-truth-review';
import { insertNewTruths, type TruthClaim } from '../../lib/resume-truth';
import type { Sql } from '../../lib/job-storage';

/** A fictional person. Each accomplishment restates one role bullet, some
 * verbatim and some paraphrased, so pairing is exercised both ways. */
export const sampleResume: ResumeImport = {
  sourceNote: 'Imported from the fictional sample résumé used by tests.',
  profile: {
    name: 'Jordan Rivera',
    headline: 'Program Manager | Operations & Delivery',
    location: 'Denver, CO',
    email: 'jordan@example.test',
  },
  summary: 'Program manager who turns messy cross-team work into predictable delivery.',
  accomplishments: [
    'Grew weekly analytics-tool adoption from 12% to 61% of analysts in two quarters while adoption was still climbing elsewhere',
    'Launched a self-serve reporting library used by 40 regional teams',
    'Led a three-city customer workshop series reaching 900 participants',
    'Built Tideline, an internal forecasting assistant for planners',
    'Within three weeks of joining, mapped every open data request and cleared the backlog',
    'Halved quarterly planning time for more than 60 engineers',
    'Raised fulfilment throughput 300% by redesigning the intake queue',
    'Delivered a scheduling tool that supported $40M in annual bookings',
  ],
  experience: [
    {
      employer: 'Maple Analytics', location: 'Remote', title: 'Senior Program Manager', dates: '09/2022 – Present',
      bullets: [
        'Owned the analytics enablement program across four product lines',
        'Grew weekly analytics-tool adoption from 12% to 61% of analysts in two quarters, while adoption was still climbing elsewhere in the company',
        'Launched a self-serve reporting library that 40 regional teams now use',
        'Led a three-city customer workshop series reaching 900 participants',
        'Built Tideline, an internal forecasting assistant that planners use weekly',
        'Ran monthly roadmap reviews with product and finance leads',
        'Wrote the onboarding guide every new analyst receives',
        'Coached six team leads on prioritization',
        'Within three weeks of joining, mapped every open data request and cleared the backlog',
      ],
    },
    {
      employer: 'Copperline Retail', location: 'Austin, TX', title: 'Program Manager', dates: '09/2022 – 09/2022',
      bullets: [
        'Coordinated a point-of-sale migration for 120 stores',
        'Set up the vendor escalation process',
        'Tracked migration risks in a shared register',
      ],
    },
    {
      employer: 'Northwind Logistics', location: 'Denver, CO', title: 'Senior Program Manager & Agile Coach', dates: '06/2019 – 08/2022',
      bullets: [
        'Cut quarterly planning time by 50% for more than 60 engineers by replacing ad hoc sessions with a shared template',
        'Mentored four new scrum masters',
      ],
    },
    {
      employer: 'Brightline Health', location: 'Remote', title: 'Delivery Lead', dates: '03/2017 – 05/2019',
      bullets: [
        'Raised fulfilment throughput 300% after redesigning the intake queue with the operations team',
        'Introduced weekly demo sessions for stakeholders',
      ],
    },
    {
      employer: 'Harbor Mortgage', location: 'Boulder, CO', title: 'Project Manager', dates: '01/2014 – 02/2017',
      bullets: [
        'Managed the loan-tracking dashboard release',
        'Delivered a scheduling tool that supported $40M in annual bookings for the branch network',
        'Documented the release checklist',
      ],
    },
  ],
  earlier: ['Volunteer coordinator, Front Range Food Bank (2010 – 2013)'],
  skills: ['Delivery: roadmaps, risk registers, planning', 'Tools: Jira, Airtable, SQL'],
  education: ['B.A., Communication, Colorado State University'],
};

export const sampleClaims = (): TruthClaim[] => resumeImportClaims(sampleResume);

/** Idempotent, like the old startup seed: reopening a test store adds nothing. */
export const loadSample = (store: { run: <T>(operation: (sql: Sql) => Promise<T>) => Promise<T> }) =>
  store.run((sql) => insertNewTruths(sampleClaims(), sql));
