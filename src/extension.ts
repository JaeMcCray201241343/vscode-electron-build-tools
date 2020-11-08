import * as vscode from "vscode";
import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";

import {
  ConfigTreeItem,
  ElectronBuildToolsConfigsProvider,
} from "./views/configs";
import {
  blankConfigEnumValue,
  buildTargets,
  buildToolsExecutable,
  virtualDocumentScheme,
} from "./constants";
import { DocsTreeDataProvider } from "./views/docs";
import { ElectronViewProvider } from "./views/electron";
import { ElectronPatchesProvider, PatchDirectory } from "./views/patches";
import { TextDocumentContentProvider } from "./documentContentProvider";
import { HelpTreeDataProvider } from "./views/help";
import {
  Test,
  TestBaseTreeItem,
  TestRunnerTreeItem,
  TestState,
  TestsTreeDataProvider,
} from "./views/tests";
import { runAsTask } from "./tasks";
import { ExtensionConfig } from "./types";
import {
  escapeStringForRegex,
  findCommitForPatch,
  getConfigDefaultTarget,
  getConfigs,
  getConfigsFilePath,
  getPatchesConfigFile,
  isBuildToolsInstalled,
} from "./utils";
import { TestCodeLensProvider } from "./testCodeLens";

async function electronIsInWorkspace(workspaceFolder: vscode.WorkspaceFolder) {
  const possiblePackageRoots = [".", "electron"];
  for (const possibleRoot of possiblePackageRoots) {
    const rootPackageFilename = vscode.Uri.joinPath(
      workspaceFolder.uri,
      possibleRoot,
      "package.json"
    );
    if (!fs.existsSync(rootPackageFilename.fsPath)) {
      continue;
    }

    const rootPackageFile = await vscode.workspace.fs.readFile(
      rootPackageFilename
    );

    const { name } = JSON.parse(rootPackageFile.toString()) as Record<
      string,
      string
    >;

    return name === "electron";
  }
}

function registerElectronBuildToolsCommands(
  context: vscode.ExtensionContext,
  configsProvider: ElectronBuildToolsConfigsProvider,
  patchesProvider: ElectronPatchesProvider,
  testsProvider: TestsTreeDataProvider
) {
  context.subscriptions.push(
    vscode.commands.registerCommand("electron-build-tools.build", async () => {
      const operationName = "Electron Build Tools - Building";

      const buildConfig = vscode.workspace.getConfiguration(
        "electronBuildTools.build"
      );
      const options = Object.entries(
        buildConfig.get("buildOptions") as ExtensionConfig.BuildOptions
      ).reduce((opts, [key, value]) => {
        opts.push(`${key} ${value}`.trim());
        return opts;
      }, [] as string[]);
      const ninjaArgs = Object.entries(
        buildConfig.get("ninjaArgs") as ExtensionConfig.NinjaArgs
      ).reduce((opts, [key, value]) => {
        opts.push(`${key} ${value}`.trim());
        return opts;
      }, [] as string[]);

      let settingsDefaultTarget: string | undefined = buildConfig.get(
        "defaultTarget"
      );
      settingsDefaultTarget =
        settingsDefaultTarget === blankConfigEnumValue
          ? ""
          : settingsDefaultTarget;
      let target = settingsDefaultTarget;

      let quickPick: vscode.QuickPick<vscode.QuickPickItem> | undefined;

      if (buildConfig.get("showTargets")) {
        // Settings default target takes precedence
        const defaultTarget = settingsDefaultTarget ?? getConfigDefaultTarget();
        const quickPickItems: vscode.QuickPickItem[] = [];

        if (defaultTarget) {
          quickPickItems.push({
            label: defaultTarget,
            description: `Default from ${
              settingsDefaultTarget ? "Settings" : "Config"
            }`,
          });
        } else {
          quickPickItems.push({
            label: "electron",
            description: "Default",
          });
        }

        for (const buildTarget of buildTargets) {
          if (buildTarget !== quickPickItems[0].label) {
            quickPickItems.push({
              label: buildTarget,
            });
          }
        }

        quickPick = vscode.window.createQuickPick();
        quickPick.items = quickPickItems;
        quickPick.placeholder = "Target To Build";
      }

      if (quickPick) {
        const userQuit = await new Promise((resolve) => {
          quickPick!.onDidAccept(() => {
            target = quickPick!.selectedItems[0].label ?? target;
            quickPick!.hide();
            resolve();
          });
          quickPick!.onDidHide(() => {
            resolve(true);
          });
          quickPick!.show();
        });

        if (userQuit) {
          return;
        }
      }

      const command = [
        buildToolsExecutable,
        "build",
        ...options,
        target,
        ...ninjaArgs,
      ]
        .join(" ")
        .trim();

      const buildEnv = {
        ...process.env,
        FORCE_COLOR: "true",
        NINJA_STATUS: "%p %f/%t ",
      };

      let lastBuildProgress = 0;

      const task = runAsTask(
        context,
        operationName,
        "build",
        command,
        {
          env: buildEnv,
        },
        "$electron"
      );

      task.onDidWriteLine(({ progress, line }) => {
        if (/Regenerating ninja files/.test(line)) {
          progress.report({
            message: "Regenerating Ninja Files",
            increment: 0,
          });
        } else {
          const buildProgress = parseInt(line.split("%")[0].trim());

          if (!isNaN(buildProgress)) {
            if (buildProgress > lastBuildProgress) {
              progress.report({
                message: "Compiling",
                increment: buildProgress - lastBuildProgress,
              });
              lastBuildProgress = buildProgress;
            }
          } else {
            if (/Running.*goma/.test(line)) {
              progress.report({ message: "Starting Goma" });
            } else if (/Running.*ninja/.test(line)) {
              progress.report({ message: "Starting Ninja" });
            }
          }
        }
      });
    }),
    vscode.commands.registerCommand(
      "electron-build-tools.refreshPatches",
      (arg: PatchDirectory | string) => {
        // TODO - Need to prevent user from continually mashing the button
        // and having this run multiple times simultaneously
        const target = arg instanceof PatchDirectory ? arg.name : arg;

        return new Promise((resolve, reject) => {
          const cp = childProcess.exec(
            `${buildToolsExecutable} patches ${target || "all"}`
          );

          cp.on("error", (err) => reject(err));
          cp.on("exit", (code) => {
            if (code !== 0) {
              vscode.window.showErrorMessage("Failed to refresh patches");
            } else {
              // TBD - This isn't very noticeable
              vscode.window.setStatusBarMessage("Refreshed patches");
              patchesProvider.refresh();
              resolve();
            }
          });
        });
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.remove-config",
      (config: ConfigTreeItem) => {
        childProcess.exec(
          `${buildToolsExecutable} remove ${config.label}`,
          {
            encoding: "utf8",
          },
          (error, stdout, stderr) => {
            if (error ?? stdout.trim() !== `Removed config ${config.label}`) {
              vscode.window.showErrorMessage(
                `Failed to remove config: ${stderr.trim()}`
              );
            } else {
              // TBD - This isn't very noticeable
              vscode.window.setStatusBarMessage("Removed config");
              configsProvider.refresh();
            }
          }
        );
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.runTest",
      async (test: TestBaseTreeItem | Test) => {
        const operationName = "Electron Build Tools - Running Test";
        let command = `${buildToolsExecutable} test`;

        // TODO - Need to sanity check output to make sure tests ran
        // and there wasn't a regex problem causing 0 tests to be run

        // TODO - Fix this up
        if (test instanceof TestBaseTreeItem) {
          const testRegex = escapeStringForRegex(
            test.getFullyQualifiedTestName()
          );

          runAsTask(
            context,
            operationName,
            "test",
            `${command} --runners=${test.runner.toString()} -g "${testRegex}"`,
            {},
            "$mocha",
            (exitCode) => {
              test.setState(
                exitCode === 0 ? TestState.SUCCESS : TestState.FAILURE
              );
              testsProvider.refresh(test);

              return false;
            }
          );

          test.setState(TestState.RUNNING);
          testsProvider.refresh(test);
        } else {
          const testRegex = escapeStringForRegex(test.test);

          runAsTask(
            context,
            operationName,
            "test",
            `${command} --runners=${test.runner.toString()} -g "${testRegex}"`,
            {},
            "$mocha"
          );
        }
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.runTestRunner",
      async (testRunner: TestRunnerTreeItem) => {
        const operationName = "Electron Build Tools - Running Tests";
        let command = `${buildToolsExecutable} test`;

        // TODO - Fix this up
        runAsTask(
          context,
          operationName,
          "test",
          `${command} --runner=${testRunner.runner.toString()}"`,
          {},
          "$mocha"
        );
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.runTestSuite",
      async (testSuite: TestBaseTreeItem) => {
        const operationName = "Electron Build Tools - Running Tests";
        let command = `${buildToolsExecutable} test`;

        const testRegex = escapeStringForRegex(
          testSuite.getFullyQualifiedTestName()
        );

        // TODO - Fix this up
        runAsTask(
          context,
          operationName,
          "test",
          `${command} --runners=${testSuite.runner.toString()} -g "${testRegex}"`,
          {},
          "$mocha",
          (exitCode) => {
            testSuite.setState(
              exitCode === 0 ? TestState.SUCCESS : TestState.FAILURE
            );
            testsProvider.refresh(testSuite);

            return false;
          }
        );

        testSuite.setState(TestState.RUNNING);
        testsProvider.refresh(testSuite);
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.showCommitDiff",
      async (
        checkoutDirectory: vscode.Uri,
        patch: vscode.Uri,
        filename: vscode.Uri,
        patchedFilename: string
      ) => {
        const commitSha = await findCommitForPatch(checkoutDirectory, patch);

        if (commitSha) {
          const originalFile = filename.with({
            scheme: virtualDocumentScheme,
            query: `view=contents&gitObject=${commitSha}~1&checkoutPath=${checkoutDirectory.fsPath}`,
          });
          const patchedFile = filename.with({
            scheme: virtualDocumentScheme,
            query: `view=contents&gitObject=${commitSha}&checkoutPath=${checkoutDirectory.fsPath}`,
          });

          vscode.commands.executeCommand(
            "vscode.diff",
            originalFile,
            patchedFile,
            `${path.basename(patch.path)} - ${patchedFilename}`
          );
        } else {
          vscode.window.showErrorMessage("Couldn't open commit diff for file");
        }
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.showPatchesDocs",
      () => {
        vscode.commands.executeCommand(
          "markdown.showPreview",
          vscode.Uri.joinPath(
            vscode.workspace.workspaceFolders![0].uri,
            "docs",
            "development",
            "patches.md"
          )
        );
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.showTestsDocs",
      () => {
        vscode.commands.executeCommand(
          "markdown.showPreview",
          vscode.Uri.joinPath(
            vscode.workspace.workspaceFolders![0].uri,
            "docs",
            "development",
            "testing.md"
          )
        );
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.showPatchOverview",
      (patch: vscode.Uri) => {
        return vscode.commands.executeCommand(
          "markdown.showPreview",
          patch.with({
            scheme: virtualDocumentScheme,
            query: "view=patch-overview",
          })
        );
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.sanitize-config",
      (config: ConfigTreeItem) => {
        childProcess.exec(
          `${buildToolsExecutable} sanitize-config ${config.label}`,
          {
            encoding: "utf8",
          },
          (error, stdout, stderr) => {
            if (
              error ||
              stdout.trim() !== `SUCCESS Sanitized contents of ${config.label}`
            ) {
              vscode.window.showErrorMessage(
                `Failed to sanitize config: ${stderr.trim()}`
              );
            } else {
              // TBD - This isn't very noticeable
              vscode.window.setStatusBarMessage("Sanitized config");
            }
          }
        );
      }
    ),
    vscode.commands.registerCommand("electron-build-tools.show.exe", () => {
      return childProcess
        .execSync(`${buildToolsExecutable} show exe`, { encoding: "utf8" })
        .trim();
    }),
    vscode.commands.registerCommand("electron-build-tools.show.goma", () => {
      childProcess.execSync(`${buildToolsExecutable} show goma`);
    }),
    vscode.commands.registerCommand("electron-build-tools.show.outdir", () => {
      return childProcess
        .execSync(`${buildToolsExecutable} show outdir`, { encoding: "utf8" })
        .trim();
    }),
    vscode.commands.registerCommand("electron-build-tools.show.root", () => {
      return childProcess
        .execSync(`${buildToolsExecutable} show root`, { encoding: "utf8" })
        .trim();
    }),
    vscode.commands.registerCommand("electron-build-tools.show.src", () => {
      return childProcess
        .execSync(`${buildToolsExecutable} show src`, { encoding: "utf8" })
        .trim();
    }),
    vscode.commands.registerCommand(
      "electron-build-tools.sync",
      (force?: boolean) => {
        const command = `${buildToolsExecutable} sync${
          force ? " --force" : ""
        }`;
        const operationName = `Electron Build Tools - ${
          force ? "Force " : ""
        }Syncing`;

        const syncEnv = {
          ...process.env,
          FORCE_COLOR: "true",
        };

        let initialProgress = false;

        const task = runAsTask(
          context,
          operationName,
          "sync",
          command,
          { env: syncEnv },
          undefined,
          (exitCode) => {
            if (exitCode === 1 && !force) {
              const confirm = "Force";

              vscode.window
                .showErrorMessage("Sync failed. Try force sync?", confirm)
                .then((value) => {
                  if (value && value === confirm) {
                    vscode.commands.executeCommand(
                      "electron-build-tools.sync",
                      true
                    );
                  }
                });

              return true;
            }
          }
        );

        task.onDidWriteLine(({ progress, line }) => {
          // TODO - Regex for syncing dependencies: /^(\S+)\s+\(Elapsed: ([:\d]+)\)$/

          if (/^gclient.*verify_validity:/.test(line)) {
            progress.report({ message: "Verifying Validity" });
          } else if (/running.*apply_all_patches\.py/.test(line)) {
            progress.report({ message: "Applying Patches" });
          } else if (/Hook.*apply_all_patches\.py.*took/.test(line)) {
            progress.report({ message: "Finishing Up" });
          } else if (!initialProgress) {
            initialProgress = true;
            progress.report({ message: "Dependencies" });
          }
        });
      }
    ),
    vscode.commands.registerCommand("electron-build-tools.sync.force", () => {
      return vscode.commands.executeCommand("electron-build-tools.sync", true);
    }),
    vscode.commands.registerCommand("electron-build-tools.test", async () => {
      const operationName = "Electron Build Tools - Running Tests";
      let command = `${buildToolsExecutable} test`;

      const runnerOptions: vscode.QuickPickItem[] = [
        {
          label: "main",
          picked: true,
        },
        {
          label: "native",
          picked: true,
        },
        {
          label: "remote",
          picked: true,
        },
      ];

      const runners = await vscode.window.showQuickPick(runnerOptions, {
        placeHolder: "Choose runners to use",
        canPickMany: true,
      });
      const extraArgs = await vscode.window.showInputBox({
        placeHolder: "Extra args to pass to the test runner",
      });

      if (runners && extraArgs) {
        if (runners.length > 0) {
          command = `${command} --runners=${runners
            .map((runner) => runner.label)
            .join(",")}`;
        }

        runAsTask(
          context,
          operationName,
          "test",
          `${command} ${extraArgs}`,
          {},
          "$mocha"
        );
      }
    }),
    vscode.commands.registerCommand(
      "electron-build-tools.use-config",
      (config: ConfigTreeItem) => {
        // Do an optimistic update for snappier UI
        configsProvider.setActive(config.label);

        childProcess.exec(
          `${buildToolsExecutable} use ${config.label}`,
          {
            encoding: "utf8",
          },
          (error, stdout) => {
            if (error ?? stdout.trim() !== `Now using config ${config.label}`) {
              vscode.window.showErrorMessage(
                "Failed to set active Electron build-tools config"
              );
              configsProvider.setActive(null);
              configsProvider.refresh();
            }
          }
        );
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.use-config.quick-pick",
      async () => {
        const { configs } = getConfigs();
        const selected = await vscode.window.showQuickPick(configs);

        if (selected) {
          // Do an optimistic update for snappier UI
          configsProvider.setActive(selected);

          childProcess.exec(
            `${buildToolsExecutable} use ${selected}`,
            {
              encoding: "utf8",
            },
            (error, stdout) => {
              if (error ?? stdout.trim() !== `Now using config ${selected}`) {
                vscode.window.showErrorMessage(
                  "Failed to set active Electron build-tools config"
                );
                configsProvider.setActive(null);
                configsProvider.refresh();
              }
            }
          );
        }
      }
    ),
    vscode.commands.registerCommand(
      "electron-build-tools.openConfig",
      async (configName: string) => {
        const configFilePath = path.join(
          getConfigsFilePath(),
          `evm.${configName}.json`
        );
        try {
          const document = await vscode.workspace.openTextDocument(
            configFilePath
          );
          await vscode.window.showTextDocument(document);
        } catch (e) {
          console.log(e);
        }

        return configFilePath;
      }
    )
  );
}

function registerHelperCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vscode.window.showOpenDialog",
      async (options: vscode.OpenDialogOptions | undefined) => {
        const results = await vscode.window.showOpenDialog(options);

        if (results) {
          return results[0].fsPath;
        }
      }
    )
  );
}

export async function activate(context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;

  const buildToolsIsInstalled = isBuildToolsInstalled();

  vscode.commands.executeCommand(
    "setContext",
    "electron-build-tools:ready",
    false
  );
  vscode.commands.executeCommand(
    "setContext",
    "electron-build-tools:build-tools-installed",
    buildToolsIsInstalled
  );
  vscode.commands.executeCommand(
    "setContext",
    "electron-build-tools:is-electron-workspace",
    false
  );

  // Always show the help view
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      "electron-build-tools:help",
      new HelpTreeDataProvider()
    )
  );

  if (buildToolsIsInstalled && workspaceFolders) {
    const workspaceFolder = workspaceFolders[0];

    const isElectronWorkspace = await electronIsInWorkspace(workspaceFolder);
    vscode.commands.executeCommand(
      "setContext",
      "electron-build-tools:is-electron-workspace",
      isElectronWorkspace
    );

    if (isElectronWorkspace) {
      vscode.commands.executeCommand(
        "setContext",
        "electron-build-tools:active",
        true
      );

      const configsProvider = new ElectronBuildToolsConfigsProvider();
      const patchesProvider = new ElectronPatchesProvider(
        workspaceFolder,
        getPatchesConfigFile(workspaceFolder)
      );
      const testsProvider = new TestsTreeDataProvider(context, workspaceFolder);
      registerElectronBuildToolsCommands(
        context,
        configsProvider,
        patchesProvider,
        testsProvider
      );
      registerHelperCommands(context);
      context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
          "typescript",
          new TestCodeLensProvider(testsProvider)
        ),
        vscode.languages.createDiagnosticCollection("electron-build-tools"),
        vscode.window.registerTreeDataProvider(
          "electron-build-tools:configs",
          configsProvider
        ),
        vscode.window.registerTreeDataProvider(
          "electron-build-tools:patches",
          patchesProvider
        ),
        vscode.window.registerTreeDataProvider(
          "electron-build-tools:docs",
          new DocsTreeDataProvider(workspaceFolder)
        ),
        vscode.window.registerTreeDataProvider(
          "electron-build-tools:electron",
          new ElectronViewProvider(workspaceFolder)
        ),
        vscode.window.registerTreeDataProvider(
          "electron-build-tools:tests",
          testsProvider
        ),
        vscode.workspace.registerTextDocumentContentProvider(
          virtualDocumentScheme,
          new TextDocumentContentProvider()
        )
      );
    }
  }

  vscode.commands.executeCommand(
    "setContext",
    "electron-build-tools:ready",
    true
  );
}
