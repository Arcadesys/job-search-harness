import { z } from 'zod';
import { reviewBatchSchema } from '../../lib/resume-truth-review';
import { leaseSchema, claimSchema } from './queue';
import { draftBindingSchema } from './submission-draft';

const id = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(1000);
const lease = leaseSchema;
export const methodSchemas = {
  health: z.tuple([]),
  'truth.list': z.tuple([]),
  'truth.versions': z.tuple([z.string().min(1).max(160)]),
  'truth.review': z.tuple([reviewBatchSchema]),
  'leads.list': z.tuple([]),
  'leads.add': z.tuple([
    z
      .object({
        url: z.url().max(2000),
        title: z.string().min(1).max(250),
        organization: z.string().max(200).optional(),
        location: z.string().max(160).optional(),
        notes: z.string().max(4000).optional(),
      })
      .strict(),
  ]),
  'leads.update': z.tuple([
    z
      .object({
        id,
        decision: z.enum(['review', 'keep', 'pass']).optional(),
        stage: z
          .enum(['researching', 'preparing', 'applied', 'interviewing', 'offer', 'closed'])
          .optional(),
        verification: z.enum(['unverified', 'verified', 'stale', 'unavailable']).optional(),
        nextAction: z.string().max(500).optional(),
        nextActionDate: z.iso.date().optional(),
        notes: z.string().max(4000).optional(),
      })
      .strict(),
  ]),
  'leads.import': z.tuple([
    z
      .array(
        z
          .object({
            title: z.string().min(1).max(250),
            organization: z.string().max(200),
            location: z.string().max(160),
            url: z.url().max(2000),
            receivedAt: z.iso.datetime().optional(),
          })
          .strict(),
      )
      .max(100),
  ]),
  'search.settings': z.tuple([]),
  'search.save': z.tuple([
    z
      .array(
        z
          .object({
            id: z.string().max(60),
            query: z.string().max(500),
            feedUrl: z.string().max(2000),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .length(6),
  ]),
  'search.run': z.tuple([]),
  'draft.read': z.tuple([id]),
  'draft.posting': z.tuple([id, z.string().min(200).max(30000), z.string().min(8).max(500)]),
  'draft.assess': z.tuple([id]),
  'draft.edit': z.tuple([id, z.string().max(12000), z.string().max(3000)]),
  'draft.pdf': z.tuple([id]),
  'draft.approve': z.tuple([id, z.string().min(1).max(100)]),
  'batches.list': z.tuple([]),
  'batches.create': z.tuple([z.array(id).min(1).max(30)]),
  'batches.select': z.tuple([z.uuid()]),
  'batches.items': z.tuple([z.uuid()]),
  'items.read': z.tuple([z.uuid()]),
  'items.claim': z.tuple([claimSchema]),
  'items.renew': z.tuple([lease]),
  'items.status': z.tuple([
    lease.extend({
      status: z.enum(['preparing', 'awaiting_approval', 'blocked', 'skipped']),
      note: text,
    }),
  ]),
  'items.requeue': z.tuple([z.uuid(), text]),
  'submission.begin': z.tuple([lease.extend(draftBindingSchema.shape)]),
  'submission.uncertain': z.tuple([z.uuid(), text.min(1)]),
  'submission.notSubmitted': z.tuple([z.uuid(), text.min(8)]),
  'submission.record': z.tuple([
    z
      .object({
        itemId: z.uuid(),
        attemptId: z.uuid().optional(),
        idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,160}$/),
        confirmation: text.min(1),
        confirmationUrl: z.url().max(2000).optional(),
      })
      .strict(),
  ]),
  'review.read': z.tuple([]),
  'review.event': z.tuple([
    z
      .object({
        leadId: id,
        type: z.enum(['kept', 'reply', 'interview', 'offer']),
        date: z.iso.date(),
        note: text.optional(),
      })
      .strict(),
  ]),
  'review.complete': z.tuple([z.iso.date()]),
  'review.outcome': z.tuple([
    z
      .object({
        type: z.enum(['hiring_inquiry', 'conversation_booked']),
        date: z.iso.date(),
        evidenceRef: z.string().min(1).max(160),
      })
      .strict(),
  ]),
  'review.removeOutcome': z.tuple([z.string().regex(/^\d{1,18}$/)]),
  backup: z.tuple([]),
  'browser.open': z.tuple([]),
} as const;
export type Method = keyof typeof methodSchemas;
export type Args<M extends Method> = z.infer<(typeof methodSchemas)[M]>;
export const rpcSchema = z
  .object({
    method: z.enum(Object.keys(methodSchemas) as [Method, ...Method[]]),
    args: z.array(z.unknown()).max(4),
  })
  .strict();
