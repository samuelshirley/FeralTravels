import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';
import { taskPrioritySchema, urlSchema } from './shared';

export const ADD_TASK = 'add_task' as const;

const dataSchema = z.object({
  title: z.string().min(1, 'title is required'),
  description: z.string().nullish(),
  priority: taskPrioritySchema.nullish(),
  reference_url: urlSchema.nullish(),
  reference_label: z.string().nullish(),
  reference_phone: z.string().nullish(),
  due_at: z.string().nullish(),
});

const baseSchema = z.object({
  leg_id: z.string().uuid().nullable().optional(),
  data: dataSchema,
});

export type AddTaskInput = z.infer<typeof baseSchema>;

export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: ADD_TASK,
  description:
    'Add a follow-up task. Common uses: "Pick tonight\'s stop" after proposing overnight options; "Confirm ferry booking"; reminders to verify Penny-sourced placeholder spots. Set leg_id when the task is about a specific leg, null/omit when it\'s trip-level.',
  input_schema: {
    type: 'object',
    required: ['data'],
    properties: {
      leg_id: { type: ['string', 'null'], format: 'uuid' },
      data: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'normal', 'high'] },
          reference_url: { type: 'string', format: 'uri' },
          reference_label: { type: 'string' },
          reference_phone: { type: 'string' },
          due_at: { type: 'string' },
        },
      },
    },
  },
};
