import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { model } from "./jujutsu.ts";

interface JjStubs {
  diffSummary?: string;
  describeCode?: number;
  newCode?: number;
  pushCode?: number;
  pushStdout?: string;
  stderr?: string;
}

function stubJjCommand(stubs: JjStubs = {}) {
  const invocations: { cmd: string; args: string[]; cwd?: string }[] = [];
  const originalCommand = Deno.Command;
  const encoder = new TextEncoder();
  class FakeCommand {
    constructor(
      public cmd: string,
      public options: { args?: string[]; cwd?: string },
    ) {
      invocations.push({ cmd, args: options.args ?? [], cwd: options.cwd });
    }
    output() {
      const args = this.options.args ?? [];
      const stderr = encoder.encode(stubs.stderr ?? "jj: something failed");
      const result = (code: number, stdout = "") =>
        Promise.resolve({
          code,
          success: code === 0,
          stdout: encoder.encode(stdout),
          stderr,
        });
      if (args[0] === "diff") return result(0, stubs.diffSummary ?? "");
      if (args[0] === "describe") return result(stubs.describeCode ?? 0);
      if (args[0] === "new") return result(stubs.newCode ?? 0);
      if (args[0] === "git" && args[1] === "push") {
        return result(stubs.pushCode ?? 0, stubs.pushStdout ?? "");
      }
      return result(1);
    }
  }
  (Deno as unknown as Record<string, unknown>).Command = FakeCommand;
  return {
    invocations,
    restore: () => {
      (Deno as unknown as Record<string, unknown>).Command = originalCommand;
    },
  };
}

function mockWriteResource() {
  const writes: {
    specName: string;
    name: string;
    data: Record<string, unknown>;
  }[] = [];
  return {
    writeResource: async (
      specName: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ specName, name, data });
      return { name };
    },
    writes,
  };
}

function makeContext() {
  const writeResource = mockWriteResource();
  return {
    writeResource,
    context: {
      globalArgs: { workingDirectory: "/tmp/project" },
      writeResource: writeResource.writeResource,
    },
  };
}

Deno.test("jujutsu - publish describes, starts a fresh commit, and pushes the working copy", async () => {
  const commands = stubJjCommand({
    diffSummary: "M go.mod\nM go.sum\n",
    pushStdout:
      "Creating bookmark sam/abc123/chore-bump-deps for revision abc123\n",
  });
  const { writeResource, context } = makeContext();

  try {
    await model.methods.publish.execute(
      { message: "chore: bump deps" },
      context,
    );

    assertEquals(
      commands.invocations.map((i) => i.args),
      [
        ["diff", "--summary"],
        ["describe", "-m", "chore: bump deps"],
        ["new"],
        ["git", "push", "-c", "@-"],
      ],
    );
    assertEquals(commands.invocations[0]?.cmd, "jj");
    assertEquals(commands.invocations[0]?.cwd, "/tmp/project");
    assertEquals(writeResource.writes[0].data, {
      command: "jj describe && jj new && jj git push -c @- (in /tmp/project)",
      exitCode: 0,
      success: true,
      pushed: true,
      description: "chore: bump deps",
      bookmark: "sam/abc123/chore-bump-deps",
    });
  } finally {
    commands.restore();
  }
});

Deno.test("jujutsu - publish skips cleanly when the working copy has no changes", async () => {
  const commands = stubJjCommand({ diffSummary: "" });
  const { writeResource, context } = makeContext();

  try {
    await model.methods.publish.execute(
      { message: "chore: bump deps" },
      context,
    );

    assertEquals(commands.invocations.length, 1);
    assertEquals(commands.invocations[0]?.args, ["diff", "--summary"]);
    assertEquals(writeResource.writes[0].data, {
      command: "jj diff --summary (in /tmp/project)",
      exitCode: 0,
      success: true,
      pushed: false,
      description: "chore: bump deps",
      bookmark: "",
    });
  } finally {
    commands.restore();
  }
});

Deno.test("jujutsu - publish writes failure record then throws when describe fails", async () => {
  const commands = stubJjCommand({
    diffSummary: "M go.mod\n",
    describeCode: 1,
  });
  const { writeResource, context } = makeContext();

  try {
    await assertRejects(
      () =>
        model.methods.publish.execute({ message: "chore: bump deps" }, context),
      Error,
      "jj describe failed (exit 1): jj: something failed",
    );

    assertEquals(writeResource.writes.length, 1);
    assertEquals(writeResource.writes[0].data.success, false);
    assertEquals(writeResource.writes[0].data.pushed, false);
    assertEquals(writeResource.writes[0].data.bookmark, "");
    assertEquals(
      commands.invocations.filter((i) => i.args[0] === "new").length,
      0,
    );
  } finally {
    commands.restore();
  }
});

Deno.test("jujutsu - publish writes failure record then throws when push fails", async () => {
  const commands = stubJjCommand({
    diffSummary: "M go.mod\n",
    pushCode: 1,
  });
  const { writeResource, context } = makeContext();

  try {
    await assertRejects(
      () =>
        model.methods.publish.execute({ message: "chore: bump deps" }, context),
      Error,
      "jj git push -c @- failed (exit 1): jj: something failed",
    );

    assertEquals(writeResource.writes.length, 1);
    assertEquals(writeResource.writes[0].data.success, false);
    assertEquals(writeResource.writes[0].data.pushed, false);
  } finally {
    commands.restore();
  }
});

Deno.test("jujutsu - publish throws when push output has no created bookmark", async () => {
  const commands = stubJjCommand({
    diffSummary: "M go.mod\n",
    pushCode: 0,
    pushStdout: "Nothing to push\n",
  });
  const { writeResource, context } = makeContext();

  try {
    await assertRejects(
      () =>
        model.methods.publish.execute({ message: "chore: bump deps" }, context),
      Error,
      "jj git push -c @- failed (exit 0): could not find created bookmark in output",
    );

    assertEquals(writeResource.writes.length, 1);
    assertEquals(writeResource.writes[0].data.success, false);
    assertEquals(writeResource.writes[0].data.pushed, false);
    assertEquals(writeResource.writes[0].data.bookmark, "");
  } finally {
    commands.restore();
  }
});

Deno.test("jujutsu - publish rejects a blank message without running jj", async () => {
  const commands = stubJjCommand({ diffSummary: "M go.mod\n" });
  const { context } = makeContext();

  try {
    await assertRejects(
      () => model.methods.publish.execute({ message: "  \n" }, context),
      Error,
      "message must be a non-empty string",
    );

    assertEquals(commands.invocations.length, 0);
  } finally {
    commands.restore();
  }
});

Deno.test("jujutsu - publish defaults to the current working directory", async () => {
  const commands = stubJjCommand({ diffSummary: "" });
  const writeResource = mockWriteResource();

  try {
    await model.methods.publish.execute({ message: "chore: bump deps" }, {
      globalArgs: {},
      writeResource: writeResource.writeResource,
    });

    assertEquals(commands.invocations[0]?.cwd, Deno.cwd());
  } finally {
    commands.restore();
  }
});
