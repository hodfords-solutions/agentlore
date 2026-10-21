import type { LanguagePack } from "./types.js";

export const english: LanguagePack = {
  code: "en",
  stopwords: `
    a about again also an and any are as at be been before but by can could decision did do does
    earlier for from had has have how if in into is it its last me my no not of on or our please
    previously should so than that the their them then there these they this those to too us was
    we were what when where which who why will with would you your
    ok okay wow yeah yes hmm really honest honestly`,
  taskWords: `
    again before earlier help last past previous recall remember time decide decided
    add added adding build builds change changes check clean cleaner code create debug deploy
    explain explaining file files fix fixed fixing function functions implement improve make
    means need refactor remove run show test tests update use want work write
    app bug bugs error errors issue issues lint logs method project repo readme section
    button page component view layout style padding margin responsive mobile screen server
    client config configuration settings option options dependency dependencies package
    version variable value type class step steps case cases edge keep keeps fail fails failing
    pass passes works working broken wrong slow fast better simple new old sure
    array list item items object string number loop sort return top rename module format
    formatter prettier eslint callback async await promise interface comment comments docstring
    typecheck typescript unit parse parser flaky locally pagination endpoint route performance
    optimize migration plan schema database query logging log service pull request review
    security readable clarity
    answer answers sentence sentences context only based don dont tool tools
    feedback send resend opinion enough`,
  passwordWords: ["password", "passwd", "pwd", "passphrase"],
  loginWords: [
    "login",
    "logins",
    "credentials",
    "credential",
    "creds",
    "account",
    "accounts",
    "sign in",
    "sign-in",
    "authentication",
  ],
  decisionWords: [
    "decide",
    "decided",
    "decision",
    "go with",
    "going with",
    "settled on",
    "agreed",
    "chose",
    "we'll use",
    "let's use",
    "let's go with",
    "go ahead with",
    "approved",
    "final decision",
  ],
  correctionWords: [
    "wrong",
    "incorrect",
    "not true",
    "not correct",
    "mistake",
    "mistaken",
    "correction",
    "actually",
    "i meant",
    "that's not right",
    "that is not right",
  ],
};
