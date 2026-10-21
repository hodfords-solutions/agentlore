import { describe, expect, it } from "vitest";
import { redact } from "../../src/core/redact.js";

// Fake secrets are assembled at runtime so no secret-like literal lives in the repo.
const fake = (prefix: string, n = 40) => prefix + "A1b2C3d4".repeat(Math.ceil(n / 8)).slice(0, n);
const hex = (n: number) => "0a1b2c3d4e5f6789".repeat(Math.ceil(n / 16)).slice(0, n);

describe("redact", () => {
  it.each([
    ["anthropic-key", fake("sk-ant-api03-")],
    ["openai-key", fake("sk-proj-")],
    ["github-token", fake("ghp_", 36)],
    ["aws-access-key", `AKIA${"ABCDEFGHIJKLMNOP"}`],
    ["slack-token", fake("xoxb-", 24)],
    ["stripe-key", fake("sk_" + "live_", 24)],
    ["stripe-key", fake("rk_" + "test_", 24)],
    ["stripe-webhook-secret", fake("whsec" + "_", 32)],
    ["npm-token", fake("npm" + "_", 36)],
    ["huggingface-token", fake("hf" + "_", 34)],
    ["gitlab-token", fake("glpat" + "-", 20)],
    ["sendgrid-key", `${fake("SG" + ".", 22)}.${fake("", 43)}`],
    ["twilio-key", `SK${hex(32)}`],
    ["digitalocean-token", `dop_v1_${hex(64)}`],
    ["doppler-token", fake("dp.pt" + ".", 43)],
    [
      "slack-webhook",
      `https://hooks.slack.com/services/${fake("T", 8)}/${fake("B", 8)}/${fake("", 24)}`,
    ],
  ])("redacts %s", (rule, secret) => {
    const out = redact(`use ${secret} now`);
    expect(out).toBe(`use [REDACTED:${rule}] now`);
  });

  it("redacts private key blocks", () => {
    const block = ["-----BEGIN RSA PRIVATE KEY-----", "abc", "-----END RSA PRIVATE KEY-----"].join(
      "\n",
    );
    expect(redact(`key:\n${block}\nend`)).toBe("key:\n[REDACTED:private-key]\nend");
  });

  it.each([
    ["OPENSSH", "OPENSSH PRIVATE KEY"],
    ["PKCS#8", "PRIVATE KEY"],
    ["encrypted", "ENCRYPTED PRIVATE KEY"],
    ["PGP", "PGP PRIVATE KEY BLOCK"],
  ])("redacts %s private key blocks", (_name, label) => {
    const block = [`-----BEGIN ${label}-----`, "b3BlbnNzaA==", `-----END ${label}-----`].join("\n");
    expect(redact(`a\n${block}\nb`)).toBe("a\n[REDACTED:private-key]\nb");
  });

  it("redacts an unterminated private key block to the end of the text", () => {
    const text = `see\n${"-----BEGIN"} RSA PRIVATE KEY-----\nMIIEow\nmore`;
    expect(redact(text)).toBe("see\n[REDACTED:private-key]");
  });

  it("keeps public keys and certificates", () => {
    const text = "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----";
    expect(redact(text)).toBe(text);
  });

  it("stays fast on ~1 MB of private key headers without an END line", () => {
    const text = `${"-----BEGIN"} RSA PRIVATE KEY-----\n`.repeat(30_000);
    const started = performance.now();
    expect(redact(text)).toBe("[REDACTED:private-key]");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("stays fast on ~1 MB of BEGIN lines that are not private keys", () => {
    const text = "-----BEGIN RSA PRIVATE ".repeat(45_000);
    const started = performance.now();
    expect(redact(text)).toBe(text);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("redacts values of secret-like assignments but keeps the name", () => {
    expect(redact('password = "hunter2hunter2"')).toBe('password = "[REDACTED:assignment]"');
  });

  it("does not double-redact", () => {
    expect(redact(`api_key=${fake("sk-ant-api03-")}`)).toBe("api_key=[REDACTED:anthropic-key]");
  });

  it.each([
    ["task-runner-configuration-file", "the task-runner-configuration-file is here"],
    ["risk-assessment-for-production", "see risk-assessment-for-production first"],
  ])("does not redact ordinary words containing a provider prefix (%s)", (_name, text) => {
    expect(redact(text)).toBe(text);
  });

  it.each([
    ["DATABASE_PASSWORD=hunter2hunter2", "DATABASE_PASSWORD=[REDACTED:assignment]"],
    [`client_secret=${fake("", 32)}`, "client_secret=[REDACTED:assignment]"],
    [`AWS_SECRET_ACCESS_KEY=${fake("wJal", 36)}`, "AWS_SECRET_ACCESS_KEY=[REDACTED:assignment]"],
    ['{"password": "hunter2hunter2"}', '{"password": "[REDACTED:assignment]"}'],
    [`"apiKey": "${fake("", 32)}"`, '"apiKey": "[REDACTED:assignment]"'],
  ])("redacts assignment form %s", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it.each(["AccountKey", "SharedAccessKey"])("redacts Azure %s values", (key) => {
    const conn = `DefaultEndpointsProtocol=https;AccountName=acme;${key}=${fake("", 40)}==;EndpointSuffix=core.windows.net`;
    expect(redact(conn)).toBe(
      `DefaultEndpointsProtocol=https;AccountName=acme;${key}=[REDACTED:azure-key];EndpointSuffix=core.windows.net`,
    );
  });

  // Left-boundary pins: a provider prefix glued to a preceding word character is not a key.
  it.each([
    ["anthropic-key", fake("sk-ant-api03-"), ["x", "_", "-", "9"]],
    ["openai-key", fake("sk-proj-"), ["x", "_", "-", "9"]],
    ["github-token", fake("ghp_", 36), ["my_", "x", "-", "9"]],
    ["github-pat", fake("github_pat_", 30), ["my_", "x", "-"]],
    ["aws-access-key", `AKIA${"ABCDEFGHIJKLMNOP"}`, ["x", "_", "9"]],
    ["slack-token", fake("xoxb-", 24), ["foo-", "x", "_", "9"]],
    ["google-api-key", fake("AIza", 35), ["x", "_", "-"]],
    ["stripe-key", fake("sk_" + "live_", 24), ["x", "_", "-"]],
    ["stripe-webhook-secret", fake("whsec" + "_", 32), ["x", "_", "-"]],
    ["npm-token", fake("npm" + "_", 36), ["x", "_", "-"]],
    ["huggingface-token", fake("hf" + "_", 34), ["my_", "x", "-"]],
    ["gitlab-token", fake("glpat" + "-", 20), ["x", "_", "-"]],
    ["sendgrid-key", `${fake("SG" + ".", 22)}.${fake("", 43)}`, ["x", "_", "-"]],
    ["twilio-key", `SK${hex(32)}`, ["x", "_", "9"]],
    ["digitalocean-token", `dop_v1_${hex(64)}`, ["x", "_", "-"]],
    ["doppler-token", fake("dp.pt" + ".", 43), ["x", "_", "-"]],
  ])("does not redact %s glued to a preceding word", (rule, secret, glues) => {
    expect(redact(`use ${secret} now`)).toBe(`use [REDACTED:${rule}] now`);
    for (const glue of glues) {
      const text = `use ${glue}${secret} now`;
      expect(redact(text), glue).toBe(text);
    }
  });

  it("does not redact a provider prefix inside a longer word", () => {
    const text = `prefix${fake("npm" + "_", 36)} and my_hf_${fake("", 34)}`;
    expect(redact(text)).toBe(text);
  });

  it.each([
    ["DB_PASS=", "Xk9#" + "mP2qL7", ""],
    ['API_KEY="', "a1b2c3d4" + "e5f6g7h8", '"'],
    ["pass: ", "Tr0ub4" + "dor&3", ""],
    ["passwd=", "Zq8" + "vN2xR", ""],
    ["auth_token=", fake("", 24), ""],
    ["PRIVATE_KEY=", fake("", 40), ""],
    ["private-key: ", fake("", 40), ""],
    ["accessKey = '", fake("", 20), "'"],
    ["client_secret=", fake("", 32), ""],
    ["SMTP_PASSWORD=", "k8Ls" + "Qp", ""],
    ['PASSWORD="', "multi " + "word phrase", '"'],
    ["export DB_PASSWORD='", "correct horse " + "battery staple", "'"],
    ["password: ", "correcthorse" + "batterystaple", ""],
  ])("redacts the value of `%s…`", (head, value, tail) => {
    expect(redact(`${head}${value}${tail}`)).toBe(`${head}[REDACTED:assignment]${tail}`);
  });

  it.each([
    "tokenizer = createTokenizer(options)",
    "const password = z.string().min(8)",
    "password: z.string(),",
    "MAX_TOKENS=4096000000",
    "max_tokens: 4096",
    "apiKey: process.env.OPENAI_API_KEY",
    "secret = config.secretValue;",
    "token: null",
    "auth = undefined",
    "passwordRequired: false",
    "const token = getToken",
    "accessKey = accessKeyFromEnv",
    "API_KEY=YOUR_API_KEY",
    "SECRET_KEY=$" + "{SECRET_KEY}",
    "password=********",
    '"author": "Jane Doe <jane@example.com>"',
    'token: "the token bucket"',
    "passenger_count = 12",
    "PWD=/Users/me/work/project-2",
    "OLDPWD=~/src/app_v2",
  ])("does not redact code-like or placeholder values: %s", (text) => {
    expect(redact(text)).toBe(text);
  });

  it.each([
    ["PASSWORD=", "hun" + "ter"],
    ["password: ", "letmein" + "please"],
    ["DB_PASSWORD=", "correctHorse" + "Battery"],
    ["password=", "Pa(ss)" + "w0rd!"],
    ["pass: ", "hun" + "ter2"],
    ["SMTP_PASS=", "12" + "3456"],
    ["dbPassword = ", "Spring" + "Time"],
    ["client_secret: ", "shortsec" + "ret"],
    ["PRIVATE_KEY=", "abc" + "defgh"],
    ["passphrase=", "open" + "sesame"],
  ])("redacts any real-looking value of a password-like name: %s…", (head, value) => {
    expect(redact(`${head}${value}`)).toBe(`${head}[REDACTED:assignment]`);
  });

  it.each([
    ["API_KEY=", "abcdef" + "abcdefabcdef"],
    ["auth_token=", "QWERTY" + "UIOPASDFGH"],
    ["Authorization: ", fake("", 32)],
    ["authorization=", fake("", 24)],
    ["aws_secret_key=", `${fake("wJal", 12)}.${fake("K7MD", 12)}`],
    ["access_key=", `${fake("", 12)}.${fake("", 12)}`],
  ])("redacts key-like values: %s…", (head, value) => {
    expect(redact(`${head}${value}`)).toBe(`${head}[REDACTED:assignment]`);
  });

  it.each([
    "PASSWORD=<your-password>",
    "password: $" + "{DB_PASSWORD}",
    "password=$DB_PASSWORD",
    "PASSWORD=***",
    "password=xxxx",
    "PASSWORD=changeme",
    "password = os.environ['DB_PASSWORD']",
    'password = os.environ["DB_PASSWORD"]',
    "password: process.env.DB_PASSWORD,",
    "password: z.string().min(8),",
    "passwordRequired: false",
    "passenger_count = 12345678",
    "passthrough: enabled",
    "API_KEY=xxxxxxxxxxxxxxxxxxxx",
    "author: JaneDoeTheWriter",
    "AUTHOR_NAME=JaneDoeTheWriter",
    "Authorization: required",
  ])("keeps placeholders and code references: %s", (text) => {
    expect(redact(text)).toBe(text);
  });

  it.each([
    ["sshpass -p ", " ssh deploy@host"],
    ["sshpass -p", " scp a b"],
  ])("redacts sshpass passwords in `%s…`", (head, tail) => {
    const secret = "s3cr" + "etPa55";
    expect(redact(`${head}${secret}${tail}`)).toBe(`${head}[REDACTED:cli-password]${tail}`);
  });

  it.each([
    ["postgres://app:", "p@ss/w" + "0rd", "@db:5432/app"],
    ["redis://:", "a@b@" + "c", "@cache"],
  ])("redacts URI passwords with @ or / up to the last @ (%s)", (head, password, tail) => {
    expect(redact(`${head}${password}${tail}`)).toBe(`${head}[REDACTED:uri-password]${tail}`);
  });

  it("does not take a port and path before an @ in the path for a password", () => {
    const text = "see https://registry.example.com:443/@scope/pkg and mailto bob@example.com";
    expect(redact(text)).toBe(text);
  });

  it("stays fast on ~1 MB of assignment-like text", () => {
    for (const text of [
      "password=".repeat(110_000),
      'token: "'.repeat(125_000),
      "a_token ".repeat(125_000),
    ]) {
      const started = performance.now();
      redact(text);
      expect(performance.now() - started).toBeLessThan(2000);
    }
  });

  it("redacts bearer tokens but keeps the scheme", () => {
    expect(redact(`Authorization: Bearer ${fake("", 32)}`)).toBe(
      "Authorization: Bearer [REDACTED:bearer]",
    );
  });

  const pw = () => "s3cr" + "etPa55";

  it.each([
    ["postgres://app:", "@db.internal:5432/app"],
    ["postgresql://app:", "@db/app?sslmode=require"],
    ["mysql://root:", "@127.0.0.1:3306/shop"],
    ["mongodb://admin:", "@mongo:27017"],
    ["mongodb+srv://admin:", "@cluster0.example.net/test"],
    ["redis://:", "@cache:6379/0"],
    ["redis://default:", "@cache:6379"],
    ["amqp://guest:", "@rabbit:5672/vhost"],
    ["https://deploy:", "@git.example.com/org/repo.git"],
  ])("redacts the password of %s… URIs but keeps scheme, user and host", (head, tail) => {
    expect(redact(`url ${head}${pw()}${tail} end`)).toBe(
      `url ${head}[REDACTED:uri-password]${tail} end`,
    );
  });

  it("does not touch URIs without a password", () => {
    const text = "see https://example.com:8443/path and ssh://git@github.com/org/repo";
    expect(redact(text)).toBe(text);
  });

  it("redacts a token used as a URI password once", () => {
    const token = fake("ghp" + "_", 36);
    expect(redact(`https://x-access-token:${token}@github.com/o/r`)).toBe(
      "https://x-access-token:[REDACTED:github-token]@github.com/o/r",
    );
  });

  it.each(["Authorization: Basic ", "authorization: basic "])(
    "redacts %s credentials but keeps the scheme",
    (prefix) => {
      const b64 = Buffer.from(`admin:${pw()}`).toString("base64");
      expect(redact(`${prefix}${b64}`)).toBe(`${prefix}[REDACTED:basic-auth]`);
    },
  );

  it("does not redact the word Basic in prose", () => {
    const text = "Basic configuration is described in the Basic Authentication section";
    expect(redact(text)).toBe(text);
  });

  it.each([
    ["mysql -u root -p", "", " shop"],
    ["mysqldump -h db -uroot -p", "", " shop > dump.sql"],
    ["pg_restore --password=", "", " dump"],
    ["psql --password ", "", " -h db"],
    ["docker login -u bot -p ", "", " registry.example.com"],
    ["docker login --password ", "", " ghcr.io"],
  ])("redacts command-line passwords in `%s…`", (head, _x, tail) => {
    expect(redact(`${head}${pw()}${tail}`)).toBe(`${head}[REDACTED:cli-password]${tail}`);
  });

  it.each([
    ["curl -u admin:", " https://api.example.com"],
    ["curl -uadmin:", " https://api.example.com"],
    ["curl --user deploy:", " https://api.example.com"],
    ["curl --user=deploy:", " https://api.example.com"],
    ["curl -s -X POST -u 'admin:", "' https://api.example.com"],
    ["redis-cli -a ", " ping"],
    ["redis-cli -h cache -p 6379 -a ", " --no-auth-warning ping"],
    ["redis-cli --pass ", " ping"],
  ])("redacts command-line passwords in `%s…`", (head, tail) => {
    expect(redact(`${head}${pw()}${tail}`)).toBe(`${head}[REDACTED:cli-password]${tail}`);
  });

  it.each([
    "curl -u user:$" + "PASSWORD https://api.example.com",
    'curl -u "user:$' + '{PASSWORD}" https://api.example.com',
    "curl -u admin https://api.example.com",
    "curl --user-agent foo:bar https://api.example.com",
    "redis-cli -a",
    "redis-cli -a $" + "REDIS_PASSWORD ping",
    "redis-cli -a --no-auth-warning ping",
    "git commit -a -u x:y",
  ])("does not redact curl -u or redis-cli -a without a literal password: %s", (text) => {
    expect(redact(text)).toBe(text);
  });

  it.each([
    ["Authorization: token ", ""],
    ['-H "Authorization: token ', '"'],
    ['Authorization: "token ', '"'],
    ['"Authorization": "Token ', '"'],
  ])("redacts `%s…` tokens but keeps the scheme", (head, tail) => {
    expect(redact(`${head}${hex(40)}${tail}`)).toBe(`${head}[REDACTED:auth-token]${tail}`);
  });

  it.each([
    "Authorization: token required",
    "Authorization: token-based auth is described below",
    "send the token instead of a password",
  ])("does not redact the word token in prose: %s", (text) => {
    expect(redact(text)).toBe(text);
  });

  it.each([
    ["password=", "/hunter2" + "abc"],
    ["DB_PASSWORD=", "/s3cr" + "et"],
  ])("redacts a password value starting with a slash: %s…", (head, value) => {
    expect(redact(`${head}${value}`)).toBe(`${head}[REDACTED:assignment]`);
  });

  it("redacts a high-entropy value without digits for a token-like name", () => {
    const value = "Xk#mP!qL" + "@vNz&wR";
    expect(redact(`auth_token=${value}`)).toBe("auth_token=[REDACTED:assignment]");
  });

  it("keeps a low-entropy value without digits for a token-like name", () => {
    const text = `auth_token=${"aB-".repeat(5)}`;
    expect(redact(text)).toBe(text);
  });

  it("does not redact other -p flags or environment references", () => {
    const text = 'docker run -p 8080:80 app && mysql -P 3306 && psql --password "$PGPASS"';
    expect(redact(text)).toBe(text);
  });

  it.each([
    ["URI-like text", "a://b:".repeat(200_000)],
    ["URI-like text with @", "a://b:@c".repeat(130_000)],
    ["URI passwords without a host", `a://b:${"@".repeat(300)}x`.repeat(3_000)],
    ["sshpass commands", "sshpass ".repeat(125_000)],
    ["Basic headers", "Basic ".repeat(200_000)],
    ["mysql commands", "mysql -u x ".repeat(100_000)],
    ["curl commands", "curl -u x".repeat(110_000)],
    ["curl users", "curl -u x:".repeat(100_000)],
    ["redis-cli commands", "redis-cli -a ".repeat(80_000)],
    ["Authorization headers", "Authorization: token ".repeat(50_000)],
    ["password flags", "--password ".repeat(100_000)],
  ])("stays fast on ~1 MB of %s", (_name, text) => {
    const started = performance.now();
    redact(text);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("stays fast on long identifier-like text (no catastrophic backtracking)", () => {
    const text = "token_".repeat(2000);
    const started = performance.now();
    expect(redact(text)).toBe(text);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it.each([
    "The SQL login `appuser / Wint£r2024!` works on the reporting server.",
    "Credentials: `appuser:Wint£r2024!` (read-only).",
    "Use the account `svc-report / Wint£r2024!` for the job.",
    "SQL login `appuser/Wint£r2024!` still works.",
    "Switch to SQL Server Authentication with `appuser/Wint£r2024!` and retry.",
  ])("redacts a user/password pair written in prose: %s", (text) => {
    const out = redact(text);
    expect(out).not.toContain("Wint£r2024!");
    expect(out).toMatch(/`(?:appuser|svc-report) ?[/:] ?\[REDACTED:login-pair\]`/);
  });

  it.each([
    "chạy cái này: 203.0.113.7 root/ Xq7vLm2pRt9KwZ",
    "server 203.0.113.7 root/Xq7vLm2pRt9KwZ then run the playbook",
    "203.0.113.7:2222 deploy:Xq7vLm2p#Rt9",
    "ssh vào 203.0.113.7, user admin / Xq7vLm2pRt9KwZ",
    "chạy cái này: 203.0.113.7\nroot/ Xq7vLm2pRt9KwZ",
  ])("redacts a user/password pair after an IP address: %s", (text) => {
    const out = redact(text);
    expect(out).not.toMatch(/Xq7vLm2p/);
    expect(out).toContain("[REDACTED:host-login]");
    expect(out).toContain("203.0.113.7");
  });

  it("does not take an IP address quoted after a password word for the password", () => {
    const text = "Đổi mật khẩu root của server `203.0.113.7`, rồi đăng nhập lại 203.0.113.7.";
    expect(redact(text)).toBe(text);
  });

  it("keeps paths, versions and words after an IP address", () => {
    for (const text of [
      "GET 203.0.113.7 api/v1/users returned 500",
      "203.0.113.7 nginx/1.25.3 is the proxy",
      "203.0.113.7 docs/2024-plan.md",
      "203.0.113.7 root/ is the home of the admin",
      "203.0.113.7 port:8080",
    ]) {
      expect(redact(text)).toBe(text);
    }
  });

  it.each([
    "The password (`Wint£r2024!`) has a £ in it.",
    "Mật khẩu `Wint£r2024!` trong ảnh giờ nằm trong chat.",
    "PASSWORD: `hunter22`",
  ])("redacts a value quoted right after a word for password: %s", (text) => {
    expect(redact(text)).toMatch(/`\[REDACTED:password-mention\]`/);
  });

  it("keeps identifiers and placeholders quoted after a word for password", () => {
    for (const text of [
      "The password field `passwordHash` is hashed.",
      "Set the password `<your-password>` in the vault.",
      "Rotate the password `$DB_PASSWORD` monthly.",
      "Set the password `&lt;db-password&gt;` in the vault.",
      "The password `DATABASE_PASSWORD` comes from the vault.",
      "Store the password in the secret `sql-admin-password`.",
    ]) {
      expect(redact(text)).toBe(text);
    }
  });

  it("leaves logins without a password, file paths and host:port pairs alone", () => {
    for (const text of [
      "The login `appuser` is enough to read.",
      "See login `src/auth/login.ts` for the flow.",
      "Login `db-host:5432` first.",
      "Login page `/account/login` redirects.",
      "Login | `http://localhost:3000/admin` |",
      "No account needed: use the image `voicevox/voicevox_engine:cpu-latest` instead.",
      "Federated credential needs the subject `{repo-uuid}:branch:main`.",
      "The yield deletes the account's `crm:12345` xref and `erp:MC01228`.",
    ]) {
      expect(redact(text)).toBe(text);
    }
  });

  it("redacts every later mention of a secret it found in the same text", () => {
    const text = "Login `appuser / Wint£r2024!` works.\nType `Wint£r2024!` carefully, it has a £.";
    const out = redact(text);
    expect(out).not.toContain("Wint£r2024!");
    expect(out).toContain("[REDACTED:repeated-secret]");
    // Identifier-like values a rule took for secrets are not removed from code elsewhere.
    const code = "tokenBlacklist: ITokenBlacklist\npublic interface ITokenBlacklist {}";
    expect(redact(code)).toContain("public interface ITokenBlacklist");
    // Short or common values are not hunted down elsewhere.
    expect(redact("PASSWORD=abcdef then abcdef again")).toBe(
      "PASSWORD=[REDACTED:assignment] then abcdef again",
    );
  });

  it("leaves normal text untouched", () => {
    const text = "The token bucket refills every second; see tokenizer.ts";
    expect(redact(text)).toBe(text);
  });
});
