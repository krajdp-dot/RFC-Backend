import * as fs from 'fs';
import * as path from 'path';
import { PERMISSIONS } from './permissions.js';

/**
 * Phase 10 closes the annotation gap left by the checkpoint: every route
 * on every business controller now declares the permission it needs. The
 * risk from here isn't the routes that exist today — it's the next route
 * someone adds, which would silently inherit "anyone authenticated can
 * call this" by simply omitting the decorator.
 *
 * So this reads the controllers off disk and fails if any route method is
 * missing @RequirePermission. It is a source-level check on purpose: a
 * runtime metadata scan would only see routes that are already wired into
 * a compiled module, and would not catch the decorator being dropped in a
 * file that still compiles fine.
 */

const MODULES_DIR = path.resolve(__dirname, '../../');

/**
 * Routes that deliberately carry no permission, each with the reason it
 * cannot have one. Anything not on this list must be annotated.
 */
const EXEMPT: Record<string, string> = {
  'auth/auth.controller.ts':
    'register + login are @Public (no session to check yet); /auth/me is what tells a client its role in the first place, so requiring a permission to read it would be circular.',
  'whatsapp/whatsapp-webhook.controller.ts':
    'Called by Meta, not an RFC user — there is no JWT to require a permission against. Both routes are @Public and secured a different way instead: GET verifies hub.verify_token (the setup-time handshake), POST verifies the X-Hub-Signature-256 HMAC over the raw body before any side effect runs (see whatsapp-webhook.controller.ts and the Phase 12 report).',
};

function findControllers(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findControllers(full));
    } else if (entry.name.endsWith('.controller.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Splits a controller into one chunk per route, starting at each HTTP verb decorator. */
function routeBlocks(source: string): { decorator: string; body: string }[] {
  const lines = source.split('\n');
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (/^\s*@(Get|Post|Put|Patch|Delete)\(/.test(line)) starts.push(i);
  });
  return starts.map((start, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1] : lines.length;
    return {
      decorator: lines[start].trim(),
      body: lines.slice(start, end).join('\n'),
    };
  });
}

describe('Phase 10 — route permission coverage', () => {
  const controllers = findControllers(MODULES_DIR);

  it('finds the controllers to check', () => {
    expect(controllers.length).toBeGreaterThan(15);
  });

  it.each(controllers.map((f) => [path.relative(MODULES_DIR, f), f]))(
    '%s annotates every route',
    (relative, file) => {
      const source = fs.readFileSync(file as string, 'utf8');
      const blocks = routeBlocks(source);

      if (EXEMPT[relative as string]) {
        expect(source).not.toContain('@RequirePermission');
        return;
      }

      const unguarded = blocks
        .filter((b) => !b.body.includes('@RequirePermission'))
        .map((b) => b.decorator);

      expect({ file: relative, unguarded }).toEqual({ file: relative, unguarded: [] });
    },
  );

  it('only references permissions that actually exist', () => {
    const known = new Set(Object.keys(PERMISSIONS));
    for (const file of controllers) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/@RequirePermission\(PERMISSIONS\.([A-Z_]+)\)/g)) {
        expect(known).toContain(match[1]);
      }
    }
  });

  it('keeps every exemption documented with a reason', () => {
    for (const [route, reason] of Object.entries(EXEMPT)) {
      expect(fs.existsSync(path.join(MODULES_DIR, route))).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});
