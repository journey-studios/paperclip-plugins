import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { mergeChangeSets } from "../src/merge.ts";
import { ensureChangeSet } from "../.test-output/worker.mjs";
import { withCaptureRetry } from "../src/capture-retry.ts";

const connection = process.env.TEST_DATABASE_URL;

test("PostgreSQL merge preserves concurrent captures and enforces company scope", {
  skip: !connection,
  timeout: 30_000,
}, async (t) => {
  // The suite must never run against the Paperclip production database.
  const url = new URL(connection);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "isolated test PostgreSQL must be local");
  assert.equal(url.pathname, "/evolution_merge_test", "dedicated test database required");
  const module = process.env.EVOLUTION_TEST_POSTGRES_MODULE;
  const { default: postgres } = await import(module ? pathToFileURL(module).href : "postgres");
  const options = { max: 1, connect_timeout: 5, idle_timeout: 2, onnotice() {} };
  const admin = postgres(connection, options);
  const sdk = postgres(connection, options);
  const writer = postgres(connection, options);
  const namespace = "evolution_merge_test_" + randomUUID().replaceAll("-", "");
  const table = (name) => `"${namespace}"."${name}"`;
  const ctx = {
    db: {
      namespace,
      async query(sql, params) { return Array.from(await sdk.unsafe(sql, params)); },
      async execute(sql, params) { return { rowCount: (await sdk.unsafe(sql, params)).count }; },
    },
  };
  const fixture = async () => {
    const company = randomUUID();
    const otherCompany = randomUUID();
    const source = randomUUID();
    const target = randomUUID();
    const sourceContext = "context:" + source;
    const targetContext = "context:" + target;
    await admin.unsafe(`INSERT INTO ${table("companies")} (id) VALUES ($1), ($2)`, [company, otherCompany]);
    await admin.unsafe(`INSERT INTO ${table("change_sets")} (id, company_id, title, source_context_key) VALUES ($1,$3,'source',$4), ($2,$3,'target',$5)`, [source, target, company, sourceContext, targetContext]);
    return { company, otherCompany, source, target, sourceContext, targetContext };
  };
  const insertItem = (sql, company, set, item) => sql.unsafe(
    `INSERT INTO ${table("change_items")} (id, company_id, change_set_id, entity_type, entity_id, change_kind, source_type) ` +
      "VALUES ($1,$2,$3,'agent','captured-agent','updated','test')",
    [item, company, set],
  );

  try {
    await admin.unsafe(`CREATE SCHEMA "${namespace}"`);
    await admin.unsafe(`CREATE TABLE ${table("companies")} (id uuid PRIMARY KEY)`);
    for (const file of ["001_evolution.sql", "002_evolution_integrity.sql", "003_safe_merge.sql"]) {
      const migration = (await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"))
        .replaceAll("plugin_evolution_4399b11512", namespace)
        .replaceAll("public.companies", `"${namespace}"."companies"`);
      for (const statement of migration.replace(/^\s*--.*$/gm, "").split(";").map((part) => part.trim()).filter(Boolean)) {
        await admin.unsafe(statement);
      }
    }

    await t.test("late item commits after DELETE snapshot; FK prevents loss and retry finishes", async () => {
      const { company, source, target } = await fixture();
      const oldItem = randomUUID();
      const lateItem = randomUUID();
      await insertItem(admin, company, source, oldItem);
      const [{ pid }] = await sdk.unsafe("SELECT pg_backend_pid() AS pid");
      let releaseWriter;
      const gate = new Promise((resolve) => { releaseWriter = resolve; });
      let writerReady;
      const ready = new Promise((resolve) => { writerReady = resolve; });
      let writeTransaction;
      let deleteFailureCode;
      const originalExecute = ctx.db.execute;
      const raced = {
        db: {
          ...ctx.db,
          async execute(sql, params) {
            if (sql.startsWith(`DELETE FROM ${table("change_sets")}`)) {
              writeTransaction = writer.begin(async (tx) => {
                await insertItem(tx, company, source, lateItem);
                writerReady();
                await gate;
              });
              await ready;
            }
            try {
              return await originalExecute(sql, params);
            } catch (error) {
              if (sql.startsWith(`DELETE FROM ${table("change_sets")}`)) deleteFailureCode = error.code;
              throw error;
            }
          },
        },
      };
      const result = mergeChangeSets(raced, company, source, target).then(
        (value) => ({ value }), (error) => ({ error }),
      );
      try {
        await ready;
        let blocked = false;
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const [activity] = await admin.unsafe("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid]);
          if (activity?.wait_event_type === "Lock") { blocked = true; break; }
          await delay(20);
        }
        assert.ok(blocked, "source DELETE must take its snapshot while capture is uncommitted, then wait for its FK lock");
      } finally {
        releaseWriter();
        await writeTransaction;
      }
      const outcome = await result;
      assert.equal(deleteFailureCode, "23503", "the FK must catch a capture invisible to the DELETE snapshot");
      assert.match(outcome.error?.message ?? "", /^Merge incomplete; retry/);
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_sets")} WHERE id=$1`, [source])).length, 1);
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_items")} WHERE id=$1 AND change_set_id=$2`, [lateItem, source])).length, 1);
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_items")} WHERE id=$1 AND change_set_id=$2`, [oldItem, target])).length, 1);
      assert.deepEqual(await mergeChangeSets(ctx, company, source, target), { ok: true, targetChangeSetId: target });
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_items")} WHERE change_set_id=$1`, [target])).length, 2);
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_sets")} WHERE id=$1`, [source])).length, 0);
    });

    await t.test("a link inserted after copying survives until a resumable retry", async () => {
      const { company, source, target } = await fixture();
      const linkId = randomUUID();
      let captured = false;
      const raced = {
        db: {
          ...ctx.db,
          async execute(sql, params) {
            if (!captured && sql.startsWith(`DELETE FROM ${table("change_links")}`)) {
              captured = true;
              await admin.unsafe(`INSERT INTO ${table("change_links")} (id, company_id, change_set_id, link_type, reference_id) VALUES ($1,$2,$3,'issue','late-link')`, [linkId, company, source]);
            }
            return ctx.db.execute(sql, params);
          },
        },
      };
      await assert.rejects(mergeChangeSets(raced, company, source, target), /^Error: Merge incomplete; retry/);
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_links")} WHERE id=$1 AND change_set_id=$2`, [linkId, source])).length, 1);
      await mergeChangeSets(ctx, company, source, target);
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_links")} WHERE company_id=$1 AND change_set_id=$2 AND reference_id='late-link'`, [company, target])).length, 1);
    });

    await t.test("context aliases retain captures and replay routing through consecutive merges", async () => {
      const { company, source, target, sourceContext, targetContext } = await fixture();
      const finalTarget = randomUUID();
      await admin.unsafe(`INSERT INTO ${table("change_sets")} (id, company_id, title) VALUES ($1,$2,'final target')`, [finalTarget, company]);
      await mergeChangeSets(ctx, company, source, target);
      const [firstAlias] = await admin.unsafe(`SELECT change_set_id FROM ${table("change_context_aliases")} WHERE company_id=$1 AND source_context_key=$2`, [company, sourceContext]);
      assert.equal(firstAlias.change_set_id, target);
      await mergeChangeSets(ctx, company, target, finalTarget);
      for (const contextKey of [sourceContext, targetContext]) {
        const [alias] = await admin.unsafe(`SELECT change_set_id FROM ${table("change_context_aliases")} WHERE company_id=$1 AND source_context_key=$2`, [company, contextKey]);
        assert.equal(alias.change_set_id, finalTarget);
        // A stale capture or replay resolves its original context to this parent
        // instead of recreating the already merged Change Set.
        await insertItem(admin, company, alias.change_set_id, randomUUID());
      }
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_sets")} WHERE company_id=$1`, [company])).length, 1);
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_items")} WHERE change_set_id=$1`, [finalTarget])).length, 2);
    });

    await t.test("partial manual merge rejects another destination and resumes into the original target", async () => {
      const { company, source, target } = await fixture();
      // Manual sets have no source context from which an alias can be derived.
      await admin.unsafe(`UPDATE ${table("change_sets")} SET source_context_key=NULL WHERE id=$1`, [source]);
      const conflictingTarget = randomUUID();
      const item = randomUUID();
      const evidence = randomUUID();
      await admin.unsafe(`INSERT INTO ${table("change_sets")} (id, company_id, title) VALUES ($1,$2,'conflicting target')`, [conflictingTarget, company]);
      await insertItem(admin, company, source, item);
      await admin.unsafe(`INSERT INTO ${table("change_evidence")} (id, company_id, change_set_id, evidence_type) VALUES ($1,$2,$3,'test')`, [evidence, company, source]);
      const interrupted = {
        db: {
          ...ctx.db,
          async execute(sql, params) {
            if (sql.startsWith(`UPDATE ${table("change_evidence")}`)) throw new Error("injected intermediate failure");
            return ctx.db.execute(sql, params);
          },
        },
      };
      await assert.rejects(mergeChangeSets(interrupted, company, source, target), /injected intermediate failure/);
      const [intent] = await admin.unsafe(`SELECT merge_target_id FROM ${table("change_sets")} WHERE id=$1`, [source]);
      assert.equal(intent.merge_target_id, target);
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_items")} WHERE id=$1 AND change_set_id=$2`, [item, target])).length, 1);
      await assert.rejects(mergeChangeSets(ctx, company, source, conflictingTarget), /already merging into another target/);
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_evidence")} WHERE id=$1 AND change_set_id=$2`, [evidence, source])).length, 1);
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_items")} WHERE change_set_id=$1`, [conflictingTarget])).length, 0);
      await mergeChangeSets(ctx, company, source, target);
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_items")} WHERE id=$1 AND change_set_id=$2`, [item, target])).length, 1);
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_evidence")} WHERE id=$1 AND change_set_id=$2`, [evidence, target])).length, 1);
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_sets")} WHERE id=$1`, [source])).length, 0);
    });

    await t.test("pending merge intent preserves its target until both merges can finish", async () => {
      const { company, source, target } = await fixture();
      const finalTarget = randomUUID();
      await admin.unsafe(`INSERT INTO ${table("change_sets")} (id, company_id, title) VALUES ($1,$2,'final target')`, [finalTarget, company]);
      await insertItem(admin, company, source, randomUUID());
      const interrupted = {
        db: {
          ...ctx.db,
          async execute(sql, params) {
            if (sql.startsWith(`UPDATE ${table("change_evidence")}`)) throw new Error("injected intermediate failure");
            return ctx.db.execute(sql, params);
          },
        },
      };
      await assert.rejects(mergeChangeSets(interrupted, company, source, target), /injected intermediate failure/);
      // The reverse merge cannot introduce a two-node intent cycle.
      await assert.rejects(mergeChangeSets(ctx, company, target, source), /target would create a cycle/);
      assert.equal((await admin.unsafe(`SELECT merge_target_id FROM ${table("change_sets")} WHERE id=$1`, [target]))[0].merge_target_id, null);
      // A later target merge may transfer rows, but cannot remove a destination
      // still needed by the earlier interrupted merge.
      await assert.rejects(mergeChangeSets(ctx, company, target, finalTarget), /^Error: Merge incomplete; retry/);
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_sets")} WHERE id=$1`, [target])).length, 1);
      await assert.rejects(admin.unsafe(`DELETE FROM ${table("change_sets")} WHERE id=$1`, [target]), (error) => error.code === "23503");
      await mergeChangeSets(ctx, company, source, target);
      await mergeChangeSets(ctx, company, target, finalTarget);
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_sets")} WHERE company_id=$1`, [company])).length, 1);
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_items")} WHERE change_set_id=$1`, [finalTarget])).length, 1);
    });

    await t.test("context lookup spanning an entire merge returns the target and removes its provisional candidate", async () => {
      const { company, source, target, sourceContext } = await fixture();
      let interleaved = false;
      const raced = {
        db: {
          ...ctx.db,
          async query(sql, params) {
            const rows = await ctx.db.query(sql, params);
            if (!interleaved && sql.includes("change_context_aliases") && rows.length === 0) {
              interleaved = true;
              await mergeChangeSets(ctx, company, source, target);
            }
            return rows;
          },
        },
      };
      const input = { companyId: company, sourceContextKey: sourceContext, occurredAt: "2026-10-07T12:00:00Z" };
      assert.equal(await ensureChangeSet(raced, input), target);
      for (let replay = 0; replay < 2; replay += 1) assert.equal(await ensureChangeSet(ctx, input), target);
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_sets")} WHERE company_id=$1`, [company])).length, 1);
    });

    await t.test("a capture holding a deleted source ID retries through the real canonical context", async () => {
      const { company, source, target, sourceContext } = await fixture();
      const input = { companyId: company, sourceContextKey: sourceContext, occurredAt: "2026-10-07T12:00:00Z" };
      const stale = await ensureChangeSet(ctx, input);
      assert.equal(stale, source);
      await mergeChangeSets(ctx, company, source, target);
      let attempts = 0;
      const capturedId = randomUUID();
      await withCaptureRetry(async () => {
        const parent = attempts++ === 0 ? stale : await ensureChangeSet(ctx, input);
        await insertItem(sdk, company, parent, capturedId);
      });
      assert.equal(attempts, 2);
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_items")} WHERE id=$1 AND change_set_id=$2`, [capturedId, target])).length, 1);
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_sets")} WHERE company_id=$1`, [company])).length, 1);
    });

    await t.test("all child foreign keys reject a parent from another company", async () => {
      const { company, otherCompany, source } = await fixture();
      await assert.rejects(insertItem(admin, otherCompany, source, randomUUID()), (error) => error.code === "23503");
      for (const [child, columns, values] of [
        ["change_evidence", "evidence_type", "'test'"],
        ["change_links", "link_type, reference_id", "'issue', 'foreign'"],
        ["change_metrics", "metric_key", "'test'"],
        ["change_conclusions", "outcome, summary", "'inconclusive', 'test'"],
      ]) {
        await assert.rejects(admin.unsafe(
          `INSERT INTO ${table(child)} (id, company_id, change_set_id, ${columns}) VALUES ($1,$2,$3,${values})`,
          [randomUUID(), otherCompany, source],
        ), (error) => error.code === "23503", child + " must enforce company scope");
      }
      await assert.rejects(admin.unsafe(
        `INSERT INTO ${table("change_context_aliases")} (company_id, source_context_key, change_set_id) VALUES ($1,'foreign-alias',$2)`,
        [otherCompany, source],
      ), (error) => error.code === "23503");
      const foreignKeys = await admin.unsafe(
        "SELECT c.conname, c.confdeltype, child.relname AS child_table, pg_get_constraintdef(c.oid) AS definition " +
          "FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace " +
          "JOIN pg_class child ON child.oid=c.conrelid JOIN pg_class parent ON parent.oid=c.confrelid " +
          "WHERE n.nspname=$1 AND c.contype='f' AND parent.relname='change_sets' " +
          "AND child.relname IN ('change_sets','change_items','change_evidence','change_links','change_metrics','change_conclusions','change_context_aliases')",
        [namespace],
      );
      assert.equal(foreignKeys.length, 7, "installed 001/002 CASCADE constraints must be replaced, not left alongside the guards");
      for (const key of foreignKeys) {
        assert.equal(key.confdeltype, "a");
        if (key.child_table === "change_sets") {
          assert.match(key.definition, /FOREIGN KEY \(company_id, merge_target_id\)/);
        } else {
          assert.match(key.definition, /FOREIGN KEY \(company_id, change_set_id\)/);
        }
      }
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_items")} WHERE company_id=$1`, [company])).length, 0);
    });

    await t.test("company deletion still cascades to its plugin parents and children", async () => {
      const { company, source } = await fixture();
      await insertItem(admin, company, source, randomUUID());
      await admin.unsafe(`INSERT INTO ${table("change_context_aliases")} (company_id, source_context_key, change_set_id) VALUES ($1,'company-cascade',$2)`, [company, source]);
      const [destination] = await admin.unsafe(`SELECT id FROM ${table("change_sets")} WHERE company_id=$1 AND id<>$2`, [company, source]);
      await admin.unsafe(`UPDATE ${table("change_sets")} SET merge_target_id=$2 WHERE id=$1`, [source, destination.id]);
      await admin.unsafe(`DELETE FROM ${table("companies")} WHERE id=$1`, [company]);
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_sets")} WHERE company_id=$1`, [company])).length, 0);
      assert.equal((await admin.unsafe(`SELECT id FROM ${table("change_items")} WHERE company_id=$1`, [company])).length, 0);
      assert.equal((await admin.unsafe(`SELECT change_set_id FROM ${table("change_context_aliases")} WHERE company_id=$1`, [company])).length, 0);
    });
  } finally {
    await sdk.end({ timeout: 1 });
    await writer.end({ timeout: 1 });
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin.end({ timeout: 1 });
  }
});
