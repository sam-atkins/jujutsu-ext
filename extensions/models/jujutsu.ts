/**
 * Publishes working-copy changes from a jj (jujutsu) repository: describes the
 * working-copy commit, starts a fresh working copy, and pushes the described
 * commit to the default remote with a change-based bookmark.
 *
 * @module
 */
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  workingDirectory: z.string().optional(),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

type PublishContext = {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

const PublishOutputSchema = z.object({
  command: z.string(),
  exitCode: z.number(),
  success: z.boolean(),
  pushed: z.boolean(),
  description: z.string(),
  bookmark: z.string(),
});

type JjResult = { code: number; stdout: string; stderr: string };

async function runJj(args: string[], workdir: string): Promise<JjResult> {
  const { code, stdout, stderr } = await new Deno.Command("jj", {
    args,
    cwd: workdir,
  }).output();
  const decoder = new TextDecoder();
  return {
    code,
    stdout: decoder.decode(stdout),
    stderr: decoder.decode(stderr),
  };
}

function parseBookmark(pushOutput: string): string {
  const match = pushOutput.match(/^Creating bookmark (\S+) for revision/m);
  return match ? match[1] : "";
}

async function failAndThrow(
  context: PublishContext,
  label: string,
  workdir: string,
  ran: JjResult,
  description: string,
  reason?: string,
): Promise<never> {
  await context.writeResource("result", "current", {
    command: `${label} (in ${workdir})`,
    exitCode: ran.code,
    success: false,
    pushed: false,
    description,
    bookmark: "",
  });
  const detail = reason ?? (ran.stderr.trim() || `exit ${ran.code}`);
  throw new Error(`${label} failed (exit ${ran.code}): ${detail}`);
}

export const model = {
  type: "@dismal_swamper/jujutsu",
  version: "2026.09.19.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.09.19.1",
      description: "Initial version",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    result: {
      description: "Result of the working-copy publish",
      schema: PublishOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    publish: {
      description:
        "Describe the working-copy commit, start a fresh working copy, and push the described commit to the default remote with a change-based bookmark",
      arguments: z.object({
        message: z.string().min(1).describe(
          "Description applied to the working-copy commit before pushing",
        ),
      }),
      execute: async (
        args: { message: string },
        context: PublishContext,
      ) => {
        const workdir = context.globalArgs.workingDirectory || Deno.cwd();
        const description = args.message.trim();
        if (!description) {
          throw new Error("message must be a non-empty string");
        }

        const diff = await runJj(["diff", "--summary"], workdir);
        if (diff.code !== 0) {
          return await failAndThrow(
            context,
            "jj diff --summary",
            workdir,
            diff,
            description,
          );
        }
        if (!diff.stdout.trim()) {
          const handle = await context.writeResource("result", "current", {
            command: `jj diff --summary (in ${workdir})`,
            exitCode: diff.code,
            success: true,
            pushed: false,
            description,
            bookmark: "",
          });
          return { dataHandles: [handle] };
        }

        const describe = await runJj(["describe", "-m", description], workdir);
        if (describe.code !== 0) {
          return await failAndThrow(
            context,
            "jj describe",
            workdir,
            describe,
            description,
          );
        }

        const fresh = await runJj(["new"], workdir);
        if (fresh.code !== 0) {
          return await failAndThrow(
            context,
            "jj new",
            workdir,
            fresh,
            description,
          );
        }

        const push = await runJj(["git", "push", "-c", "@-"], workdir);
        const bookmark = parseBookmark(push.stdout);
        if (push.code !== 0 || !bookmark) {
          return await failAndThrow(
            context,
            "jj git push -c @-",
            workdir,
            push,
            description,
            push.code === 0
              ? "could not find created bookmark in output"
              : undefined,
          );
        }

        const handle = await context.writeResource("result", "current", {
          command: `jj describe && jj new && jj git push -c @- (in ${workdir})`,
          exitCode: push.code,
          success: true,
          pushed: true,
          description,
          bookmark,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
