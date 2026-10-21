import path from "node:path";

/**
 * A daily `lore index` run by the OS scheduler: launchd on macOS, a systemd user timer on Linux,
 * Task Scheduler on Windows. Searches already refresh a stale index, but only when something
 * searches; the daily run indexes new sessions (and archives deleted ones) even when nothing does.
 */

export const SCHEDULE_LABEL = "com.agentlore.index";
const SYSTEMD_UNIT = "agentlore-index";
const WINDOWS_TASK = "agentlore-index";

export interface Command {
  file: string;
  args: string[];
  /** A failure is ignored, e.g. unloading a job that is not loaded. */
  optional?: boolean;
}

export interface SchedulePlan {
  /** Files to write on install and remove on uninstall; the first one marks it as installed. */
  files: { path: string; content: string }[];
  /** Run after writing the files. */
  install: Command[];
  /** Run before removing the files. */
  uninstall: Command[];
  /** Run after removing the files. */
  afterUninstall: Command[];
  /** Succeeds when the job is installed (Windows, which keeps no file of ours). */
  query?: Command;
  /** Where the job lives, for messages. */
  where: string;
}

export interface ScheduleOptions {
  platform: NodeJS.Platform;
  home: string;
  /** The Node.js binary and the CLI script to run, with its arguments (default `index`). */
  node: string;
  cli: string;
  args?: string[];
  /** Output of each run is appended here (not on Windows). */
  logFile: string;
  hour: number;
  minute: number;
  /** Variables the job needs, e.g. AGENTLORE_HOME (not on Windows). */
  env: Record<string, string>;
  /** For launchd's gui/<uid> domain. */
  uid?: number;
  /** XDG_CONFIG_HOME, when set. */
  configHome?: string;
}

/** "HH:MM" to a time of day; undefined when it is not one. */
export function parseTime(value: string): { hour: number; minute: number } | undefined {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return undefined;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

const jobArgs = (o: ScheduleOptions) => o.args ?? ["index"];

const pad = (n: number) => String(n).padStart(2, "0");

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One argument of a systemd command line or assignment, quoted. */
const systemdQuoted = (text: string) =>
  `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

/** The files and commands that install, remove and check the daily job on `platform`. */
export function schedulePlan(o: ScheduleOptions): SchedulePlan {
  if (o.platform === "darwin") return launchdPlan(o);
  if (o.platform === "linux") return systemdPlan(o);
  if (o.platform === "win32") return windowsPlan(o);
  throw new Error(`scheduling is not supported on ${o.platform}; run \`lore index\` from cron.`);
}

function launchdPlan(o: ScheduleOptions): SchedulePlan {
  const file = path.posix.join(o.home, "Library", "LaunchAgents", `${SCHEDULE_LABEL}.plist`);
  const strings = (values: string[]) =>
    values.map((v) => `    <string>${xml(v)}</string>`).join("\n");
  const env = Object.entries(o.env);
  const environment = env.length
    ? `  <key>EnvironmentVariables</key>
  <dict>
${env.map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join("\n")}
  </dict>
`
    : "";
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SCHEDULE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings([o.node, o.cli, ...jobArgs(o)])}
  </array>
${environment}  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${o.hour}</integer>
    <key>Minute</key>
    <integer>${o.minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(o.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(o.logFile)}</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
</dict>
</plist>
`;
  const domain = `gui/${o.uid ?? 501}`;
  const bootout: Command = {
    file: "launchctl",
    args: ["bootout", `${domain}/${SCHEDULE_LABEL}`],
    optional: true,
  };
  return {
    files: [{ path: file, content }],
    // Reinstalling replaces a loaded job.
    install: [bootout, { file: "launchctl", args: ["bootstrap", domain, file] }],
    uninstall: [bootout],
    afterUninstall: [],
    where: file,
  };
}

function systemdPlan(o: ScheduleOptions): SchedulePlan {
  const dir = path.posix.join(
    o.configHome || path.posix.join(o.home, ".config"),
    "systemd",
    "user",
  );
  const service = `[Unit]
Description=agentlore: index new AI coding sessions

[Service]
Type=oneshot
ExecStart=${[o.node, o.cli, ...jobArgs(o)].map(systemdQuoted).join(" ")}
${Object.entries(o.env)
  .map(([k, v]) => `Environment=${systemdQuoted(`${k}=${v}`)}\n`)
  .join("")}StandardOutput=append:${o.logFile}
StandardError=append:${o.logFile}
Nice=10
IOSchedulingClass=idle
`;
  const timer = `[Unit]
Description=agentlore: index new AI coding sessions daily

[Timer]
OnCalendar=*-*-* ${pad(o.hour)}:${pad(o.minute)}:00
Persistent=true

[Install]
WantedBy=timers.target
`;
  const systemctl = (...args: string[]): Command => ({
    file: "systemctl",
    args: ["--user", ...args],
  });
  return {
    files: [
      { path: path.posix.join(dir, `${SYSTEMD_UNIT}.timer`), content: timer },
      { path: path.posix.join(dir, `${SYSTEMD_UNIT}.service`), content: service },
    ],
    install: [systemctl("daemon-reload"), systemctl("enable", "--now", `${SYSTEMD_UNIT}.timer`)],
    uninstall: [{ ...systemctl("disable", "--now", `${SYSTEMD_UNIT}.timer`), optional: true }],
    afterUninstall: [{ ...systemctl("daemon-reload"), optional: true }],
    where: path.posix.join(dir, `${SYSTEMD_UNIT}.timer`),
  };
}

function windowsPlan(o: ScheduleOptions): SchedulePlan {
  const run = `"${o.node}" "${o.cli}" ${jobArgs(o).join(" ")}`;
  return {
    files: [],
    install: [
      {
        file: "schtasks",
        args: [
          "/Create",
          "/F",
          "/SC",
          "DAILY",
          "/ST",
          `${pad(o.hour)}:${pad(o.minute)}`,
          "/TN",
          WINDOWS_TASK,
          "/TR",
          run,
        ],
      },
    ],
    uninstall: [{ file: "schtasks", args: ["/Delete", "/F", "/TN", WINDOWS_TASK] }],
    afterUninstall: [],
    query: { file: "schtasks", args: ["/Query", "/TN", WINDOWS_TASK] },
    where: `Task Scheduler task "${WINDOWS_TASK}"`,
  };
}
