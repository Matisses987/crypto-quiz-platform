// Test entry point.
// `node --test tests/` is the frozen verification command; on Node builds that
// resolve a positional argument as a file (instead of searching the directory) the
// directory resolves to this module, which pulls in every *.test.mjs suite.
import "./judge.test.mjs";
import "./records.test.mjs";
import "./mastery.test.mjs";
import "./time.test.mjs";
import "./wrongbook.test.mjs";
import "./draw.test.mjs";
import "./mock.test.mjs";
import "./mock.countdown.test.mjs";
import "./overrides.test.mjs";
import "./ioport.test.mjs";
import "./bank.test.mjs";
import "./storage.test.mjs";
import "./storage.blocked.test.mjs";
import "./build.test.mjs";
import "./version.test.mjs";
import "./source.lint.test.mjs";
import "./ui.smoke.test.mjs";
