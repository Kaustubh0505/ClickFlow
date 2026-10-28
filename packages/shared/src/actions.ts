import { z } from 'zod';
import { httpUrlSchema, idSchema, textSchema } from './primitives.js';

export const targetSchema = z.discriminatedUnion('strategy', [
  z.strictObject({ strategy: z.literal('element_ref'), observationId: idSchema, ref: idSchema }),
  z.strictObject({ strategy: z.literal('role'), role: z.enum(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'option', 'tab', 'menuitem', 'searchbox']), name: textSchema, exact: z.boolean().default(true) }),
  z.strictObject({ strategy: z.literal('label'), label: textSchema, exact: z.boolean().default(true) }),
  z.strictObject({ strategy: z.literal('text'), text: textSchema, exact: z.boolean().default(true) }),
  z.strictObject({ strategy: z.literal('selector'), selector: z.string().min(1).max(500) }),
  z.strictObject({ strategy: z.literal('semantic'), description: textSchema }),
]);

const timeoutMs = z.number().int().min(100).max(60_000).default(10_000);

export const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('observe'), timeoutMs }),
  z.strictObject({ type: z.literal('navigate'), url: httpUrlSchema, timeoutMs }),
  z.strictObject({ type: z.literal('click'), target: targetSchema, timeoutMs }),
  z.strictObject({ type: z.literal('type'), target: targetSchema, text: z.string().min(1).max(10_000), timeoutMs }),
  z.strictObject({ type: z.literal('clear_input'), target: targetSchema, timeoutMs }),
  z.strictObject({ type: z.literal('select_option'), target: targetSchema, value: z.string().min(1).max(1_000), timeoutMs }),
  z.strictObject({ type: z.literal('scroll'), direction: z.enum(['up', 'down', 'left', 'right']), pixels: z.number().int().min(1).max(10_000), timeoutMs }),
  z.strictObject({ type: z.literal('press_key'), target: targetSchema, key: z.enum(['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Backspace', 'Delete', 'Home', 'End']), timeoutMs }),
  z.strictObject({ type: z.literal('wait'), timeoutMs }),
  z.strictObject({ type: z.literal('go_back'), timeoutMs }),
  z.strictObject({ type: z.literal('go_forward'), timeoutMs }),
  z.strictObject({ type: z.literal('extract_text'), target: targetSchema, outputKey: idSchema, maxCharacters: z.number().int().min(1).max(20_000).default(5_000), timeoutMs }),
  z.strictObject({ type: z.literal('finish'), timeoutMs }),
]);

export type Target = z.infer<typeof targetSchema>;
export type Action = z.infer<typeof actionSchema>;
