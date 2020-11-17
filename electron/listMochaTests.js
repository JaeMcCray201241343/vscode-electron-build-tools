const Module = require("module");
const net = require("net");
const path = require("path");
const readline = require("readline");

// We need the typescript module but it would be 60 MB to bundle it with the
// extension, which doesn't seem like the right thing to do. It's already in
// the Electron source tree, so give access to it by adding to the global path
// This also gives access to Mocha, rather than including it in the extension
Module.globalPaths.push(path.resolve(process.cwd(), "node_modules"));

// Needed or some imports at the start of test files will fail
Module.globalPaths.push(path.resolve(process.cwd(), "spec", "node_modules"));

// We want to terminate on errors, not show a dialog
process.once("uncaughtException", (err) => {
  process.exit(1);
});

const { app } = require("electron");

function parseTestSuites(suite) {
  const parsedTests = {
    title: suite.title,
    fullTitle: suite.fullTitle(),
    file: suite.file,
    suites: [],
    tests: suite.tests.map((test) => ({
      title: test.title,
      fullTitle: test.fullTitle(),
    })),
  };

  for (const childSuite of suite.suites) {
    parsedTests.suites.push(parseTestSuites(childSuite));
  }

  return parsedTests;
}

// These are required or there will be a reference error
// while Mocha is processing the tests
global.standardScheme = "app";
global.zoomScheme = "zoom";
global.window = {};

app
  .whenReady()
  .then(async () => {
    // This lets Mocha compile the TypeScript tests on the fly
    require("ts-node/register");

    // Don't load Mocha until after setting up ts-node
    const Mocha = require("mocha");

    const mocha = new Mocha();

    // Use a socket to pass filenames rather than command line
    // arguments since there's a max length on Windows which
    // is annoyingly short, which we'd quickly bump into. Why
    // not just stdin? Because on Windows that also doesn't work,
    // due to Electron being a GUI app, which is why REPL no work
    const socket = net.createConnection(process.argv.slice(-1)[0], () => {
      const rl = readline.createInterface({
        input: socket,
      });

      rl.on("line", async (line) => {
        if (line !== "DONE") {
          mocha.addFile(line);
        } else {
          try {
            await mocha.loadFiles();
            socket.write(
              JSON.stringify(parseTestSuites(mocha.suite), undefined, 4)
            );
            process.exit(0);
          } catch (err) {
            process.stderr.write(err.toString());
            process.exit(1);
          }
        }
      });

      rl.once("close", () => {
        process.exit(1);
      });
    });
  })
  .catch(() => {
    process.exit(1);
  });
