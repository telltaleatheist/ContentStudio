/**
 * THE VENDORED MODULE, and the one edit it needs before it is posted.
 *
 * Ported from Briefcase's module-setup.ts (BookForge's `moduleForBackend`).
 * `shared/crucible/contentstudio.module.json` is generated in the Crucible
 * repo by its own `gen-modules.py` (plan section 3.4) and vendored byte for
 * byte: its `version` is a hash of its own content, so an edit here would be
 * a second owner of the ids. Nothing here writes it.
 *
 * STRIP `backends` BEFORE POSTING. The generated file scopes each job type
 * and subject to the backends that declare it; the server's `validate_module`
 * refuses any key other than `type` and `narrator_engine` on a job type and
 * `kind`, `id` on a subject (INTEGRATING-AN-APP.md §3.1). So the module is
 * filtered to ONE server's `info().host.backend` and the key is dropped. A
 * server that does not state its backend is refused by name: the module
 * cannot be filtered to a backend nobody named (plan section 0a, Law 1).
 *
 * Coordination (posting it when something is missing) is P2's; this is the
 * reader and the filter, so the module's shape is checked from P1.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CrucibleFieldMissing } from './errors';

export const MODULE_FILE = 'contentstudio.module.json';

/** The generated file's shape: every entry carries the `backends` the server refuses. */
export interface VendoredModule {
  name: string;
  version: string;
  job_types: Array<{ type: string; narrator_engine?: string; backends: string[] }>;
  needs: Array<{ class: string }>;
  subjects: Array<{ kind: string; id: string; backends: string[] }>;
}

/** The module as the server takes it: one backend, no `backends` key anywhere. */
export interface ServerModule {
  name: string;
  version: string;
  job_types: Array<{ type: string; narrator_engine?: string }>;
  needs: Array<{ class: string }>;
  subjects: Array<{ kind: string; id: string }>;
}

/** Where the vendored JSON lives: `shared/crucible/` beside the repo root, inside the asar when packaged. */
export function vendoredModulePath(appPath: string): string {
  return path.join(appPath, 'shared', 'crucible', MODULE_FILE);
}

export function readVendoredModule(file: string): VendoredModule {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as VendoredModule;
  if (parsed.name !== 'contentstudio' || !Array.isArray(parsed.job_types) || !Array.isArray(parsed.subjects) || !Array.isArray(parsed.needs)) {
    throw new Error(`${file} is not ContentStudio's module: expected {name: "contentstudio", job_types, needs, subjects}.`);
  }
  return parsed;
}

/**
 * The module filtered to one server's backend, with `backends` stripped. A
 * null backend (the server did not state it) is refused: nothing here guesses
 * which of the entries that server can hold.
 */
export function moduleForBackend(module: VendoredModule, backend: string | null, server: string | null = null): ServerModule {
  if (backend === null || backend === '') {
    throw new CrucibleFieldMissing(server, 'host.backend (GET /v1/info)', 'filter its module to the backend that server runs');
  }
  return {
    name: module.name,
    version: module.version,
    job_types: module.job_types
      .filter((entry) => entry.backends.includes(backend))
      .map(({ type, narrator_engine }) => (narrator_engine === undefined ? { type } : { type, narrator_engine })),
    needs: module.needs.map(({ class: cls }) => ({ class: cls })),
    subjects: module.subjects
      .filter((entry) => entry.backends.includes(backend))
      .map(({ kind, id }) => ({ kind, id })),
  };
}
