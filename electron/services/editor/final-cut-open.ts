// electron/services/editor/final-cut-open.ts
//
// IS FINAL CUT PRO WORKING IN THIS FOLDER? Asked before a week is deleted (Owen, 2026-10-06): he
// deleted the local copy of 2026-09-20 while opening Final Cut Pro, Final Cut opened that week's
// library and wrote into it as it opened, and the delete failed halfway with the library being
// rebuilt under it. Final Cut writes into every library it has open, so a library it has open is a
// folder that is changing: it is never deleted, whichever copy (local or archive) it is.
//
// The answer is lsof's: the files under the folder that a Final Cut Pro process has open. lsof
// exits 1 when nothing matches (no Final Cut running, or nothing of it open here); anything else
// it cannot answer is said by name, and the delete does not go ahead on a guess.

import { execFile } from 'child_process';

/** The libraries (.fcpbundle folders) under `folder` that Final Cut Pro has files open in; empty when none. */
export function finalCutLibrariesOpenUnder(folder: string): Promise<string[]> {
  const prefix = folder.endsWith('/') ? folder : `${folder}/`;
  return new Promise((resolve, reject) => {
    execFile('/usr/sbin/lsof', ['-n', '-P', '-c', 'Final Cut Pro', '-Fn'], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const exitCode = err && typeof (err as any).code === 'number' ? (err as any).code : null;
      if (err && !(exitCode === 1 && stdout.trim() === '')) {
        reject(new Error(`could not check whether Final Cut Pro has files open in ${folder}: ${stderr.trim() || err.message}`));
        return;
      }
      const libraries = new Set<string>();
      for (const line of stdout.split('\n')) {
        if (!line.startsWith('n')) continue;
        const file = line.slice(1);
        if (!file.startsWith(prefix)) continue;
        const at = file.indexOf('.fcpbundle');
        libraries.add(at >= 0 ? file.slice(0, at + '.fcpbundle'.length) : file);
      }
      resolve([...libraries].sort());
    });
  });
}

/** The refusal when Final Cut Pro is working in `folder`, or null when it is not. */
export async function finalCutRefusal(folder: string, name: string): Promise<string | null> {
  const open = await finalCutLibrariesOpenUnder(folder);
  if (open.length === 0) return null;
  const rel = (p: string) => p.slice(folder.length + 1) || p;
  const libraries = open.filter((p) => p.endsWith('.fcpbundle'));
  const others = open.length - libraries.length;
  const what = libraries.length > 0
    ? `${libraries.map(rel).join(', ')}${others > 0 ? ` (and ${others} of its media file${others === 1 ? '' : 's'})` : ''}`
    : `${others} file${others === 1 ? '' : 's'} in it, first ${rel(open[0])}`;
  return `Final Cut Pro has ${what} open, and it writes into every library it has open, so ${name} ` +
    `is changing and nothing was deleted. Close that library in Final Cut Pro (File ▸ Close Library) ` +
    `or quit Final Cut Pro, then delete again.`;
}
