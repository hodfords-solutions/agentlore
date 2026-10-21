import { LOGIN_WORDS, PASSWORD_WORDS as PASSWORD_PHRASES } from "./languages/index.js";

/** Bump when the rules change: an index with another version is rebuilt on open. */
export const REDACTION_VERSION = 6;

type Replacer = (match: string, ...groups: (string | undefined)[]) => string;
type Rule = { name: string; pattern: RegExp; keepGroup1?: boolean; replace?: Replacer };

/** A symbol people put in passwords; not "-", "_", ".", "/" or ":", which names and paths use. */
const PASSWORD_SYMBOL = "[!@#$%^&*£€+=?~]";

/**
 * A value quoted in prose that is a password rather than a name, path or URL: it has a digit or
 * a password symbol, and is not a record id, placeholder, code or an identifier.
 */
function isQuotedPassword(value: string): boolean {
  return (
    new RegExp(`\\d|${PASSWORD_SYMBOL}`).test(value) &&
    // Record ids and codes (12345, MC01228) are data people search for, not passwords.
    !/^(?:\d+|[A-Z]+\d+)$/.test(value) &&
    !value.startsWith("/") &&
    // An IP address or host:port next to a password word is where it is used, not the password.
    !/^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?$/.test(value) &&
    !/^[a-z][\w+.-]*:\/\//i.test(value) &&
    isSecretValue("password", value, 4) &&
    !NOT_KEY.some((pattern) => pattern.test(value))
  );
}

/** Whole words or phrases of `list`, as a regex alternation (not inside a longer word). */
const keywords = (list: readonly string[]) =>
  `(?<![\\p{L}\\p{N}_])(?:${list.map((w) => w.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&").replace(/ /g, "[ \\t]+")).join("|")})(?![\\p{L}\\p{N}_])`;

/** Placeholders, references and literals that are never secrets, whatever the name. */
const PLACEHOLDER = [
  /^\$\{?\w+\}?$|^%\w+%$|^<[^>]*>$|^&lt;.*&gt;$|^\{\{.*\}\}$/, // $VAR, ${VAR}, %VAR%, <your-key> (also HTML-escaped), {{ var }}
  /^(.)\1*$/, // ******** or xxxxxxxx
  /^(?:changeme|change[_-]?me|placeholder|example|redacted|secret|password)$/i,
  /^(?:true|false|null|nil|none|undefined)$/i,
  // File paths such as PWD=/Users/me/project; "/hunter2" (one absolute segment) may be a password.
  /^(?:[~.]{1,2}\/[\w./-]*|(?:\/[\w.-]+){2,}\/?)$/,
];

/** Code that reads a value from elsewhere: os.environ["X"], getenv("X"), z.string().min(8). */
const CODE_REFERENCE = [
  /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\[\s*["']?[\w.-]+["']?\s*\]$/,
  /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\([^()]*\)(?:\.[A-Za-z_$][\w$]*(?:\([^()]*\))?)*$/,
];

const randomish = (segment: string) =>
  segment.length >= 12 && /[A-Z]/.test(segment) && /[a-z]/.test(segment) && /\d/.test(segment);

/** process.env.X, config.foo: dotted identifiers, none random-looking. */
function isMemberAccess(value: string): boolean {
  return (
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value) && !value.split(".").some(randomish)
  );
}

/** Values of token/key/auth-style names that are code or configuration rather than secrets. */
const NOT_KEY = [
  /[()]/, // calls and expressions: createTokenizer(...)
  /^(?:yes|no)$/i,
  /^[+-]?\d+(?:\.\d+)?$/, // numbers
  /^[a-z]+(?:[A-Z][a-z]+)+$/, // camelCase identifiers without digits
  /^[A-Z]+(?:_[A-Z]+)+$/, // CONSTANT_NAMES such as YOUR_API_KEY
];

const words = (name: string) =>
  name
    .split(/[_\-\s]+|(?<=[a-z0-9])(?=[A-Z])/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);

const PASSWORD_WORDS = new Set(["pass", "passwd", "password", "pwd", "passphrase", "secret"]);

/** Names whose value is a secret whatever it looks like (not tokens or keys). */
function isPasswordName(name: string): boolean {
  const parts = words(name);
  return parts.some(
    (word, i) =>
      PASSWORD_WORDS.has(word) ||
      word.endsWith("password") ||
      word.endsWith("passwd") ||
      (word === "private" && parts[i + 1] === "key"),
  );
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const count = (text: string, char: string) => text.split(char).length - 1;

/** Strip trailing , ; } and unbalanced ")" or "]" that end the statement, not the value. */
function valueCore(bare: string): string {
  let value = bare.replace(/[,;}]+$/, "");
  for (;;) {
    const last = value.at(-1);
    const open = last === ")" ? "(" : last === "]" ? "[" : undefined;
    if (!open || !last || count(value, last) <= count(value, open)) return value;
    value = value.slice(0, -1).replace(/[,;}]+$/, "");
  }
}

/**
 * Password-like names: any 4+ char value that is not a placeholder or code reference. Token/key
 * names: also not code-like, and mixing letters and digits, a 16+ letter run or high entropy.
 */
function isSecretValue(name: string, value: string, min: number): boolean {
  if (value.includes("[REDACTED")) return false;
  if (PLACEHOLDER.some((pattern) => pattern.test(value))) return false;
  if (CODE_REFERENCE.some((pattern) => pattern.test(value)) || isMemberAccess(value)) {
    return false;
  }
  if (isPasswordName(name)) return value.length >= 4;
  if (value.length < min || /\s/.test(value)) return false;
  if (NOT_KEY.some((pattern) => pattern.test(value))) return false;
  if (/[A-Za-z]/.test(value) && /\d/.test(value)) return true;
  if (/^(?:[a-z]{16,}|[A-Z]{16,})$/.test(value)) return true;
  return value.length >= 12 && entropy(value) >= 3;
}

// Order matters: specific providers before generic patterns.
const RULES: Rule[] = [
  { name: "anthropic-key", pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-key", pattern: /(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: "github-token", pattern: /(?<![A-Za-z0-9_-])gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: "github-pat", pattern: /(?<![A-Za-z0-9_-])github_pat_[A-Za-z0-9_]{22,}/g },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "slack-token", pattern: /(?<![A-Za-z0-9_-])xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "google-api-key", pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}/g },
  { name: "stripe-key", pattern: /(?<![A-Za-z0-9_-])[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: "stripe-webhook-secret", pattern: /(?<![A-Za-z0-9_-])whsec_[A-Za-z0-9+/=]{24,}/g },
  { name: "npm-token", pattern: /(?<![A-Za-z0-9_-])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g },
  { name: "huggingface-token", pattern: /(?<![A-Za-z0-9_-])hf_[A-Za-z0-9]{30,}/g },
  { name: "gitlab-token", pattern: /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}/g },
  {
    name: "sendgrid-key",
    pattern: /(?<![A-Za-z0-9_-])SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
  },
  { name: "twilio-key", pattern: /\bSK[0-9a-f]{32}\b/g },
  { name: "digitalocean-token", pattern: /(?<![A-Za-z0-9_-])do[opr]_v1_[a-f0-9]{64}/g },
  {
    name: "doppler-token",
    pattern: /(?<![A-Za-z0-9_-])dp\.(?:pt|st|ct|sa|scim|audit)\.[A-Za-z0-9]{40,}/g,
  },
  {
    name: "slack-webhook",
    pattern: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]{20,}/g,
  },
  {
    name: "azure-key",
    pattern: /\b((?:AccountKey|SharedAccessKey)=)(?!\[REDACTED)[A-Za-z0-9+/]{20,}={0,2}/g,
    keepGroup1: true,
  },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    // scheme://user:PASSWORD@host. The password may contain "@" or "/"; ":443/path@x" is a
    // port. Bounded parts keep it linear.
    name: "uri-password",
    pattern:
      /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]{0,128}:)(?!\[REDACTED|\d+\/)[^\s]{1,256}(?=@[^\s@/]{1,253}(?:[/\s?#'"`)]|$))/gi,
    keepGroup1: true,
  },
  {
    // Base64 credentials contain a digit, "+", "/" or "=" padding; prose after "Basic" does not.
    name: "basic-auth",
    pattern: /\b(Basic\s+)(?!\[REDACTED)(?=[A-Za-z0-9+/]{0,512}[0-9+/=])[A-Za-z0-9+/]{8,}={0,2}/gi,
    keepGroup1: true,
  },
  {
    // mysql -pPASSWORD (no space; "-p" alone prompts, "-P" is the port).
    name: "cli-password",
    pattern:
      /(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n|;&]{0,200}?\s-p)(?!\[REDACTED)([^\s'"]+|'[^'\n]*'|"[^"\n]*")/g,
    keepGroup1: true,
  },
  {
    // sshpass -p X / sshpass -pX
    name: "cli-password",
    pattern:
      /(\bsshpass\b[^\n|;&]{0,100}?[ \t]-p[ \t]*)(?![-$]|\[REDACTED|["']\$)([^\s'"]+|'[^'\n]*'|"[^"\n]*")/g,
    keepGroup1: true,
  },
  {
    // --password=X, --password X, docker login -p X; not "$VAR" or a following flag.
    name: "cli-password",
    pattern:
      /((?:--pass(?:word|wd)?|\bdocker[ \t]+login\b[^\n|;&]{0,200}?[ \t]-p)(?:=|[ \t]+))(?![-$]|\[REDACTED|["']\$)([^\s'"]+|'[^'\n]*'|"[^"\n]*")/g,
    keepGroup1: true,
  },
  {
    // curl -u user:PASSWORD, --user user:PASSWORD; "-u user" alone prompts for it.
    name: "cli-password",
    pattern:
      /(\bcurl\b[^\n|;&]{0,200}?[ \t](?:-u[ \t]*|--user(?:=|[ \t]+))["']?[^\s:'"$]{1,128}:)(?!\$|\[REDACTED)([^\s'"]+)/g,
    keepGroup1: true,
  },
  {
    // redis-cli -a PASSWORD (--pass is covered above).
    name: "cli-password",
    pattern:
      /(\bredis-cli\b[^\n|;&]{0,200}?[ \t]-a[ \t]+)(?![-$]|\[REDACTED|["']\$)([^\s'"]+|'[^'\n]*'|"[^"\n]*")/g,
    keepGroup1: true,
  },
  {
    // A user/password pair after a login word: login `user / secret`, `user:secret`, or
    // `user/secret` (no spaces) when the secret has a symbol, so paths and images stay.
    name: "login-pair",
    pattern: new RegExp(
      `(${keywords([...LOGIN_WORDS, ...PASSWORD_PHRASES])}[^\\n\`]{0,40}\`[^\`\\s/:]{1,64}(?:[ \\t]+/[ \\t]+|:|/(?=[^\`\\s]*${PASSWORD_SYMBOL})))(?!\\[REDACTED)([^\`\\s]{6,128})(?=\`)`,
      "giu",
    ),
    replace: (match, prefix = "", value = "") =>
      isQuotedPassword(value) ? `${prefix}[REDACTED:login-pair]` : match,
  },
  {
    // A user/password pair right after an IPv4 address, on the same line or the next:
    // `203.0.113.7 root/ secret`,
    // `203.0.113.7:22 deploy:secret`, `203.0.113.7, user admin / secret`. Only IPs: after a
    // host name, "main.ts src/x2" would look the same.
    name: "host-login",
    pattern:
      /(\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:[ \t,]+|[ \t,]*\r?\n[ \t]*)(?:user(?:name)?[ \t:=]+)?[A-Za-z_][\w.-]{0,31}(?:[ \t]*\/[ \t]*|:))(?!\[REDACTED)([^\s`'"]{6,128})/g,
    replace: (match, prefix = "", value = "") =>
      // Not paths, file names (docs/plan-2024.md) or versions (nginx/1.25.3).
      isQuotedPassword(value) &&
      !/[/]/.test(value) &&
      !/\.[A-Za-z]{1,5}$/.test(value) &&
      !/^v?\d+(?:\.\d+)+$/.test(value)
        ? `${prefix}[REDACTED:host-login]`
        : match,
  },
  {
    // A quoted value right after a password word of any language pack: password (`secret`).
    name: "password-mention",
    pattern: new RegExp(
      `(${keywords(PASSWORD_PHRASES)}[^\\n\`]{0,20}\`)([^\`\\s]{4,128})(?=\`)`,
      "giu",
    ),
    replace: (match, prefix = "", value = "") =>
      isQuotedPassword(value) ? `${prefix}[REDACTED:password-mention]` : match,
  },
  {
    name: "bearer",
    pattern: /\b(Bearer\s+)(?!\[REDACTED)[A-Za-z0-9._~+/-]{16,}=*/gi,
    keepGroup1: true,
  },
  {
    // Authorization: token X (GitHub's scheme), also quoted as a JSON or header value.
    name: "auth-token",
    pattern:
      /(\bAuthorization["']?[ \t]*[:=][ \t]*["']?token[ \t]+)(?!\[REDACTED)[A-Za-z0-9._~+/-]{16,}=*/gi,
    keepGroup1: true,
  },
  {
    // Any identifier containing a secret-like word (DATABASE_PASSWORD=, "apiKey":). Consuming the
    // identifier atomically via (?=(...))\1 from an identifier boundary keeps matching linear
    // (no catastrophic backtracking); quoted values are bounded.
    name: "assignment",
    pattern:
      /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*?(?:api[_-]?key|secret|token|pass|pwd|auth(?!ors?(?![a-z]))|credential|private[_-]?key|access[_-]?key))(?=([A-Za-z0-9_-]+))\1(["']?[ \t]*[:=][ \t]*)(?:"([^"\n]{1,512})"|'([^'\n]{1,512})'|((?:[^\s"'[]|\[[^\]\n]{0,128}\])+))/gi,
    replace: (match, name = "", separator, doubleQuoted, singleQuoted, bare) => {
      if (doubleQuoted !== undefined || singleQuoted !== undefined) {
        const quote = doubleQuoted !== undefined ? '"' : "'";
        const value = doubleQuoted ?? singleQuoted ?? "";
        return isSecretValue(name, value, 6)
          ? `${name}${separator}${quote}[REDACTED:assignment]${quote}`
          : match;
      }
      const value = valueCore(bare ?? "");
      // Unquoted .env-style lines (NAME=value) are almost always configuration.
      const min = separator === "=" && /^[A-Z0-9_]+$/.test(name) ? 6 : 8;
      return isSecretValue(name, value, min)
        ? `${name}${separator}[REDACTED:assignment]${(bare ?? "").slice(value.length)}`
        : match;
    },
  },
];

// "RSA PRIVATE KEY", "PGP PRIVATE KEY BLOCK", ...: sticky and bounded, O(1) per position.
const PEM_LABEL = "(?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----";
const PEM_BEGIN = new RegExp(`-----BEGIN ${PEM_LABEL}`, "y");
const PEM_END = new RegExp(`-----END ${PEM_LABEL}`, "y");

const matchesAt = (pattern: RegExp, text: string, at: number): number | undefined => {
  pattern.lastIndex = at;
  return pattern.test(text) ? pattern.lastIndex : undefined;
};

/**
 * Redact PEM/PGP private key blocks; one without END is redacted to the end of the text. An
 * indexOf scan, since a single regex backtracks quadratically on many BEGINs without an END.
 */
function redactPrivateKeys(text: string): string {
  let out = "";
  let from = 0;
  let begin = text.indexOf("-----BEGIN ");
  while (begin !== -1) {
    const bodyStart = matchesAt(PEM_BEGIN, text, begin);
    if (bodyStart === undefined) {
      begin = text.indexOf("-----BEGIN ", begin + 1);
      continue;
    }
    let blockEnd = text.length;
    for (let end = text.indexOf("-----END ", bodyStart); end !== -1; ) {
      const after = matchesAt(PEM_END, text, end);
      if (after !== undefined) {
        blockEnd = after;
        break;
      }
      end = text.indexOf("-----END ", end + 1);
    }
    out += `${text.slice(from, begin)}[REDACTED:private-key]`;
    from = blockEnd;
    begin = blockEnd < text.length ? text.indexOf("-----BEGIN ", blockEnd) : -1;
  }
  return from === 0 ? text : out + text.slice(from);
}

/** Replace secrets with `[REDACTED:<rule>]`; applied before anything is written to the index. */
export function redact(text: string): string {
  let out = redactPrivateKeys(text);
  const found = new Set<string>();
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (match: string, group1: string, ...rest: unknown[]) => {
      const replaced = rule.replace
        ? rule.replace(match, group1, ...(rest as (string | undefined)[]))
        : rule.keepGroup1
          ? `${group1}[REDACTED:${rule.name}]`
          : `[REDACTED:${rule.name}]`;
      const secret = removedPart(match, replaced);
      if (secret.length >= MIN_REPEATED_SECRET) found.add(secret);
      return replaced;
    });
  }
  return found.size ? redactRepeats(out, found) : out;
}

/** Secrets at least this long are also redacted where the text mentions them again. */
const MIN_REPEATED_SECRET = 8;

/** The part of `match` that `replaced` no longer has: the secret a rule redacted. */
function removedPart(match: string, replaced: string): string {
  if (match === replaced) return "";
  let start = 0;
  while (start < match.length && match[start] === replaced[start]) start++;
  let end = 0;
  while (
    end < match.length - start &&
    match[match.length - 1 - end] === replaced[replaced.length - 1 - end]
  ) {
    end++;
  }
  return match.slice(start, match.length - end);
}

/** Other mentions of found secrets, e.g. a password quoted again later in the same message. */
function redactRepeats(text: string, secrets: Set<string>): string {
  let out = text;
  for (const secret of secrets) {
    // Only values that look like passwords or keys: an identifier a rule took for a secret
    // (a camelCase name, a kebab-case key name) must not be removed from code everywhere.
    if (secret.includes("[REDACTED") || !/\d|[^\w./:-]/.test(secret)) continue;
    out = out.split(secret).join("[REDACTED:repeated-secret]");
  }
  return out;
}
