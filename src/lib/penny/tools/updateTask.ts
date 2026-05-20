import 'server-only';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { PennyContext } from '@/lib/penny/context';
import { taskStatusSchema, urlSchema } from './shared';

export const UPDATE_TASK = 'update_task' as const;

const dataSchema = z.object({
  status: taskStatusSchema.nullish(),
  answer: z.string().nullish(),
  answer_source_url: urlSchema.nullish(),
  answer_image_url: urlSchema.nullish(),
});

const baseSchema = z.object({
  task_id: z.string().uuid(),
  data: dataSchema,
});

export type UpdateTaskInput = z.infer<typeof baseSchema>;

export function validator(_ctx: PennyContext) {
  return baseSchema;
}

export const tool: Anthropic.Tool = {
  name: UPDATE_TASK,
  description:
    'Update a task by id — most often to mark a task answered with the answer text, or dismiss a task that\'s no longer relevant.',
  input_schema: {
    type: 'object',
    required: ['task_id', 'data'],
    properties: {
      task_id: { type: 'string', format: 'uuid' },
      data: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['open', 'answered', 'dismissed'] },
          answer: { type: 'string' },
          answer_source_url: { type: 'string', format: 'uri' },
          answer_image_url: { type: 'string', format: 'uri' },
        },
      },
    },
  },
};
