import { chmod, cp, readFile } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRepo, writeFiles } from "./repo.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** A copy of `example/`, so a run leaves `example/.everypath/` alone. */
export async function exampleRepo(): Promise<string> {
  const copy = await makeRepo({});
  await cp(join(repoRoot, "example"), copy, {
    recursive: true,
    filter: (path) => basename(path) !== ".everypath",
  });
  return copy;
}

/** A real TLC 2.19 output captured from a hand-written model of `example/`. */
export function fixture(name: "violation" | "ok" | "liveness" | "stuttering" | "parse-error") {
  return readFile(join(repoRoot, "test", "fixtures", `tlc-output-${name}.txt`), "utf8");
}

/** The identifiers `generateTla` mints for `example/`, as `result.json` stores them. */
export const EXAMPLE_NAMES = {
  states: {
    S1: "DB層",
    S2_Home: "Home",
    S3: "パスワードリセット",
    S4: "マイページ",
    S5: "ログアウト",
    S6: "ログイン",
    S7: "ロック",
    S8: "新規登録",
  },
  vars: { v1_authed: "authed", v2_retries: "retries" },
  events: {
    tau: null,
    e1_back: "back",
    e2_cancel: "cancel",
    e3_code_invalid: "code_invalid",
    e4_login_fail: "login_fail",
    e5_login_ok: "login_ok",
    e6_logout: "logout",
    e7_open_mypage: "open_mypage",
    e8_reset_done: "reset_done",
    e9_signup_done: "signup_done",
  },
  members: {},
  checks: {
    P1_no_unauth_home: "no-unauth-home",
    P2_lock_after_3: "lock-after-3",
    P3_logout_eventually_login: "logout-eventually-login",
    TypeOK: "TypeOK",
  },
} as const;

const EVENT_IDS = new Map<string, string>(
  Object.entries(EXAMPLE_NAMES.events).flatMap(([id, name]) => (name === null ? [] : [[name, id]])),
);

/**
 * The fixtures name things as the hand-written model did (`authed`, `"login_fail"`). This renames
 * them to what `generateTla` mints for `example/`, so a fake `java` can answer the generated model.
 * `invariant` replaces the violated invariant's name.
 */
export function forExample(output: string, invariant = "P1_no_unauth_home"): string {
  return output
    .replaceAll("NoUnauthHome", invariant)
    .replace(/^\/\\ authed =/gm, "/\\ v1_authed =")
    .replace(/^\/\\ retries =/gm, "/\\ v2_retries =")
    .replace(
      /^\/\\ lastEvent = "(\w+)"/gm,
      (_line, event: string) => `/\\ lastEvent = "${EVENT_IDS.get(event) ?? event}"`,
    );
}

export type Reply = {
  readonly output: string;
  readonly exit?: number;
  /** Print `output`, then sleep as the one process, so a kill closes the pipes. */
  readonly hang?: boolean;
};

/** The first rule whose `when` appears in Model.cfg answers; `otherwise` answers the rest. */
export type FakeJavaScript = {
  readonly rules: readonly { readonly when: string; readonly reply: Reply }[];
  readonly otherwise: Reply;
};

export type FakeJava = {
  /** `process.env` with the fake `java` first on `PATH` and a dummy jar in `EVERYPATH_TLA_JAR`. */
  readonly env: NodeJS.ProcessEnv;
  readonly jar: string;
  /** The Model.cfg of every TLC run, in order. */
  cfgs(): Promise<string[]>;
  /** `<cwd> <arguments>` of every TLC run, in order. */
  calls(): Promise<string[]>;
};

function answer(reply: Reply, file: string): string {
  const exit = `exit ${reply.exit ?? 0}`;
  return `cat '${file}'\n${reply.hang === true ? "exec sleep 60" : exit}`;
}

/** A shell script named `java`: `-version` succeeds, anything else logs its cfg and replies. */
export async function fakeJava({ rules, otherwise }: FakeJavaScript): Promise<FakeJava> {
  const directory = await makeRepo({});
  const outputs: Record<string, string> = {};
  const answers = [...rules.map(({ reply }) => reply), otherwise].map((reply, index) => {
    const name = `out-${index}.txt`;
    outputs[name] = reply.output;
    return answer(reply, join(directory, name));
  });
  const branches = rules.map(
    ({ when }, index) => `if grep -q -F -e '${when}' Model.cfg; then\n${answers[index]}\nfi`,
  );
  const script = [
    "#!/bin/sh",
    '[ "$1" = "-version" ] && exit 0',
    `echo "$PWD $*" >> '${join(directory, "calls.log")}'`,
    `{ cat Model.cfg; echo '--'; } >> '${join(directory, "cfgs.log")}'`,
    ...branches,
    answers[rules.length],
    "",
  ].join("\n");
  await writeFiles(directory, {
    ...outputs,
    "bin/java": script,
    "tla2tools.jar": "not a jar",
  });
  await chmod(join(directory, "bin", "java"), 0o755);

  const read = (name: string) => readFile(join(directory, name), "utf8").catch(() => "");
  const jar = join(directory, "tla2tools.jar");
  return {
    env: {
      ...process.env,
      PATH: `${join(directory, "bin")}${delimiter}${process.env.PATH ?? ""}`,
      EVERYPATH_TLA_JAR: jar,
    },
    jar,
    cfgs: async () => (await read("cfgs.log")).split("--\n").slice(0, -1),
    calls: async () => (await read("calls.log")).split("\n").filter((line) => line !== ""),
  };
}
