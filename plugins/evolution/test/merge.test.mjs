import assert from "node:assert/strict";
import test from "node:test";
import { mergeChangeSets } from "../src/merge.ts";

const company = "00000000-0000-0000-0000-000000000001";
const source = "00000000-0000-0000-0000-000000000002";
const target = "00000000-0000-0000-0000-000000000003";
const schema = "plugin_evolution_test";

function context(options = {}) {
  const calls = [];
  return {
    calls,
    db: {
      namespace: options.namespace ?? schema,
      async query(sql, params) {
        calls.push({ kind: "query", sql, params });
        return options.rows ?? [{ id: source }, { id: target }];
      },
      async execute(sql, params) {
        calls.push({ kind: "execute", sql, params });
        if (sql.startsWith(`UPDATE "${schema}"."change_sets"`)) {
          return { rowCount: options.intentRows ?? 1 };
        }
        if (sql.startsWith(`DELETE FROM "${schema}"."change_sets"`)) {
          if (options.deleteError) throw options.deleteError;
          return { rowCount: options.deletedRows ?? 1 };
        }
        return { rowCount: 1 };
      },
    },
  };
}

test("merge qualifies every namespace table and guards every child before source deletion", async () => {
  const ctx = context();
  assert.deepEqual(await mergeChangeSets(ctx, company, source, target), { ok: true, targetChangeSetId: target });
  const final = ctx.calls.at(-1);
  assert.match(final.sql, /^DELETE FROM "plugin_evolution_test"\."change_sets"/);
  for (const child of ["change_items", "change_evidence", "change_conclusions", "change_links", "change_metrics", "change_context_aliases"]) {
    assert.ok(final.sql.includes(`FROM "${schema}"."${child}"`));
  }
  assert.equal((final.sql.match(/NOT EXISTS/g) ?? []).length, 7);
  assert.match(final.sql, /incoming_merge\.company_id = \$1 AND incoming_merge\.merge_target_id = \$2/);
  assert.match(final.sql, /target_set\.company_id = \$1 AND target_set\.id = \$3/);
  assert.deepEqual(final.params, [company, source, target]);
  const itemUpdates = ctx.calls.filter(({ sql }) => /^UPDATE .*"change_items"/.test(sql));
  assert.equal(itemUpdates.length, 2);
  assert.ok(ctx.calls.indexOf(itemUpdates[1]) < ctx.calls.indexOf(final));
  assert.ok(ctx.calls.every(({ sql }) => !/\b(?:FROM|INTO|UPDATE) change_/.test(sql)));
});

test("merge claims a durable destination before moving any child rows", async () => {
  const ctx = context();
  await mergeChangeSets(ctx, company, source, target);
  const intent = ctx.calls[1];
  assert.match(intent.sql, /^UPDATE .*"change_sets" SET merge_target_id = \$3/);
  assert.match(intent.sql, /merge_target_id IS NULL OR merge_target_id = \$3/);
  assert.match(intent.sql, /destination\.merge_target_id <> \$2\) FOR UPDATE/);
  assert.deepEqual(intent.params, [company, source, target]);
  assert.match(ctx.calls[2].sql, /^UPDATE .*"change_items"/);
});

test("merge rejects a conflicting durable destination before touching child rows", async () => {
  const ctx = context({ intentRows: 0 });
  await assert.rejects(mergeChangeSets(ctx, company, source, target), /already merging into another target/);
  assert.equal(ctx.calls.length, 2);
  assert.ok(ctx.calls.every(({ sql }) => !sql.includes('"change_items"')));
});

test("merge only deletes links whose company and reference match an existing target link", async () => {
  const ctx = context();
  await mergeChangeSets(ctx, company, source, target);
  const copy = ctx.calls.find(({ sql }) => /^INSERT INTO .*"change_links"/.test(sql));
  assert.match(copy.sql, /SELECT gen_random_uuid\(\).*FROM .*"change_links"/);
  assert.match(copy.sql, /ON CONFLICT \(company_id, change_set_id, link_type, reference_id\) DO NOTHING/);
  const dedupe = ctx.calls.find(({ sql }) => /^DELETE FROM .*"change_links"/.test(sql));
  assert.match(dedupe.sql, /AND EXISTS \(SELECT 1/);
  assert.match(dedupe.sql, /target_link\.company_id = source_link\.company_id/);
  assert.match(dedupe.sql, /target_link\.link_type = source_link\.link_type/);
  assert.match(dedupe.sql, /target_link\.reference_id = source_link\.reference_id/);
});

test("merge retargets prior aliases and records the source context before deleting it", async () => {
  const ctx = context();
  await mergeChangeSets(ctx, company, source, target);
  const retarget = ctx.calls.find(({ sql }) => /^UPDATE .*"change_context_aliases"/.test(sql));
  const alias = ctx.calls.find(({ sql }) => /^INSERT INTO .*"change_context_aliases"/.test(sql));
  assert.deepEqual(retarget.params, [company, source, target]);
  assert.match(alias.sql, /source_context_key IS NOT NULL/);
  assert.match(alias.sql, /ON CONFLICT \(company_id, source_context_key\) DO UPDATE SET change_set_id = EXCLUDED\.change_set_id/);
  assert.ok(ctx.calls.indexOf(retarget) < ctx.calls.indexOf(alias));
  assert.ok(ctx.calls.indexOf(alias) < ctx.calls.length - 1);
});

test("a newly captured child prevents an incomplete merge being acknowledged", async () => {
  const ctx = context({ deletedRows: 0 });
  await assert.rejects(mergeChangeSets(ctx, company, source, target), /^Error: Merge incomplete; retry after concurrent capture settles\.$/);
});

test("a foreign key race gives a safe retry error instead of raw database details", async () => {
  const ctx = context({ deleteError: new Error("23503 secret database SQL detail") });
  await assert.rejects(mergeChangeSets(ctx, company, source, target), /^Error: Merge incomplete; retry after concurrent capture settles\.$/);
});

test("merge rejects absent or foreign-company parents before mutating rows", async () => {
  const ctx = context({ rows: [{ id: source }] });
  await assert.rejects(mergeChangeSets(ctx, company, source, target), /Source or target Change Set not found/);
  assert.equal(ctx.calls.filter(({ kind }) => kind === "execute").length, 0);
});

test("merge rejects self-merge and unsafe schema names", async () => {
  const ctx = context();
  await assert.rejects(mergeChangeSets(ctx, company, source, source), /must differ/);
  await assert.rejects(mergeChangeSets(context({ namespace: 'bad";DROP TABLE' }), company, source, target), /Invalid plugin database namespace/);
  assert.equal(ctx.calls.length, 0);
});
