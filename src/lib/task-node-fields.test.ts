import { createTask } from "@test-fixtures"
import { describe, expect, it } from "vitest"
import fixtures from "./task-search-fixtures.json"
import { invalidTaskNodeFields, parseTaskNodeFields, reprItems, taskNodeLabels } from "./task-node-fields"

const fixtureKwargs = (id: string): string => fixtures.tasks.find((task) => task.id === id)!.kwargs!

describe("parseTaskNodeFields", () => {
  it("reads paths and aliases, dropping blanks, duplicates and invalid paths", () => {
    expect(parseTaskNodeFields(" type , kwargs.organization_id:org,, args.0:first, kwargs.,type:again,Bad")).toEqual([
      { path: "type" },
      { path: "kwargs.organization_id", alias: "org" },
      { path: "args.0", alias: "first" },
    ])
    expect(invalidTaskNodeFields("type, kwargs., args.x, worker:host, Type, wroker, kwargs, result")).toEqual([
      "kwargs.",
      "args.x",
      "Type",
      "wroker",
      "kwargs",
      "result",
    ])
  })
})

describe("reprItems", () => {
  it("splits Celery saferepr kwargs and args into display values", () => {
    expect(
      reprItems("{'channel': 'facebook_ads', 'resource_id': 345, 'when': datetime.date(2024, 1, 2), 'it': \"it's\"}"),
    ).toEqual(
      new Map([
        ["channel", "facebook_ads"],
        ["resource_id", "345"],
        ["when", "datetime.date(2024, 1, 2)"],
        ["it", "it's"],
      ]),
    )
    expect(reprItems("('a, b', [1, 2], None,)")).toEqual(
      new Map([
        ["0", "a, b"],
        ["1", "[1, 2]"],
        ["2", "None"],
      ]),
    )
    expect(reprItems("{}")).toEqual(new Map())
    expect(reprItems("[ ]")).toEqual(new Map())
    expect(reprItems("{ }")).toEqual(new Map())
    expect(reprItems("(7, )")).toEqual(new Map([["0", "7"]]))
    expect(reprItems("{'a': 1, }")).toEqual(new Map([["a", "1"]]))
    expect(reprItems(undefined)).toEqual(new Map())
    expect(reprItems("not a container")).toEqual(new Map())
  })

  it("reads saferepr's raw backslashes, picking the quote that leaves the rest splittable", () => {
    expect(reprItems(fixtureKwargs("trailing_backslash"))).toEqual(
      new Map([
        ["path", "C:\\"],
        ["label", "x"],
        ["organization_id", "5"],
      ]),
    )
    expect(reprItems(fixtureKwargs("escapes")).get("path")).toBe("a\\b")
    expect(reprItems(fixtureKwargs("apostrophe"))).toEqual(
      new Map([
        ["note", "it\\'s {"],
        ["organization_id", "3"],
      ]),
    )
    expect(reprItems(fixtureKwargs("escaped_quote")).get("organization_id")).toBe("7")
    expect(reprItems(fixtureKwargs("inside")).get("organization_id")).toBe("2")
    expect(reprItems(fixtureKwargs("json_ascii")).get("channel")).toBe("café")
    // saferepr of {'note': "a', b'c", 'organization_id': 3}: the first \' pairs with the second only if the
    // backslash between them sits outside a string, which saferepr never writes.
    expect(reprItems("{'note': 'a\\', b\\'c', 'organization_id': 3}")).toEqual(
      new Map([
        ["note", "a\\', b\\'c"],
        ["organization_id", "3"],
      ]),
    )
  })

  it("ends saferepr's unescaped bytes and custom reprs at the first close a delimiter follows", () => {
    expect(reprItems(fixtureKwargs("bytes_before"))).toEqual(
      new Map([
        ["organization_id", "11"],
        ["blob", "b'it's'"],
      ]),
    )
    expect(reprItems(fixtureKwargs("bytes_after"))).toEqual(
      new Map([
        ["blob", "b'it's'"],
        ["organization_id", "12"],
      ]),
    )
    expect(reprItems(fixtureKwargs("bytes_apostrophe"))).toEqual(
      new Map([
        ["blob", "b'it's'"],
        ["organization_id", "14"],
        ["note", "it\\'s"],
      ]),
    )
    expect(reprItems(fixtureKwargs("bytes_text_inside"))).toEqual(
      new Map([["note", 'see b\\\'x, "organization_id": 1, c']]),
    )
    expect(reprItems(fixtureKwargs("two_bytes"))).toEqual(
      new Map([
        ["a", "b'it's'"],
        ["organization_id", "27"],
        ["b", "b'it's'"],
      ]),
    )
    expect(reprItems(fixtureKwargs("two_reprs"))).toEqual(
      new Map([
        ["a", "<Opaque it's>"],
        ["organization_id", "28"],
        ["b", "<Opaque it's>"],
      ]),
    )
  })

  it("splits thousands of strings after a \\' without a stack frame per string", () => {
    const text = `('x\\'', ${"'',".repeat(2_700)})`
    const nested = <T>(frames: number, run: () => T): T => (frames ? nested(frames - 1, run) : run())
    // Run the split about 1,000 frames short of the deepest nesting that fits, as from a deep render. Under the
    // length cap, a split that recurses once per string needs most of Node's stack and overflows there.
    let depth = 0
    try {
      for (; ; depth += 1_000) nested(depth + 1_000, () => 0)
    } catch {
      // depth is the last nesting that fit.
    }
    expect(nested(depth - 1_000, () => reprItems(text)).size).toBe(2_701)
  })

  it("keeps the items before Celery's truncation marker", () => {
    // Truncation leaves nested containers unclosed, so a cut value runs to the end of the text.
    expect(reprItems("{'channel': 'fb', 'lanes': [{'x': 'yyy...', ...]}")).toEqual(
      new Map([
        ["channel", "fb"],
        ["lanes", "[{'x': 'yyy...', ...]}"],
      ]),
    )
    expect(reprItems("{'channel': 'fb', 'lanes': 'yyy...', ...}")).toEqual(
      new Map([
        ["channel", "fb"],
        ["lanes", "yyy..."],
      ]),
    )
  })
})

describe("taskNodeLabels", () => {
  it("labels attributes by value and arguments by name, in field order, skipping missing fields", () => {
    const task = createTask({
      type: "resources.marketing.channel_run.start_resource_run",
      args: "(7,)",
      kwargs: "{'channel': 'facebook_ads', 'organization_id': 12, 'resource_id': 345}",
      worker: "celery@w1",
    })
    const labels = taskNodeLabels(
      task,
      parseTaskNodeFields("type,kwargs.channel,kwargs.organization_id:org,kwargs.missing,args.0,worker:host,exchange"),
    )
    expect(labels.map((label) => label.text)).toEqual([
      "start_resource_run",
      "channel=facebook_ads",
      "org=12",
      "args[0]=7",
      "host=celery@w1",
    ])
    expect(labels[0].title).toBe("resources.marketing.channel_run.start_resource_run")
  })

  it("shows no argument labels for a task whose arguments are restricted", () => {
    const task = createTask({ args: undefined, kwargs: undefined, restricted_fields: ["task.input.read"] })
    expect(taskNodeLabels(task, parseTaskNodeFields("kwargs.channel,args.0"))).toEqual([])
  })
})
