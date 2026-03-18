import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL:       z.string().min(1),
  GCS_BUCKET:         z.string().min(1),
  GCS_PROJECT:        z.string().default("test-intel-local"),
  // Set to e.g. "localhost:4443" for local dev with fake-gcs-server.
  // Omit entirely in production — the SDK will use ADC / Workload Identity.
  GCS_EMULATOR_HOST:  z.string().optional(),
});

export const env = EnvSchema.parse(process.env);
