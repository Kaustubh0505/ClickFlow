import { readFile, stat } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { ModelError } from './errors.js';
import { ModelClient } from './model-client.js';
import { Planner } from './planner.js';

// Explicit operator tool; no HTTP model endpoint is exposed before pairing/orchestration.
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
try {
  const path = process.argv[2];
  if (!path || (await stat(path)).size > 3_000_000) throw new ModelError('INVALID_CONTEXT');
  let input: unknown;
  try { input = JSON.parse(await readFile(path, 'utf8')); } catch { throw new ModelError('INVALID_CONTEXT'); }
  const plan = await new Planner(new ModelClient(loadConfig())).generate(input, controller.signal);
  console.log(JSON.stringify(plan, null, 2));
} catch (error) {
  const safe = error instanceof ModelError ? error : new ModelError('INVALID_CONTEXT');
  console.error(`${safe.code}: ${safe.message}`);
  process.exitCode = 1;
}
