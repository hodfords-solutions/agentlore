import { describe, expect, it } from "vitest";
import {
  parseTime,
  SCHEDULE_LABEL,
  type ScheduleOptions,
  schedulePlan,
} from "../../src/integrations/schedule.js";

const options = (over: Partial<ScheduleOptions> = {}): ScheduleOptions => ({
  platform: "darwin",
  home: "/home/me",
  node: "/opt/node/bin/node",
  cli: "/opt/lore/dist/cli/index.js",
  logFile: "/home/me/.agentlore/schedule.log",
  hour: 9,
  minute: 5,
  env: {},
  uid: 501,
  ...over,
});

describe("parseTime", () => {
  it("reads HH:MM and rejects anything else", () => {
    expect(parseTime("12:30")).toEqual({ hour: 12, minute: 30 });
    expect(parseTime("7:05")).toEqual({ hour: 7, minute: 5 });
    for (const bad of ["24:00", "12:60", "noon", "12", "12:3"])
      expect(parseTime(bad)).toBeUndefined();
  });
});

describe("schedulePlan", () => {
  it("writes a launchd agent on macOS and loads it in the user's GUI domain", () => {
    const plan = schedulePlan(
      options({ env: { AGENTLORE_HOME: "/data/<lore>&co" }, cli: "/a b/index.js" }),
    );
    expect(plan.files.map((f) => f.path)).toEqual([
      `/home/me/Library/LaunchAgents/${SCHEDULE_LABEL}.plist`,
    ]);
    const plist = plan.files[0]?.content ?? "";
    expect(plist).toContain(
      "<string>/opt/node/bin/node</string>\n    <string>/a b/index.js</string>\n    <string>index</string>",
    );
    expect(plist).toContain("<integer>9</integer>");
    expect(plist).toContain("<integer>5</integer>");
    expect(plist).toContain(
      "<key>AGENTLORE_HOME</key>\n    <string>/data/&lt;lore&gt;&amp;co</string>",
    );
    expect(plist).toContain("<string>/home/me/.agentlore/schedule.log</string>");
    expect(plan.install.map((c) => [c.file, ...c.args])).toEqual([
      ["launchctl", "bootout", `gui/501/${SCHEDULE_LABEL}`],
      ["launchctl", "bootstrap", "gui/501", plan.files[0]?.path],
    ]);
    expect(plan.install[0]?.optional).toBe(true);
  });

  it("writes a persistent systemd user timer on Linux", () => {
    const plan = schedulePlan(
      options({
        platform: "linux",
        configHome: "/cfg",
        env: { AGENTLORE_HOME: '/data/50% "lore"' },
      }),
    );
    expect(plan.files.map((f) => f.path)).toEqual([
      "/cfg/systemd/user/agentlore-index.timer",
      "/cfg/systemd/user/agentlore-index.service",
    ]);
    const [timer, service] = plan.files.map((f) => f.content);
    expect(timer).toContain("OnCalendar=*-*-* 09:05:00\nPersistent=true");
    expect(service).toContain(
      'ExecStart="/opt/node/bin/node" "/opt/lore/dist/cli/index.js" "index"',
    );
    expect(service).toContain('Environment="AGENTLORE_HOME=/data/50%% \\"lore\\""');
    expect(plan.install.at(-1)?.args).toEqual([
      "--user",
      "enable",
      "--now",
      "agentlore-index.timer",
    ]);
    expect(schedulePlan(options({ platform: "linux" })).files[0]?.path).toBe(
      "/home/me/.config/systemd/user/agentlore-index.timer",
    );
  });

  it("creates a daily Task Scheduler task on Windows", () => {
    const plan = schedulePlan(
      options({ platform: "win32", node: "C:\\node\\node.exe", cli: "C:\\lore\\index.js" }),
    );
    expect(plan.files).toEqual([]);
    expect(plan.install[0]?.args).toEqual([
      "/Create",
      "/F",
      "/SC",
      "DAILY",
      "/ST",
      "09:05",
      "/TN",
      "agentlore-index",
      "/TR",
      '"C:\\node\\node.exe" "C:\\lore\\index.js" index',
    ]);
    expect(plan.query?.args).toEqual(["/Query", "/TN", "agentlore-index"]);
  });

  it("refuses other platforms", () => {
    expect(() => schedulePlan(options({ platform: "aix" }))).toThrow(/not supported on aix/);
  });

  it("runs the given arguments, e.g. index then consolidate", () => {
    const args = ["index", "--consolidate"];
    expect(schedulePlan(options({ args })).files[0]?.content).toContain(
      "<string>index</string>\n    <string>--consolidate</string>",
    );
    const linux = schedulePlan(options({ platform: "linux", args })).files.map((f) => f.content);
    expect(linux.join("\n")).toContain('"index" "--consolidate"');
    const windows = schedulePlan(options({ platform: "win32", args })).install[0]?.args.at(-1);
    expect(windows).toMatch(/index --consolidate$/);
  });
});
