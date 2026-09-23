// Manual mock for '@prisma/client', wired via jest moduleNameMapper. The
// real client can't be generated in this environment (no network access to
// Prisma's engine CDN) — every *.spec.ts overrides the PrismaService DI
// token with FakePrismaService anyway, so PrismaService's own
// `extends PrismaClient` just needs SOME class here to extend; it is never
// actually instantiated as this mock in a running test.
export class PrismaClient {}
export namespace Prisma {
  export type TransactionClient = any;
}
