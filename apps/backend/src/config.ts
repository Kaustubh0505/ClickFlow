import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DEFAULT_MODEL_BASE_URL, DEFAULT_MODEL_NAME, httpUrlSchema } from '@clickflow/shared';

export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

const envSchema = z.object({
  MODEL_API_KEY: z.string().default(''),
  MODEL_BASE_URL: httpUrlSchema.default(DEFAULT_MODEL_BASE_URL),
  MODEL_NAME: z.string().trim().min(1).max(200).default(DEFAULT_MODEL_NAME),
  PORT: z.coerce.number().int().min(0).max(65_535).default(3001),
  DATA_DIR: z.string().trim().min(1).default('.data'),
});

export function parseConfig(environment: NodeJS.ProcessEnv) {
  const result = envSchema.safeParse(environment);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid backend configuration: ${fields.join(', ')}. Check .env.example.`);
  }
  return { ...result.data, DATA_DIR: resolve(repositoryRoot, result.data.DATA_DIR) };
}

export function loadConfig() {
  try {
    loadEnvFile(resolve(repositoryRoot, '.env'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return parseConfig(process.env);
}

export type BackendConfig = ReturnType<typeof parseConfig>;
