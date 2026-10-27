import assert from "node:assert/strict";
import realFs from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { defaultStateFile, loadMarks, markDone, unmarkDone } from "../src/core/marks";
import { DAY, NOW, makeEnv, type TestEnv } from "./fixtures";

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

const readState = () => JSON.parse(fs.readFileSync(env.stateFile, "utf8"));
const writeState = (state: unknown) => {
  fs.mkdirSync(path.dirname(env.stateFile), { recursive: true });
  fs.writeFileSync(env.stateFile, typeof state === "string" ? state : JSON.stringify(state));
};

describe("defaultStateFile", () => {
  it("lives in the launcher's own Application Support folder", () => {
    assert.equal(
      defaultStateFile(),
      path.join(os.homedir(), "Library", "Application Support", "cc-session-launcher", "state.json"),
    );
  });
});

describe("markDone / unmarkDone", () => {
  it("round trip: the mark is stored as ids and numbers only", async () => {
    const before = Date.now();
    await markDone({ id: "local_a", lastActivity: NOW }, env.stateFile);
    const state = readState();
    assert.deepEqual(Object.keys(state), ["version", "marks"]);
    assert.equal(state.version, 1);
    assert.deepEqual(Object.keys(state.marks), ["local_a"]);
    assert.deepEqual(Object.keys(state.marks.local_a).sort(), ["lastActivity", "markedAt"]);
    assert.equal(state.marks.local_a.lastActivity, NOW);
    assert.ok(state.marks.local_a.markedAt >= before && state.marks.local_a.markedAt <= Date.now());

    const marks = loadMarks(env.stateFile);
    assert.deepEqual([...marks.keys()], ["local_a"]);
    assert.equal(marks.get("local_a")?.lastActivity, NOW);
  });

  it("creates the folder, and keeps the file private to the user", async () => {
    assert.equal(fs.existsSync(path.dirname(env.stateFile)), false);
    await markDone({ id: "local_a", lastActivity: NOW }, env.stateFile);
    assert.equal(fs.statSync(env.stateFile).mode & 0o777, 0o600);
  });

  it("marks several sessions side by side", async () => {
    await markDone({ id: "local_a", lastActivity: NOW }, env.stateFile);
    await markDone({ id: "local_b", lastActivity: NOW - DAY }, env.stateFile);
    const marks = loadMarks(env.stateFile);
    assert.deepEqual([...marks.keys()].sort(), ["local_a", "local_b"]);
    assert.equal(marks.get("local_b")?.lastActivity, NOW - DAY);
  });

  it("two calls in flight at once do not lose an update", async () => {
    await Promise.all([
      markDone({ id: "local_a", lastActivity: NOW }, env.stateFile),
      markDone({ id: "local_b", lastActivity: NOW }, env.stateFile),
      unmarkDone("local_nope", env.stateFile),
    ]);
    assert.deepEqual([...loadMarks(env.stateFile).keys()].sort(), ["local_a", "local_b"]);
  });

  it("marking again updates lastActivity and markedAt", async () => {
    const old = Date.now() - 5 * DAY;
    writeState({ version: 1, marks: { local_a: { lastActivity: NOW - DAY, markedAt: old } } });
    await markDone({ id: "local_a", lastActivity: NOW }, env.stateFile);
    const marks = loadMarks(env.stateFile);
    assert.equal(marks.size, 1);
    assert.equal(marks.get("local_a")?.lastActivity, NOW);
    assert.ok((marks.get("local_a")?.markedAt ?? 0) > old);
  });

  it("unmark removes only that session's mark", async () => {
    await markDone({ id: "local_a", lastActivity: NOW }, env.stateFile);
    await markDone({ id: "local_b", lastActivity: NOW }, env.stateFile);
    await unmarkDone("local_a", env.stateFile);
    assert.deepEqual([...loadMarks(env.stateFile).keys()], ["local_b"]);
    await unmarkDone("local_b", env.stateFile);
    assert.deepEqual(readState(), { version: 1, marks: {} });
  });

  it("unmark of an unknown id is a no-op and does not create the file", async () => {
    await unmarkDone("local_nope", env.stateFile);
    assert.equal(fs.existsSync(env.stateFile), false);
    assert.equal(fs.existsSync(path.dirname(env.stateFile)), false, "not even the folder");
  });

  it("unmark of an unknown id leaves an existing file byte for byte as it was", async () => {
    await markDone({ id: "local_a", lastActivity: NOW }, env.stateFile);
    const before = fs.readFileSync(env.stateFile, "utf8");
    await unmarkDone("local_nope", env.stateFile);
    assert.equal(fs.readFileSync(env.stateFile, "utf8"), before);
  });

  it("unmark leaves a corrupt file alone (nothing to remove)", async () => {
    writeState("{ not json");
    await unmarkDone("local_a", env.stateFile);
    assert.equal(fs.readFileSync(env.stateFile, "utf8"), "{ not json");
  });

  it("refuses a session without an id or a usable lastActivity, and writes nothing", async () => {
    await assert.rejects(markDone({ id: "", lastActivity: NOW }, env.stateFile), /without an id/);
    await assert.rejects(markDone({ id: "local_a", lastActivity: Number.NaN }, env.stateFile), /without an id/);
    assert.equal(fs.existsSync(env.stateFile), false);
  });

  it("an id like __proto__ is just an id", async () => {
    await markDone({ id: "__proto__", lastActivity: NOW }, env.stateFile);
    assert.equal(loadMarks(env.stateFile).get("__proto__")?.lastActivity, NOW);
    assert.equal(({} as Record<string, unknown>).lastActivity, undefined, "Object.prototype is untouched");
  });
});

describe("a bad state file", () => {
  it("a missing file reads as empty", () => {
    assert.equal(loadMarks(env.stateFile).size, 0);
  });

  it("a corrupt file reads as empty and never throws", () => {
    for (const text of ["{ this is not json ::::", "", "null", "42", '"str"', "[]", "[1,2]"]) {
      writeState(text);
      assert.equal(loadMarks(env.stateFile).size, 0, JSON.stringify(text));
    }
  });

  it("a directory where the file should be reads as empty", () => {
    fs.mkdirSync(env.stateFile, { recursive: true });
    assert.equal(loadMarks(env.stateFile).size, 0);
  });

  it("a wrong version reads as empty", () => {
    const marks = { local_a: { lastActivity: NOW, markedAt: Date.now() } };
    for (const version of [0, 2, "1", null]) {
      writeState({ version, marks });
      assert.equal(loadMarks(env.stateFile).size, 0, `version ${JSON.stringify(version)}`);
    }
    writeState({ marks });
    assert.equal(loadMarks(env.stateFile).size, 0, "no version");
  });

  it("a bad marks container reads as empty", () => {
    for (const marks of [undefined, null, [], "x", 3]) {
      writeState({ version: 1, marks });
      assert.equal(loadMarks(env.stateFile).size, 0, JSON.stringify(marks));
    }
  });

  it("entries of the wrong shape are skipped, good ones kept, extra fields dropped", () => {
    const good = { lastActivity: NOW, markedAt: Date.now(), note: "extra" };
    writeState({
      version: 1,
      marks: {
        good,
        missing: { lastActivity: NOW },
        strings: { lastActivity: "1", markedAt: "2" },
        nulls: { lastActivity: null, markedAt: null },
        nothing: null,
        scalar: 7,
        list: [NOW, NOW],
      },
    });
    const marks = loadMarks(env.stateFile);
    assert.deepEqual([...marks.keys()], ["good"]);
    assert.deepEqual(Object.keys(marks.get("good")!).sort(), ["lastActivity", "markedAt"]);
  });

  it("writes replace a corrupt or wrong-version file", async () => {
    writeState("{ not json");
    await markDone({ id: "local_a", lastActivity: NOW }, env.stateFile);
    assert.deepEqual(Object.keys(readState().marks), ["local_a"]);

    writeState({ version: 2, marks: { local_old: { lastActivity: 1, markedAt: Date.now() } } });
    await markDone({ id: "local_b", lastActivity: NOW }, env.stateFile);
    assert.deepEqual(Object.keys(readState().marks), ["local_b"]);
    assert.equal(readState().version, 1);
  });

  it("a write that cannot happen throws, and leaves no temp file behind", async () => {
    const blocker = path.join(env.root, "blocker");
    fs.writeFileSync(blocker, "a file, not a folder");
    await assert.rejects(markDone({ id: "local_a", lastActivity: NOW }, path.join(blocker, "state.json")));
    fs.mkdirSync(env.stateFile, { recursive: true }); // rename over a directory fails after the temp file is written
    await assert.rejects(markDone({ id: "local_a", lastActivity: NOW }, env.stateFile));
    assert.deepEqual(fs.readdirSync(path.dirname(env.stateFile)), ["state.json"], "no tmp files left behind");
  });
});

describe("pruning", () => {
  it("drops marks made more than 90 days ago on the next write", async () => {
    const now = Date.now();
    writeState({
      version: 1,
      marks: {
        local_old: { lastActivity: NOW, markedAt: now - 91 * DAY },
        local_older: { lastActivity: NOW, markedAt: now - 400 * DAY },
        local_recent: { lastActivity: NOW, markedAt: now - 89 * DAY },
      },
    });
    assert.equal(loadMarks(env.stateFile).size, 3, "reading does not prune");
    await markDone({ id: "local_new", lastActivity: NOW }, env.stateFile);
    assert.deepEqual([...loadMarks(env.stateFile).keys()].sort(), ["local_new", "local_recent"]);
  });

  it("unmarking prunes too", async () => {
    const now = Date.now();
    writeState({
      version: 1,
      marks: {
        local_old: { lastActivity: NOW, markedAt: now - 91 * DAY },
        local_keep: { lastActivity: NOW, markedAt: now - DAY },
        local_gone: { lastActivity: NOW, markedAt: now - DAY },
      },
    });
    await unmarkDone("local_gone", env.stateFile);
    assert.deepEqual([...loadMarks(env.stateFile).keys()], ["local_keep"]);
  });

  it("keeps only the newest 2000 marks", async () => {
    const now = Date.now();
    const marks: Record<string, unknown> = {};
    for (let i = 0; i < 2005; i++) marks[`local_${i}`] = { lastActivity: NOW, markedAt: now - 60_000 - i * 1000 };
    writeState({ version: 1, marks });
    await markDone({ id: "local_new", lastActivity: NOW }, env.stateFile);
    const kept = loadMarks(env.stateFile);
    assert.equal(kept.size, 2000);
    assert.ok(kept.has("local_new"), "the mark just made survives");
    assert.ok(kept.has("local_0") && kept.has("local_1998"), "the newest old ones survive");
    for (const id of ["local_1999", "local_2000", "local_2004"]) assert.ok(!kept.has(id), `${id} is the oldest`);
  });

  it("age pruning happens before the count cap", async () => {
    const now = Date.now();
    const marks: Record<string, unknown> = {};
    for (let i = 0; i < 1999; i++) marks[`local_${i}`] = { lastActivity: NOW, markedAt: now - 60_000 - i };
    for (let i = 0; i < 10; i++) marks[`local_stale_${i}`] = { lastActivity: NOW, markedAt: now - 100 * DAY };
    writeState({ version: 1, marks });
    await markDone({ id: "local_new", lastActivity: NOW }, env.stateFile);
    const kept = loadMarks(env.stateFile);
    assert.equal(kept.size, 2000, "1999 recent + the new one, no stale ones");
    assert.ok(![...kept.keys()].some((id) => id.startsWith("local_stale_")));
  });
});

describe("atomic writes", () => {
  it("leave no temp files behind, however many writes", async () => {
    for (let i = 0; i < 5; i++) await markDone({ id: `local_${i}`, lastActivity: NOW }, env.stateFile);
    await unmarkDone("local_2", env.stateFile);
    assert.deepEqual(fs.readdirSync(path.dirname(env.stateFile)), ["state.json"]);
    assert.equal(loadMarks(env.stateFile).size, 4);
  });

  it("write a sibling temp file and rename it over the state file", async () => {
    await markDone({ id: "local_a", lastActivity: NOW }, env.stateFile);
    const before = fs.readFileSync(env.stateFile, "utf8");
    const seen: { from: string; to: string; target: string; temp: string }[] = [];
    const rename = realFs.renameSync;
    realFs.renameSync = ((from: string, to: string) => {
      seen.push({ from, to, target: fs.readFileSync(to, "utf8"), temp: fs.readFileSync(from, "utf8") });
      return rename(from, to);
    }) as typeof realFs.renameSync;
    try {
      await markDone({ id: "local_b", lastActivity: NOW }, env.stateFile);
    } finally {
      realFs.renameSync = rename;
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0].to, env.stateFile);
    assert.equal(path.dirname(seen[0].from), path.dirname(env.stateFile), "same folder, so the rename is atomic");
    assert.notEqual(seen[0].from, env.stateFile);
    assert.equal(seen[0].target, before, "the state file is untouched until the rename");
    assert.deepEqual(Object.keys(JSON.parse(seen[0].temp).marks).sort(), ["local_a", "local_b"], "complete JSON");
  });
});
