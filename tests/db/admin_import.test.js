'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { World, buildTemplate, dropTemplate } = require('./harness');

before(buildTemplate);
after(dropTemplate);

async function withWorld(fn) {
  const w = await World.create();
  try { await fn(w); } finally { await w.close(); }
}

const rejects = (p, code, re) =>
  assert.rejects(p, (e) => (code ? e.code === code : true) && (re ? re.test(e.message) : true), `${code} ${re}`);

/** Sessions for 2026-11-03 FN/AN and 2026-11-04 FN. */
async function sessions(w) {
  const a = await w.session({ date: '2026-11-03', label: 'FN', opens: 0, closes: 60 });
  const b = await w.session({ date: '2026-11-03', label: 'AN', opens: 60, closes: 120 });
  const c = await w.session({ date: '2026-11-04', label: 'FN', opens: 120, closes: 180 });
  return { a, b, c };
}

const row = (n, id, name, dept, date, session) => ({ row: n, employee_id: id, name, department: dept, date, session });

/** begin + add_rows (chunked like the browser would) + validate. */
async function stage(w, adm, rows, { filename = 'schedule.csv', chunk = 500 } = {}) {
  const b = await w.rpc(adm, 'admin_import_begin', filename, 12345, rows.length);
  assert.equal(b.ok, true);
  for (let i = 0; i < rows.length; i += chunk) {
    const r = await w.rpc(adm, 'admin_import_add_rows', b.batch_id, JSON.stringify(rows.slice(i, i + chunk)));
    assert.equal(r.ok, true);
  }
  const v = await w.rpc(adm, 'admin_import_validate', b.batch_id);
  return { batchId: b.batch_id, validation: v, summary: v.summary };
}

const scheduleCount = async (w) => (await w.one('select count(*)::int c from schedule')).c;

test('valid CSV rows: normalised and counted; the dry run does not touch the live schedule', async () => {
  await withWorld(async (w) => {
    await sessions(w);
    const adm = await w.adminClient();
    const rows = [
      row(2, ' emp001 ', '  Asha   Rao ', ' Physics ', '2026-11-03', 'Forenoon'),
      row(3, 'EMP002', 'Ben Joy', 'Maths', '03/11/2026', 'fn'),
      row(4, 'emp003', 'Chitra N', 'Chem', '3-11-2026', 'AN'),
      row(5, 'EMP004', 'Dev K', 'Bio', '2026-11-03 00:00:00', 'afternoon'),
      row(6, 'EMP005', 'Esha P', 'CSE', '04.11.2026', ' FN '),
    ];
    const before = await scheduleCount(w);
    const { batchId, summary } = await stage(w, adm, rows);
    assert.deepEqual([summary.rows, summary.valid, summary.invalid, summary.duplicate, summary.conflict], [5, 5, 0, 0, 0]);
    assert.equal(await scheduleCount(w), before, 'dry run changed nothing in the live schedule');

    const staged = await w.q(`select row_number, employee_id, employee_name, department, exam_date::text d, session_label
                                from import_rows where batch_id = $1 order by row_number`, [batchId]);
    assert.deepEqual(staged.map((r) => [r.employee_id, r.employee_name, r.department, r.d, r.session_label]), [
      ['EMP001', 'Asha Rao', 'Physics', '2026-11-03', 'FN'],
      ['EMP002', 'Ben Joy', 'Maths', '2026-11-03', 'FN'],
      ['EMP003', 'Chitra N', 'Chem', '2026-11-03', 'AN'],
      ['EMP004', 'Dev K', 'Bio', '2026-11-03', 'AN'],
      ['EMP005', 'Esha P', 'CSE', '2026-11-04', 'FN'],
    ]);
    const b = await w.one('select status, row_count, valid_count, uploaded_by from import_batches where id = $1', [batchId]);
    assert.equal(b.status, 'validated');
    assert.equal(b.uploaded_by, adm.adminId);
  });
});

test('XLSX-parsed rows: numeric JSON cells, ISO datetimes from Excel, serial numbers rejected with a clear message', async () => {
  await withWorld(async (w) => {
    await sessions(w);
    const adm = await w.adminClient();
    const b = await w.rpc(adm, 'admin_import_begin', 'roster.xlsx', 20000, 3);
    const rows = [
      { row: 2, employee_id: 1001, name: 'Numeric Id', department: 'Physics', date: '2026-11-03T00:00:00', session: 'FN' },
      { row: 3, employee_id: 1002, name: 'Space Date', department: 'Physics', date: '2026-11-03 00:00:00.000', session: 'AN' },
      { row: 4, employee_id: 1003, name: 'Excel Serial', department: 'Physics', date: 46329, session: 'FN' },
    ];
    await w.rpc(adm, 'admin_import_add_rows', b.batch_id, JSON.stringify(rows));
    const v = await w.rpc(adm, 'admin_import_validate', b.batch_id);
    assert.equal(v.summary.valid, 2);
    assert.equal(v.summary.invalid, 1);
    const bad = v.problems.find((p) => p.row === 4);
    assert.match(bad.errors.join(' '), /not a valid date/);
    const ok = await w.q(`select employee_id from import_rows where batch_id = $1 and status = 'valid' order by row_number`, [b.batch_id]);
    assert.deepEqual(ok.map((r) => r.employee_id), ['1001', '1002']);
  });
});

test('validation errors: missing fields, bad IDs, bad dates, bad sessions, unknown sessions', async () => {
  await withWorld(async (w) => {
    await sessions(w);
    const adm = await w.adminClient();
    const rows = [
      row(2, '', 'No Id', 'D', '2026-11-03', 'FN'),
      row(3, 'E 1', 'Space Id', 'D', '2026-11-03', 'FN'),
      row(4, 'E#1', 'Hash Id', 'D', '2026-11-03', 'FN'),
      row(5, 'A'.repeat(51), 'Long Id', 'D', '2026-11-03', 'FN'),
      row(6, 'E6', '', 'D', '2026-11-03', 'FN'),
      row(7, 'E7', 'No Dept', '  ', '2026-11-03', 'FN'),
      row(8, 'E8', 'No Date', 'D', '', 'FN'),
      row(9, 'E9', 'Feb 31', 'D', '31-02-2026', 'FN'),
      row(10, 'E10', 'Month 13', 'D', '2026-13-01', 'FN'),
      row(11, 'E11', 'Two digit year', 'D', '03-11-26', 'FN'),
      row(12, 'E12', 'No Session', 'D', '2026-11-03', ''),
      row(13, 'E13', 'Bad Session', 'D', '2026-11-03', 'EVENING'),
      row(14, 'E14', 'Unknown Session', 'D', '2026-12-25', 'FN'),
      row(15, 'E15', 'Unknown Session 2', 'D', '2026-11-04', 'AN'),
      row(16, 'E16', 'Fine', 'D', '2026-11-03', 'FN'),
    ];
    const { summary, validation } = await stage(w, adm, rows);
    assert.equal(summary.valid, 1);
    assert.equal(summary.invalid, 14);
    const msg = (n) => validation.problems.find((p) => p.row === n).errors.join(' | ');
    assert.match(msg(2), /Employee ID is missing/);
    assert.match(msg(3), /Employee ID is invalid/);
    assert.match(msg(4), /Employee ID is invalid/);
    assert.match(msg(5), /Employee ID is invalid/);
    assert.match(msg(6), /Name is missing/);
    assert.match(msg(7), /Department is missing/);
    assert.match(msg(8), /Examination Date is missing/);
    assert.match(msg(9), /not a valid date/);
    assert.match(msg(10), /not a valid date/);
    assert.match(msg(11), /not a valid date/);
    assert.match(msg(12), /Session is missing/);
    assert.match(msg(13), /FN, AN, Forenoon or Afternoon/);
    assert.match(msg(14), /No examination session is configured for 2026-12-25 FN/);
    assert.match(msg(15), /No examination session is configured for 2026-11-04 AN/);
    assert.equal(validation.problems.every((p) => typeof p.row === 'number' && p.status === 'invalid'), true);
  });
});

test('several problems on one row are all reported', async () => {
  await withWorld(async (w) => {
    await sessions(w);
    const adm = await w.adminClient();
    const { validation } = await stage(w, adm, [row(2, '', '', '', 'junk', 'zzz')]);
    assert.equal(validation.problems[0].errors.length, 5);
  });
});

test('duplicates inside the batch: identical rows skip later copies, differing rows are all invalid', async () => {
  await withWorld(async (w) => {
    await sessions(w);
    const adm = await w.adminClient();
    const rows = [
      row(2, 'E1', 'Same Person', 'Physics', '2026-11-03', 'FN'),
      row(3, 'e1', 'Same  Person', 'Physics', '03-11-2026', 'Forenoon'),   // identical after normalisation
      row(4, 'E2', 'Alpha', 'Physics', '2026-11-03', 'FN'),
      row(5, 'E2', 'Beta', 'Physics', '2026-11-03', 'FN'),                   // same key, different details
      row(6, 'E2', 'Alpha', 'Physics', '2026-11-03', 'FN'),
      row(7, 'E1', 'Same Person', 'Physics', '2026-11-03', 'AN'),            // different session: not a duplicate
    ];
    const { summary, validation, batchId } = await stage(w, adm, rows);
    assert.equal(summary.duplicate_in_batch, 1);
    assert.equal(summary.invalid, 3);
    assert.equal(summary.valid, 2);
    const st = Object.fromEntries((await w.q('select row_number, status from import_rows where batch_id = $1', [batchId])).map((r) => [r.row_number, r.status]));
    assert.deepEqual(st, { 2: 'valid', 3: 'duplicate_in_batch', 4: 'invalid', 5: 'invalid', 6: 'invalid', 7: 'valid' });
    const dupMsg = (await w.one(`select errors from import_rows where batch_id = $1 and row_number = 3`, [batchId])).errors[0];
    assert.match(dupMsg, /Duplicate of row 2/);
    const diffMsg = validation.problems.find((p) => p.row === 5).errors[0];
    assert.match(diffMsg, /E2 appears 3 times.*different details \(rows 4, 5, 6\)/);
  });
});

test('conflicts with existing schedule: identical = skipped duplicate, different = conflict with the existing values shown', async () => {
  await withWorld(async (w) => {
    const { a } = await sessions(w);
    await w.schedule('E1', a, 'Existing One', 'Physics');
    await w.schedule('E2', a, 'Existing Two', 'Maths');
    const adm = await w.adminClient();
    const rows = [
      row(2, 'E1', 'Existing One', 'Physics', '2026-11-03', 'FN'),     // exact duplicate
      row(3, 'E2', 'Different Name', 'Maths', '2026-11-03', 'FN'),    // conflict
      row(4, 'E3', 'Brand New', 'Chem', '2026-11-03', 'FN'),          // valid
    ];
    const { summary, batchId } = await stage(w, adm, rows);
    assert.deepEqual([summary.valid, summary.exact_duplicate_existing, summary.conflict, summary.duplicate, summary.invalid], [1, 1, 1, 1, 0]);
    const c = await w.one(`select status, existing, errors from import_rows where batch_id = $1 and row_number = 3`, [batchId]);
    assert.equal(c.status, 'conflict');
    assert.deepEqual(c.existing, { employee_name: 'Existing Two', department: 'Maths' });
    assert.match(c.errors[0], /Already scheduled as "Existing Two" in "Maths".*administrator decision/);
    assert.equal(await scheduleCount(w), 2);
  });
});

test('preview pages rows by status with row numbers and messages', async () => {
  await withWorld(async (w) => {
    await sessions(w);
    const adm = await w.adminClient();
    const rows = [];
    for (let i = 2; i <= 31; i++) rows.push(row(i, i % 5 === 0 ? '' : 'E' + i, 'N' + i, 'D', '2026-11-03', 'FN'));
    const { batchId, summary } = await stage(w, adm, rows);
    assert.equal(summary.invalid, 6);
    const bad = await w.rpc(adm, 'admin_import_preview', batchId, 'invalid', 4, 0);
    assert.equal(bad.rows.length, 4);
    assert.deepEqual(bad.rows.map((r) => r.row), [5, 10, 15, 20]);
    const page2 = await w.rpc(adm, 'admin_import_preview', batchId, 'invalid', 4, 4);
    assert.deepEqual(page2.rows.map((r) => r.row), [25, 30]);
    const all = await w.rpc(adm, 'admin_import_preview', batchId);
    assert.equal(all.rows.length, 30);
    assert.equal(all.summary.rows, 30);
    await rejects(w.rpc(adm, 'admin_import_preview', batchId, 'bogus'), '22023', /unknown status/);
  });
});

test('commit requires explicit confirmation; invalid rows block it and nothing is imported', async () => {
  await withWorld(async (w) => {
    await sessions(w);
    const adm = await w.adminClient();
    const { batchId } = await stage(w, adm, [
      row(2, 'E1', 'A', 'D', '2026-11-03', 'FN'),
      row(3, 'E2', 'B', 'D', '2026-11-03', 'XX'),
    ]);
    await rejects(w.rpc(adm, 'admin_import_commit', batchId, false), '22023', /confirmation/);
    await rejects(w.rpc(adm, 'admin_import_commit', batchId, null), '22023', /confirmation/);
    await rejects(w.rpc(adm, 'admin_import_commit', batchId, true, 'overwrite'), '22023', /skip or abort/);
    const r = await w.rpc(adm, 'admin_import_commit', batchId, true, 'skip');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INVALID_ROWS');
    assert.equal(await scheduleCount(w), 0, 'a file with invalid rows imports nothing (no partial import)');
    assert.equal((await w.one('select status from import_batches where id = $1', [batchId])).status, 'validated');
  });
});

test('commit creates the correct schedule, records the batch and audits it', async () => {
  await withWorld(async (w) => {
    const { a, b } = await sessions(w);
    const adm = await w.adminClient();
    const { batchId } = await stage(w, adm, [
      row(2, ' e1 ', 'Asha Rao', 'Physics', '2026-11-03', 'Forenoon'),
      row(3, 'E2', 'Ben Joy', 'Maths', '03/11/2026', 'AN'),
      row(4, 'E3', 'Chitra N', 'Chem', '2026-11-04', 'FN'),
    ], { filename: 'november.xlsx' });
    const r = await w.rpc(adm, 'admin_import_commit', batchId, true);
    assert.equal(r.ok, true);
    assert.deepEqual([r.summary.status, r.summary.inserted, r.summary.valid], ['committed', 3, 3]);

    const sch = await w.q(`select employee_id, employee_name, department, exam_date::text d, session_label, import_batch_id
                             from schedule order by employee_id`);
    assert.deepEqual(sch.map((s) => [s.employee_id, s.employee_name, s.department, s.d, s.session_label]), [
      ['E1', 'Asha Rao', 'Physics', '2026-11-03', 'FN'],
      ['E2', 'Ben Joy', 'Maths', '2026-11-03', 'AN'],
      ['E3', 'Chitra N', 'Chem', '2026-11-04', 'FN'],
    ]);
    assert.ok(sch.every((s) => s.import_batch_id === batchId));

    const batch = await w.one('select * from import_batches where id = $1', [batchId]);
    assert.equal(batch.status, 'committed');
    assert.equal(batch.filename, 'november.xlsx');
    assert.equal(batch.uploaded_by, adm.adminId);
    assert.equal(batch.committed_by, adm.adminId);
    assert.ok(batch.committed_at && batch.uploaded_at);
    assert.equal(batch.inserted_count, 3);
    assert.equal((await w.q(`select 1 from import_rows where batch_id = $1 and outcome = 'inserted'`, [batchId])).length, 3);

    const actions = (await w.q('select action, actor, entity_id from audit_log order by id')).filter((x) => x.entity_id === batchId);
    assert.deepEqual(actions.map((x) => x.action), ['import.begin', 'import.validate', 'import.commit']);
    assert.ok(actions.every((x) => x.actor === 'admin:' + adm.adminId));
    const c = await w.one(`select before, after, request_id from audit_log where action = 'import.commit'`);
    assert.equal(c.after.inserted, 3);
    assert.ok(c.request_id);

    // the imported employees can now check in (the schedule works end-to-end)
    assert.ok(a && b);
    const again = await w.rpc(adm, 'admin_import_commit', batchId, true);
    assert.equal(again.code, 'BAD_STATE', 'a committed batch cannot be committed twice');
    assert.equal(await scheduleCount(w), 3);
  });
});

test('conflicts need an explicit decision: none -> refused, abort -> nothing imported, skip -> valid rows only', async () => {
  await withWorld(async (w) => {
    const { a } = await sessions(w);
    await w.schedule('E1', a, 'Existing', 'Physics');
    await w.schedule('E2', a, 'Same', 'Maths');
    const adm = await w.adminClient();
    const rows = [
      row(2, 'E1', 'Changed Name', 'Physics', '2026-11-03', 'FN'),     // conflict
      row(3, 'E2', 'Same', 'Maths', '2026-11-03', 'FN'),               // exact duplicate
      row(4, 'E3', 'New', 'Chem', '2026-11-03', 'FN'),                 // valid
    ];
    const { batchId } = await stage(w, adm, rows);

    const none = await w.rpc(adm, 'admin_import_commit', batchId, true);
    assert.equal(none.code, 'CONFLICT_DECISION_REQUIRED');
    assert.equal(await scheduleCount(w), 2);
    const abort = await w.rpc(adm, 'admin_import_commit', batchId, true, 'abort');
    assert.equal(abort.code, 'ABORTED_ON_CONFLICT');
    assert.equal(await scheduleCount(w), 2);

    const skip = await w.rpc(adm, 'admin_import_commit', batchId, true, 'skip');
    assert.equal(skip.ok, true);
    assert.equal(skip.summary.inserted, 1);
    assert.equal(await scheduleCount(w), 3);
    const e1 = await w.one(`select employee_name from schedule where employee_id = 'E1'`);
    assert.equal(e1.employee_name, 'Existing', 'the existing record was NOT overwritten');
    const out = Object.fromEntries((await w.q('select row_number, outcome from import_rows where batch_id = $1', [batchId])).map((r) => [r.row_number, r.outcome]));
    assert.deepEqual(out, { 2: 'skipped_conflict', 3: 'skipped_exact_duplicate', 4: 'inserted' });
  });
});

test('commit revalidates in the database: a change after the preview is caught and nothing is imported', async () => {
  await withWorld(async (w) => {
    await sessions(w);
    const adm = await w.adminClient();
    const { batchId } = await stage(w, adm, [row(2, 'E1', 'A', 'D', '2026-11-03', 'FN'), row(3, 'E2', 'B', 'D', '2026-11-03', 'FN')]);
    // someone else adds E1 to the live schedule between preview and commit
    await w.q(`insert into schedule (employee_id, employee_name, department, exam_date, session_label)
               values ('E1', 'Added Meanwhile', 'X', '2026-11-03', 'FN')`);
    const r = await w.rpc(adm, 'admin_import_commit', batchId, true, 'skip');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CHANGED_SINCE_PREVIEW');
    assert.equal(r.summary.conflict, 1);
    assert.equal(await scheduleCount(w), 1, 'nothing imported');
    // after reviewing the new counts the admin may commit
    const r2 = await w.rpc(adm, 'admin_import_commit', batchId, true, 'skip');
    assert.equal(r2.ok, true);
    assert.equal(await scheduleCount(w), 2);
  });
});

test('a failing commit leaves no partial import, records the failure, and can be retried', async () => {
  await withWorld(async (w) => {
    await sessions(w);
    const adm = await w.adminClient();
    // test-only trigger: the 3rd row of the INSERT blows up
    await w.q(`create function boom() returns trigger language plpgsql as $$
               begin if new.employee_id = 'BOOM' then raise exception 'simulated failure'; end if; return new; end $$`);
    await w.q(`create trigger boom before insert on schedule for each row execute function boom()`);
    const { batchId } = await stage(w, adm, [
      row(2, 'E1', 'A', 'D', '2026-11-03', 'FN'),
      row(3, 'E2', 'B', 'D', '2026-11-03', 'FN'),
      row(4, 'BOOM', 'C', 'D', '2026-11-03', 'FN'),
    ]);
    const r = await w.rpc(adm, 'admin_import_commit', batchId, true);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'COMMIT_FAILED');
    assert.equal(await scheduleCount(w), 0, 'rows inserted before the failure were rolled back');
    const b = await w.one('select status, error, inserted_count, committed_at from import_batches where id = $1', [batchId]);
    assert.equal(b.status, 'validated');
    assert.match(b.error, /simulated failure/);
    assert.equal(b.inserted_count, 0);
    assert.equal(b.committed_at, null);
    assert.equal((await w.q(`select 1 from import_rows where batch_id = $1 and outcome is not null`, [batchId])).length, 0);
    const a = await w.one(`select action, after from audit_log where action = 'import.commit_failed'`);
    assert.match(a.after.error, /simulated failure/);

    await w.q('drop trigger boom on schedule');
    const retry = await w.rpc(adm, 'admin_import_commit', batchId, true);
    assert.equal(retry.ok, true);
    assert.equal(await scheduleCount(w), 3);
    assert.equal((await w.one('select error from import_batches where id = $1', [batchId])).error, null);
  });
});

test('limits are enforced inside the database', async () => {
  await withWorld(async (w) => {
    await sessions(w);
    const adm = await w.adminClient();
    await rejects(w.rpc(adm, 'admin_import_begin', 'big.xlsx', 99999999, 10), '22023', /larger than the limit/);
    await rejects(w.rpc(adm, 'admin_import_begin', 'long.csv', 100, 5001), '22023', /limit is 5000 rows/);
    await rejects(w.rpc(adm, 'admin_import_begin', '  ', 100, 5), '22023', /file name/);
    await rejects(w.rpc(adm, 'admin_import_begin', 'zero.csv', 100, 0), '22023', /rows/);

    await w.q(`update app_settings set int_value = 10 where key = 'import_chunk_max_rows'`);
    await w.q(`update app_settings set int_value = 15 where key = 'import_max_rows'`);
    const b = await w.rpc(adm, 'admin_import_begin', 'ok.csv', 100, 12);
    const mk = (from, to) => JSON.stringify(Array.from({ length: to - from + 1 }, (_, i) => row(from + i, 'E' + (from + i), 'N', 'D', '2026-11-03', 'FN')));
    await rejects(w.rpc(adm, 'admin_import_add_rows', b.batch_id, mk(1, 11)), '22023', /too many rows in one call/);
    await w.rpc(adm, 'admin_import_add_rows', b.batch_id, mk(1, 10));
    await rejects(w.rpc(adm, 'admin_import_add_rows', b.batch_id, mk(11, 20)), '22023', /batch would have 20 rows; the limit is 15/);
    assert.equal((await w.one('select count(*)::int c from import_rows where batch_id = $1', [b.batch_id])).c, 10, 'oversized chunk rolled back entirely');

    await rejects(w.rpc(adm, 'admin_import_add_rows', b.batch_id, '{"row":1}'), '22023', /JSON array/);
    await rejects(w.rpc(adm, 'admin_import_add_rows', b.batch_id, '[]'), '22023', /no rows/);
    await rejects(w.rpc(adm, 'admin_import_add_rows', b.batch_id, '[{"employee_id":"X"}]'), '22023', /positive integer/);
    await rejects(w.rpc(adm, 'admin_import_add_rows', b.batch_id, '[{"row":11},{"row":11}]'), '22023', /duplicate row numbers/);
    await rejects(w.rpc(adm, 'admin_import_add_rows', b.batch_id, JSON.stringify([{ row: 11, name: 'x'.repeat(301) }])), '22023', /300 characters/);
    await rejects(w.rpc(adm, 'admin_import_add_rows', '00000000-0000-0000-0000-000000000000', mk(1, 2)), '22023', /not found/);
    await rejects(w.rpc(adm, 'admin_import_validate', (await w.rpc(adm, 'admin_import_begin', 'empty.csv')).batch_id), '22023', /no rows/);
  });
});

test('add_rows is idempotent for a retried chunk; re-adding after validation requires re-validation', async () => {
  await withWorld(async (w) => {
    await sessions(w);
    const adm = await w.adminClient();
    const b = await w.rpc(adm, 'admin_import_begin', 'retry.csv', 100, 2);
    const chunk = JSON.stringify([row(1, 'E1', 'A', 'D', '2026-11-03', 'FN'), row(2, 'E2', 'B', 'D', '2026-11-03', 'FN')]);
    await w.rpc(adm, 'admin_import_add_rows', b.batch_id, chunk);
    const again = await w.rpc(adm, 'admin_import_add_rows', b.batch_id, chunk);
    assert.equal(again.staged_rows, 2);
    await w.rpc(adm, 'admin_import_validate', b.batch_id);
    assert.equal((await w.one('select status from import_batches where id = $1', [b.batch_id])).status, 'validated');
    await w.rpc(adm, 'admin_import_add_rows', b.batch_id, JSON.stringify([row(3, 'E3', 'C', 'D', '2026-11-03', 'FN')]));
    assert.equal((await w.one('select status from import_batches where id = $1', [b.batch_id])).status, 'staging');
    const c = await w.rpc(adm, 'admin_import_commit', b.batch_id, true);
    assert.equal(c.code, 'BAD_STATE', 'a batch with unvalidated rows cannot be committed');
    await w.rpc(adm, 'admin_import_validate', b.batch_id);
    assert.equal((await w.rpc(adm, 'admin_import_commit', b.batch_id, true)).ok, true);
    await rejects(w.rpc(adm, 'admin_import_add_rows', b.batch_id, chunk), '22023', /committed and cannot accept/);
    await rejects(w.rpc(adm, 'admin_import_validate', b.batch_id), '22023', /committed and cannot be validated/);
  });
});

test('cancel discards the staged rows and audits it; nothing reaches the schedule', async () => {
  await withWorld(async (w) => {
    await sessions(w);
    const adm = await w.adminClient();
    const { batchId } = await stage(w, adm, [row(2, 'E1', 'A', 'D', '2026-11-03', 'FN')]);
    await rejects(w.rpc(adm, 'admin_import_cancel', batchId, 'x'), '22023', /reason/);
    await w.rpc(adm, 'admin_import_cancel', batchId, 'wrong file uploaded');
    assert.equal((await w.one('select count(*)::int c from import_rows where batch_id = $1', [batchId])).c, 0);
    assert.equal((await w.one('select status from import_batches where id = $1', [batchId])).status, 'cancelled');
    assert.equal(await scheduleCount(w), 0);
    assert.equal((await w.q(`select 1 from audit_log where action = 'import.cancel'`)).length, 1);
    const r = await w.rpc(adm, 'admin_import_commit', batchId, true);
    assert.equal(r.code, 'BAD_STATE');
  });
});

test('replacement is a separate, confirmed action with per-row before/after audit; default import never overwrites', async () => {
  await withWorld(async (w) => {
    const { a } = await sessions(w);
    await w.schedule('E1', a, 'Old Name One', 'Physics');
    await w.schedule('E2', a, 'Old Name Two', 'Maths');
    const adm = await w.adminClient();
    const { batchId } = await stage(w, adm, [
      row(2, 'E1', 'New Name One', 'Physics', '2026-11-03', 'FN'),
      row(3, 'E2', 'New Name Two', 'Chem', '2026-11-03', 'FN'),
      row(4, 'E3', 'Fresh', 'Bio', '2026-11-03', 'FN'),
    ]);
    await w.rpc(adm, 'admin_import_commit', batchId, true, 'skip');
    assert.equal((await w.one(`select employee_name from schedule where employee_id = 'E1'`)).employee_name, 'Old Name One');

    await rejects(w.rpc(adm, 'admin_import_replace_conflicts', batchId, false, 'HR corrected names'), '22023', /confirmation/);
    await rejects(w.rpc(adm, 'admin_import_replace_conflicts', batchId, true, 'x'), '22023', /reason/);
    const r = await w.rpc(adm, 'admin_import_replace_conflicts', batchId, true, 'HR corrected names');
    assert.equal(r.replaced, 2);
    const sch = await w.q(`select employee_id, employee_name, department, import_batch_id from schedule order by employee_id`);
    assert.deepEqual(sch.map((s) => [s.employee_id, s.employee_name, s.department]),
      [['E1', 'New Name One', 'Physics'], ['E2', 'New Name Two', 'Chem'], ['E3', 'Fresh', 'Bio']]);
    assert.ok(sch.every((s) => s.import_batch_id === batchId));

    const aud = await w.q(`select entity_id, before, after, actor from audit_log where action = 'schedule.replace' order by entity_id`);
    assert.equal(aud.length, 2);
    assert.equal(aud[0].entity_id, 'E1|2026-11-03|FN');
    assert.equal(aud[0].before.employee_name, 'Old Name One');
    assert.equal(aud[0].after.employee_name, 'New Name One');
    assert.equal(aud[0].after.reason, 'HR corrected names');
    assert.equal(aud[0].actor, 'admin:' + adm.adminId);
    assert.equal((await w.one('select replaced_count from import_batches where id = $1', [batchId])).replaced_count, 2);
    assert.equal((await w.q(`select 1 from import_rows where batch_id = $1 and outcome = 'replaced'`, [batchId])).length, 2);

    const none = await w.rpc(adm, 'admin_import_replace_conflicts', batchId, true, 'second time');
    assert.equal(none.replaced, 0, 'nothing left to replace');
    const staged = await stage(w, adm, [row(2, 'E9', 'Z', 'D', '2026-11-03', 'FN')]);
    await rejects(w.rpc(adm, 'admin_import_replace_conflicts', staged.batchId, true, 'not committed yet'), '22023', /only a committed batch/);
  });
});

test('a large import (5000 rows) stages in chunks and commits atomically', async () => {
  await withWorld(async (w) => {
    await sessions(w);
    const adm = await w.adminClient();
    const rows = Array.from({ length: 5000 }, (_, i) => row(i + 2, 'EMP' + String(i + 1).padStart(5, '0'), 'Name ' + (i + 1), 'DEPT' + (i % 20), '2026-11-03', i % 2 ? 'AN' : 'FN'));
    const t0 = Date.now();
    const { batchId, summary } = await stage(w, adm, rows, { chunk: 500 });
    const tStage = Date.now() - t0;
    assert.equal(summary.valid, 5000);
    const t1 = Date.now();
    const r = await w.rpc(adm, 'admin_import_commit', batchId, true);
    console.log(`# 5000-row import (local docker): staging+validate ${tStage}ms in 10 RPCs, commit ${Date.now() - t1}ms`);
    assert.equal(r.ok, true);
    assert.equal(await scheduleCount(w), 5000);
    await rejects(w.rpc(adm, 'admin_import_begin', 'too-big.csv', 1, 5001), '22023', /5000/);

    // the same 5000 rows again: all exact duplicates of the live schedule, found without a quadratic blow-up
    const t2 = Date.now();
    const again = await stage(w, adm, rows, { chunk: 500 });
    console.log(`# re-import of the same 5000 rows against a 5000-row schedule (local docker): ${Date.now() - t2}ms`);
    assert.equal(again.summary.exact_duplicate_existing, 5000);
    assert.equal(again.summary.valid, 0);
    assert.equal((await w.rpc(adm, 'admin_import_commit', again.batchId, true)).code, 'NOTHING_TO_IMPORT');
    assert.equal(await scheduleCount(w), 5000);
  });
});

test('imported employees can check in (schedule works end to end)', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    const day = await w.istToday();
    const s = await w.session({ date: day, label: 'FN', opens: -30, closes: 30 });
    await w.rooms(s, [2]);
    const { batchId } = await stage(w, adm, [row(2, ' emp9 ', 'Imported Person', 'Physics', day, 'Forenoon')]);
    await w.rpc(adm, 'admin_import_commit', batchId, true);
    const anon = await w.as('anon');
    const r = await w.checkin(anon, 'EMP9');
    assert.equal(r.code, 'ALLOCATED');
    assert.equal(r.employee_name, 'Imported Person');
  });
});
