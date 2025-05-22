import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child-process-promise';
import * as fs from 'fs';
import { lookpath } from 'lookpath';
import untildify = require('untildify');
import { Data, parse } from 'envfile';
import { quote } from 'shlex';
import * as AsyncLock from 'async-lock';
import * as allSettled from 'promise.allsettled';
import {MypyOutputLine, mypyOutputPattern} from './mypy';
import {IExtensionApi, ActiveEnvironmentPathChangeEvent} from './python';

const diagnostics = new Map<vscode.Uri, vscode.DiagnosticCollection>();
const outputChannel = vscode.window.createOutputChannel('Mypy');
let _context: vscode.ExtensionContext | undefined;
let lock = new AsyncLock();
let statusBarItem: vscode.StatusBarItem | undefined;
let activeChecks = 0;
let checkIndex = 1;
let activated = false;
let logFile: string | undefined;

const mypyFormatArgs = [
	"--show-error-end",
	"--no-error-summary",
	"--no-pretty",
	"--no-color-output",
];

type ChildProcessError = {code: number | undefined, stdout: string | undefined, stderr: string | undefined};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	activated = true;
	_context = context;
	context.subscriptions.push(outputChannel);
	const extension = vscode.extensions.getExtension('matangover.mypy');
	const currentVersion = extension?.packageJSON.version;
	context.globalState.update('extensionVersion', currentVersion);

	initDebugLog(context);
	output(`Mypy extension activated, version ${currentVersion}`);
	if (extension?.extensionKind === vscode.ExtensionKind.Workspace) {
		output('Running remotely');
	}
	if (logFile) {
		output(`Saving debug log to: ${logFile}`);
	}

	statusBarItem = vscode.window.createStatusBarItem();
	context.subscriptions.push(statusBarItem);
	statusBarItem.text = "$(gear~spin) mypy";

	output('Registering listener for interpreter changed event');
	const pythonExtensionAPI = await getPythonExtensionAPI(undefined);
	if (pythonExtensionAPI !== undefined) {
		const handler = pythonExtensionAPI.environments.onDidChangeActiveEnvironmentPath(activeInterpreterChanged);
		context.subscriptions.push(handler);
		output('Listener registered');
	}

	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(workspaceFoldersChanged),
		vscode.workspace.onDidOpenNotebookDocument(checkNotebook),
		vscode.workspace.onDidSaveNotebookDocument(checkNotebook),
		vscode.workspace.onDidSaveTextDocument(documentSaved),
		vscode.workspace.onDidDeleteFiles(filesDeleted),
		vscode.workspace.onDidRenameFiles(filesRenamed),
		vscode.workspace.onDidCreateFiles(filesCreated),
		vscode.workspace.onDidChangeConfiguration(configurationChanged),
		vscode.commands.registerCommand("mypy.recheckWorkspace", recheckWorkspace),
		vscode.commands.registerCommand("mypy.restartAndRecheckWorkspace", restartAndRecheckWorkspace)
	);
	// This is used to show the custom commands only when the extension is active.
	vscode.commands.executeCommand("setContext", "mypy.activated", true);

	// Do _not_ await this call on purpose, so that extension activation finishes quickly. This is
	// important because if VS Code is closed before the checks are done, deactivate will only be
	// called if activate has already finished.
	forEachFolder(vscode.workspace.workspaceFolders, folder => checkWorkspace(folder.uri));

	// Similarly, do not await this too.
	checkAllNotebooks()

	output('Activation complete');
}

function initDebugLog(context: vscode.ExtensionContext) {
	const mypyConfig = vscode.workspace.getConfiguration('mypy');
	const debug = mypyConfig.get<boolean>('debugLogging', false);
	if (debug) {
		try {
			const storageDir = context.globalStorageUri.fsPath;
			fs.mkdirSync(storageDir, { recursive: true });
			logFile = path.join(storageDir, "mypy_extension.log");
		} catch (e) {
			output(`Failed to create extension storage directory: ${e}`);
		}
	}
}


export async function deactivate(): Promise<void> {
	activated = false;
	output(`Mypy extension deactivating, shutting down daemons...`);
	await forEachFolder(vscode.workspace.workspaceFolders, folder => stopDaemon(folder.uri));
	output(`Mypy daemons stopped, extension deactivated`);
	vscode.commands.executeCommand("setContext", "mypy.activated", false);
}

async function workspaceFoldersChanged(e: vscode.WorkspaceFoldersChangeEvent): Promise<void> {
	const format = (folders: readonly vscode.WorkspaceFolder[]) => folders.map(f => f.name).join(", ") || "none";
	output(`Workspace folders changed. Added: ${format(e.added)}. Removed: ${format(e.removed)}.`);

	await forEachFolder(e.removed, async folder => {
		await stopDaemon(folder.uri);
		diagnostics.get(folder.uri)?.dispose();
		diagnostics.delete(folder.uri);
	});
	await forEachFolder(e.added, folder => checkWorkspace(folder.uri));
}

async function forEachFolder<T extends vscode.Uri | vscode.WorkspaceFolder>(
	folders: readonly T[] | undefined, func: (folder: T) => Promise<any>, ignoreErrors = true) {
	if (folders === undefined) {
		return;
	}

	// Run the function for each callback, and catch errors if any.
	// Use allSettled instead of Promise.all to always await all Promises, even if one rejects.
	const promises = folders.map(func);
	const results = await allSettled(promises);
	const rejections = [];
	for (const [index, result] of results.entries()) {
		if (result.status === "rejected") {
			const folder: vscode.Uri | vscode.WorkspaceFolder = folders[index];
			const folderUri = folder instanceof vscode.Uri ? folder : folder.uri;
			rejections.push({
				folder: folderUri.fsPath,
				error: result.reason
			})
		}
	}
	if (rejections.length > 0) {
		if (ignoreErrors) {
			const errorString = rejections.map(r => `${r.folder}: ${errorToString(r.error)}`).join("\n");
			output("forEachFolder ignored errors in the following folders:\n" + errorString);
		} else {
			throw rejections;
		}
	}
}

function errorToString(error: unknown) {
	if (error instanceof Error && error.stack) {
		return error.stack;
	} else {
		return String(error);
	}
}


async function stopDaemon(folder: vscode.Uri, retry=true): Promise<void> {
	output(`Stop daemon: ${folder.fsPath}`);

	const result = await runDmypy(folder, 'stop');
	if (result.success) {
		output(`Stopped daemon: ${folder.fsPath}`);
	} else {
		if (retry) {
			// Daemon stopping can fail with 'Status file not found' if the daemon has been started
			// very recently and hasn't written the status file yet. In that case, retry, otherwise
			// we might leave a zombie daemon running. This happened due to the following events:
			// 1. Open folder in VS Code, and then add another workspace folder
			// 2. VS Code fires onDidChangeWorkspaceFolders and onDidChangeConfiguration, which
			//	  causes us to queue two checks. (This is probably a bug in VS Code.)
			// 3. VS Code immediately restarts the Extension Host process, which causes our
			//    extension to deactivate.
			// 4. We try to stop the daemon but it is not yet running. We then start the daemon
			//    because of the queued check(s), which results in a zombie daemon.
			// This simple retry solves the issue.
			output(`Daemon stopping failed, retrying in 1 second: ${folder.fsPath}`);
			await sleep(1000);
			await stopDaemon(folder, false);
		} else {
			output(`Daemon stopping failed again, giving up: ${folder.fsPath}`);
		}
	}
}

function loadEnv(filePath: fs.PathLike): Data {
	if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
		return {};
	}

	const contents = fs.readFileSync(filePath, 'utf8');
	return parse(contents);
}

type DmypyCommand = 'start' | 'restart' | 'status' | 'stop' | 'kill' | 'check' | 'run' | 'recheck' | 'suggest' | 'hang' | 'daemon' | 'help';

async function runDmypy(
	folder: vscode.Uri,
	dmypyCommand: DmypyCommand,
	mypyArgs: string[] = [],
	warnIfFailed = false,
	successfulExitCodes?: number[],
	addPythonExecutableArgument = false,
	currentCheck?: number,
	retryIfDaemonStuck = true
): Promise<{ success: boolean, stdout: string | null }> {
	const mypyConfig = vscode.workspace.getConfiguration('mypy', folder);

	let dmypyGlobalArgs: string[] = [];
	let dmypyCommandArgs: string[] = [];
	let statusFilePath: string = mypyConfig.get<string>('statusFile', '');
	const currentWorkingDirectory: string = path.join(folder.fsPath, mypyConfig.get<string>('currentWorkingDirectory', '.'));

	if (_context?.storageUri !== undefined) {
		fs.mkdirSync(_context.storageUri.fsPath, {recursive: true});
		const folderHash = crypto.createHash('sha1').update(folder.toString()).digest('hex');
		if (!statusFilePath) {
			// Store the dmypy status file in the extension's workspace storage folder, instead of the
			// default location which is .dmypy.json in the cwd.
			const statusFileName = `dmypy-${folderHash}-${process.pid}.json`;
			statusFilePath = path.join(_context.storageUri.fsPath, statusFileName);
		}
		const commandsSupportingLog: DmypyCommand[] = ["start", "restart", "run"];
		if (commandsSupportingLog.includes(dmypyCommand)) {
			const logFileName = `dmypy-${folderHash}.log`;
			const logFilePath = path.join(_context.storageUri.fsPath, logFileName);
			dmypyCommandArgs = ['--log-file', logFilePath];
		}
	}

	if (statusFilePath) {
		dmypyGlobalArgs = ['--status-file', statusFilePath];
	}

	const result = await getExecutableAndArgs(folder, currentCheck, warnIfFailed, true);
	const {executable, activeInterpreter, executionArgs, runUsingActiveInterpreter, envVars} = result;
	if (executable === undefined) {
		return { success: false, stdout: null };
	}

	if (addPythonExecutableArgument && activeInterpreter) {
		mypyArgs = ['--python-executable', activeInterpreter, ...mypyArgs];
	}

	const args = [...executionArgs, ...dmypyGlobalArgs, dmypyCommand, ...dmypyCommandArgs];
	if (mypyArgs.length > 0) {
		args.push("--", ...mypyArgs);
	}
	const command = [executable, ...args].map(quote).join(" ");
	output(`Running dmypy in folder ${folder.fsPath} using ${currentWorkingDirectory} as current working directory\n${command}`, currentCheck);
	try {
		const result = await spawn(
			executable,
			args,
			{
				cwd: currentWorkingDirectory,
				capture: ['stdout', 'stderr'],
				successfulExitCodes,
				env: envVars,
			}
		);
		if (result.code == 1 && result.stderr) {
			// This might happen when running using `python -m mypy.dmypy` and some error in the
			// interpreter occurs, such as import error when mypy is not installed.
			let error = '';
			if (runUsingActiveInterpreter && result.stderr.includes('ModuleNotFoundError')) {
				error = 'Probably mypy is not installed in the active interpreter ' +
					`(${activeInterpreter}). Either install mypy in this interpreter or switch ` +
					'off the mypy.runUsingActiveInterpreter setting. ';
			}
			warn(
				`Error running mypy in ${folder.fsPath}. ${error}See Output panel for details.`,
				warnIfFailed, currentCheck, true);
			if (result.stdout) {
				output(`stdout:\n${result.stdout}`, currentCheck);
			}
			output(`stderr:\n${result.stderr}`, currentCheck);
			return { success: false, stdout: result.stdout };
		}
		return { success: true, stdout: result.stdout };
	} catch (exception: any) {
		let error = exception.toString();
		let showDetailsButton = false;
		if (exception.name === 'ChildProcessError') {
			const ex = exception as ChildProcessError;
			if (ex.code !== undefined) {
				let errorString;
				if (ex.stderr) {
					// Show only first line of error to user because Newlines are stripped in VSCode
					// warning messages and it can appear confusing.
					let mypyError = ex.stderr.split("\n")[0];
					if (mypyError.length > 300) {
						mypyError = mypyError.slice(0, 300) + " [...]";
					}
					errorString = `error: "${mypyError}"`;
				} else {
					errorString = `exit code ${ex.code}`;
				}
				error = `mypy failed with ${errorString}. See Output panel for details.`;
				showDetailsButton = true;
			}
			if (ex.stdout) {
				if (ex.code == 2 && !ex.stderr) {
					// Mypy considers syntax errors as fatal errors (exit code 2). The daemon's
					// exit code is inconsistent in this case (e.g. for syntax errors it can return
					// either 1 or 2).
					return { success: true, stdout: ex.stdout };
				}
				output(`stdout:\n${ex.stdout}`, currentCheck);
			}
			if (ex.stderr) {
				output(`stderr:\n${ex.stderr}`, currentCheck);
				if (ex.stderr.indexOf('Daemon crashed!') != -1) {
					error = 'the mypy daemon crashed. This is probably a bug in mypy itself, ' + 
					'see Output panel for details. The daemon will be restarted automatically.'
					showDetailsButton = true;
				} else if (ex.stderr.indexOf('There are no .py[i] files in directory') != -1) {
					// Swallow this error. This may happen if one workspace folder contains
					// Python files and another folder doesn't, or if a workspace contains Python
					// files that are not reachable from the target directory.
					return { success: true, stdout: '' };
				} else if (
					ex.stderr.indexOf('Connection refused') != -1 ||
					ex.stderr.indexOf('[Errno 2] No such file') != -1 ||
					ex.stderr.indexOf('Socket operation on non-socket') != -1) {
					// This can happen if the daemon is stuck, or if the status file is stale due to
					// e.g. a previous daemon that hasn't been stopped properly. See:
					// https://github.com/matangover/mypy-vscode/issues/37
					// https://github.com/matangover/mypy-vscode/issues/45
					// To reproduce the above exceptions:
					//  1. 'Connection refused': kill daemon process (so that it stops listening on
					//     the socket), and change the pid in status file to any running process.
					//  2. 'No such file': change connection_name in status file to a non-existent
					//     file.
					//  3. 'Socket operation on non-socket': change connection_name in status file
					//     to an existing file which is not a socket
					if (retryIfDaemonStuck) {
						// Kill the daemon.
						output("Daemon is stuck or status file is stale. Killing daemon", currentCheck);
						await killDaemon(folder, currentCheck, statusFilePath);
						// Run the same command again, but this time don't retry if it fails.
						await sleep(1000);
						output("Retrying command", currentCheck);
						return await runDmypy(folder, dmypyCommand, mypyArgs, warnIfFailed, successfulExitCodes, addPythonExecutableArgument, currentCheck, false);
					} else {
						error = 'the mypy daemon is stuck. An attempt to kill it and retry failed. ' + 
						'This is probably a bug in mypy itself, see Output panel for details.';
						showDetailsButton = true;
					}
				}
			}
		}
		warn(`Error running mypy in ${folder.fsPath}: ${error}`, warnIfFailed, currentCheck, showDetailsButton);
		return { success: false, stdout: null };
	}
}

async function getExecutableAndArgs(folder: vscode.Uri, currentCheck: number | undefined, warnIfFailed: boolean, daemon: boolean) {
	const activeInterpreter = await getActiveInterpreter(folder, currentCheck);
	const mypyConfig = vscode.workspace.getConfiguration('mypy', folder);
	let executable: string | undefined;
	const runUsingActiveInterpreter = mypyConfig.get<boolean>('runUsingActiveInterpreter');
	let executionArgs: string[] = [];
	if (runUsingActiveInterpreter) {
		executable = activeInterpreter;
		const moduleName = daemon ? "mypy.dmypy" : "mypy";
		executionArgs = ["-m", moduleName];
		if (executable === undefined) {
			warn(
				"Could not run mypy: no active interpreter. Please activate an interpreter in the " +
				"Python extension or switch off the mypy.runUsingActiveInterpreter setting.",
				warnIfFailed, currentCheck
			);
		}
	} else {
		executable = await getDmypyExecutable(folder, warnIfFailed, daemon, currentCheck);
	}
	const envVars = getEnvVars(mypyConfig, folder);
	return {executable, activeInterpreter, executionArgs, runUsingActiveInterpreter, envVars};
}

function getEnvVars(mypyConfig: vscode.WorkspaceConfiguration, folder: vscode.Uri) {
	let envVars = {...process.env};
	const envFileConfig = mypyConfig.get<string>('envFile');
	if (envFileConfig) {
		const envFile = normalizePath(envFileConfig, folder);
		Object.assign(envVars, loadEnv(envFile));
	}
	const configEnvVars = mypyConfig.get<{[key: string]: string;}>('env', {});
	Object.assign(envVars, configEnvVars);
	return envVars;
}

async function killDaemon(folder: vscode.Uri, currentCheck: number | undefined, statusFilePath: string | null) {
	const killResult = await runDmypy(folder, "kill", undefined, undefined, undefined, undefined, currentCheck, false);
	output(`Ran dmypy kill, stdout: ${killResult.stdout}`, currentCheck);
	if (killResult.success) {
		output("Daemon killed successfully", currentCheck);
		return;
	}

	output("Error killing daemon, attempt to delete status file", currentCheck);
	if (statusFilePath) {
		try {
			fs.unlinkSync(statusFilePath);
		} catch (e) {
			output(`Error deleting status file: ${errorToString(e)}`, currentCheck);
		}
	} else {
		output("No status file to delete", currentCheck);
	}
}

async function recheckWorkspace() {
	output("Rechecking workspace");
	await forEachFolder(vscode.workspace.workspaceFolders, folder => checkWorkspace(folder.uri));
	output("Recheck complete");
}

async function restartAndRecheckWorkspace() {
	output("Stopping daemons");
	await forEachFolder(vscode.workspace.workspaceFolders, folder => stopDaemon(folder.uri));
	await recheckWorkspace();
}

async function getDmypyExecutable(folder: vscode.Uri, warnIfFailed: boolean, daemon: boolean, currentCheck?: number): Promise<string | undefined> {
	const displayName = daemon ? 'mypy daemon' : 'mypy';
	const configName = daemon ? 'dmypyExecutable' : 'mypyExecutable';
	const defaultExeName = daemon ? 'dmypy' : 'mypy';

	const mypyConfig = vscode.workspace.getConfiguration('mypy', folder);
	let dmypyExecutable = mypyConfig.get<string>(configName) ?? defaultExeName;
	let helpURL = "https://github.com/matangover/mypy-vscode#installing-mypy";
	const isCommand = path.parse(dmypyExecutable).dir === '';
	if (isCommand) {
		const executable = await lookpath(dmypyExecutable);
		if (executable === undefined) {
			warn(
				`The ${displayName} executable ('${dmypyExecutable}') was not found on your PATH. ` +
				`Please install mypy or adjust the mypy.${configName} setting.`,
				warnIfFailed, currentCheck, undefined, helpURL
			)
			return undefined;
		}
		dmypyExecutable = executable;
	} else {
		dmypyExecutable = normalizePath(dmypyExecutable, folder, false);
		if (!fs.existsSync(dmypyExecutable)) {
			warn(
				`The ${displayName} executable ('${dmypyExecutable}') was not found. ` +
				`Please install mypy or adjust the mypy.${configName} setting.`,
				warnIfFailed, currentCheck, undefined, helpURL
			)
			return undefined;
		}
	}
	return dmypyExecutable;
}

async function checkAllNotebooks() {
	await Promise.all(vscode.workspace.notebookDocuments.map(notebook => checkNotebook(notebook)));
}

async function checkFolderNotebooks(folder: vscode.Uri) {
	const notebooks = vscode.workspace.notebookDocuments.filter(
		notebook => vscode.workspace.getWorkspaceFolder(notebook.uri)?.uri == folder);
	await Promise.all(notebooks.map(notebook => checkNotebook(notebook)));
	// TODO: remove diagnostics for notebooks that no longer exist.
}

async function checkNotebook(notebook: vscode.NotebookDocument) {
	// We only support these right now.
	if (notebook.notebookType !== "jupyter-notebook") {
		return;
	}
	const folder = vscode.workspace.getWorkspaceFolder(notebook.uri)?.uri;
	if (!folder) {
		return;
	}
	const startResult = startCheck(folder, true);
	if (startResult === undefined) {
		return;
	}
	const {currentCheck, mypyConfig} = startResult;
	output(`Check notebook: ${notebook.uri.fsPath}`, currentCheck);

	try {
		checkNotebookInternal(notebook, folder, currentCheck, mypyConfig);
	} finally {
		endCheck();
	}
}

async function checkNotebookInternal(notebook: vscode.NotebookDocument, folder: vscode.Uri, currentCheck: number, mypyConfig: vscode.WorkspaceConfiguration) {
	// We cannot check notebooks with dmypy, but we can use mypy directly
	// to check a string... Here we just concatenate all of the cells and check that,
	// which seems to be good enough for now, but there may be a case where this doesn't work.
	// vscode treats each cell as its own document, which makes things a bit more complicated.
	const cells = notebook.getCells().map((cell) => cell.document);

	// We need to combine all of the python into a single string for mypy to check,
	// but we need to also remember where each part of the string came from.
	// Create a list of {cellIndex, lineIndex, line}, so now we know for each line
	// of python code which line of which cell it came from.
	const concatenatedCodeLines = concatenateCodeLines(cells);

	const exeAndArgs = await getExecutableAndArgs(folder, currentCheck, true, false);
	const {executable, activeInterpreter, executionArgs, runUsingActiveInterpreter, envVars} = exeAndArgs;
	if (executable === undefined) {
		return;
	}
	let mypyArgs = getMypyArgs(folder, [], mypyConfig, currentCheck)
	if (activeInterpreter) {
		mypyArgs = ['--python-executable', activeInterpreter, ...mypyArgs];
	}
	const concatenatedCode = concatenatedCodeLines.map(c => c.line).join("\n");
	const args = [...executionArgs, ...mypyFormatArgs, ...mypyArgs, "-c", concatenatedCode];
	const argsForPrint = [...args.slice(0, -1), `<< code (${concatenatedCodeLines.length} lines) >>`];
	const command = [executable, ...argsForPrint].map(quote).join(" ");
	output(`Running mypy in folder ${folder.fsPath}\n${command}`, currentCheck);
	let spawnResult;
	try {
		spawnResult = await spawn(
			executable,
			args,
			{
				cwd: folder.fsPath,
				capture: ["stdout", "stderr"],
				successfulExitCodes: [0, 1, 2],
				env: envVars,
			}
		)
	} catch (e: any) {
		output(`Error running mypy on notebook: ${e.toString()}`, currentCheck);
		if (e.name === 'ChildProcessError') {
			const ex = e as ChildProcessError;
			if (ex.stdout) {
				output(`stdout:\n${ex.stdout}`, currentCheck);
			}
			if (ex.stderr) {
				output(`stderr:\n${ex.stderr}`, currentCheck);
			}
		}
		return;
	}
	output(`Mypy stdout:\n${spawnResult.stdout}`, currentCheck);
	if (spawnResult.stderr) {
		output(`Mypy stderr:\n${spawnResult.stderr}`, currentCheck);
	}
	const mypyOutput = parseMypyOutput(spawnResult.stdout, folder);
	const cellDiagnostics = getCellDiagnostics(mypyOutput, concatenatedCodeLines, cells);

	const folderDiagnostics = getWorkspaceDiagnostics(folder);
	// Remove existing diagnostics for this notebook's cells.
	cells.forEach((cell) => folderDiagnostics.delete(cell.uri));
	// Remove any remaining diagnostics (can happen if a cell was deleted).
	for (const [fileUri, diagnostics] of folderDiagnostics) {
		if (fileUri.scheme === "vscode-notebook-cell" && fileUri.path === notebook.uri.path) {
			folderDiagnostics.delete(fileUri);
		}
	}
	// Add the new diagnostics.
	for (const [cellUri, cellDiags] of cellDiagnostics) {
		folderDiagnostics.set(cellUri, cellDiags);
	}
}

function concatenateCodeLines(cells: vscode.TextDocument[]) {
	return cells
		// remember the cell index
		.map((cell, cellIndex) => ({ cell, cellIndex }))
		// only keep track of python cells
		.filter(c => c.cell.languageId === "python")
		// remember the line index
		.flatMap(c => (
				c.cell.getText().split("\n").map(
					(line, lineIndex) => ({ cellIndex: c.cellIndex, lineIndex, line })
				)
			)
		)
		// ignore any cell magics or commands
		.filter(c => !c.line.startsWith("%") && !c.line.startsWith("!"));
}

function getCellDiagnostics(mypyOutput: Map<vscode.Uri, vscode.Diagnostic[]>, concatenatedCodeLines: { cellIndex: number; lineIndex: number; line: string; }[], cells: vscode.TextDocument[]) {
	const cellDiagnostics = new Map<vscode.Uri, vscode.Diagnostic[]>();
	for (const [uri, diagnostics] of mypyOutput) {
		for (const diagnostic of diagnostics) {
			const startLine = concatenatedCodeLines[diagnostic.range.start.line];
			const endLine = concatenatedCodeLines[diagnostic.range.start.line];

			// this should never happen, but technically could if someone wrote something like
			// # cell 1
			// def my_func() -> None:
			//   pass
			//
			// # cell 2
			//   return 6
			//
			// since we concatenate, we will get an error that we are returning in a function
			// that should return None rather than a syntax error that we have indented and
			// returned outside of a function
			//
			// TODO maybe we can sprinkle in some left-aligned pass
			// statements to prevent cases like that
			if (startLine.cellIndex !== endLine.cellIndex) {
				continue;
			}

			// We need to remap the positions of each diagnostic message
			// to the correct line of the correct cell.
			const newDiagnostic = new vscode.Diagnostic(
				new vscode.Range(
					new vscode.Position(
						startLine.lineIndex,
						diagnostic.range.start.character
					),
					new vscode.Position(endLine.lineIndex, diagnostic.range.end.character)
				),
				diagnostic.message,
				diagnostic.severity
			);
			newDiagnostic.code = diagnostic.code;
			newDiagnostic.source = diagnostic.source;

			const cellUri = cells[startLine.cellIndex].uri;
			if (!cellDiagnostics.has(cellUri)) {
				cellDiagnostics.set(cellUri, []);
			}
			cellDiagnostics.get(cellUri)!.push(newDiagnostic);
		}
	}
	return cellDiagnostics;
}

async function documentSaved(document: vscode.TextDocument): Promise<void> {
	const folder = vscode.workspace.getWorkspaceFolder(document.uri);
	if (!folder) {
		return;
	}

	const configChanged = isMaybeConfigFile(folder, document.fileName);
	if (document.languageId == "python" || configChanged) {
		output(`Document saved: ${document.uri.fsPath}`);
		await checkWorkspace(folder.uri);
	}
	if (configChanged) {
		output("Config file saved, checking notebooks");
		await checkFolderNotebooks(folder.uri);
	}
}

function isMaybeConfigFile(folder: vscode.WorkspaceFolder, file: string) {
	if (isConfigFileName(file)) {
		return true;
	}

	let configFile = vscode.workspace.getConfiguration("mypy", folder).get<string>("configFile");
	if (configFile === undefined) {
		return false;
	}
	if (!path.isAbsolute(configFile)) {
		configFile = path.join(folder.uri.fsPath, configFile);
	}
	return path.normalize(configFile) == path.normalize(file);
}

function isConfigFileName(file: string) {
	const name = path.basename(file);
	return name == "mypy.ini" || name == ".mypy.ini" || name == "setup.cfg" || name == "config";
}

async function configurationChanged(event: vscode.ConfigurationChangeEvent): Promise<void> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	const affectedFolders = folders.filter(folder => event.affectsConfiguration("mypy", folder));
	if (affectedFolders.length === 0) {
		return;
	}
	const affectedFoldersString = affectedFolders.map(f => f.uri.fsPath).join(", ");
	output(`Mypy settings changed: ${affectedFoldersString}`);
	await forEachFolder(affectedFolders, folder => checkWorkspace(folder.uri));
	await forEachFolder(affectedFolders, folder => checkFolderNotebooks(folder.uri));
}

async function checkWorkspace(folder: vscode.Uri) {
	// Don't check the same workspace folder more than once at the same time.
	await lock.acquire(folder.fsPath, () => checkWorkspaceInternal(folder));
}

async function checkWorkspaceInternal(folder: vscode.Uri) {
	const startResult = startCheck(folder);
	if (startResult === undefined) {
		return;
	}
	const {currentCheck, mypyConfig} = startResult;
	output(`Check folder: ${folder.fsPath}`, currentCheck);

	let targets = mypyConfig.get<string[]>("targets", []);
	const mypyArgs = getMypyArgs(folder, targets, mypyConfig, currentCheck);
	const result = await runDmypy(
		folder,
		'run',
		mypyArgs,
		true,
		[0, 1],
		true,
		currentCheck
	);

	endCheck();

	if (result.stdout !== null) {
		output(`Mypy output:\n${result.stdout ?? "\n"}`, currentCheck);
	}
	const folderDiagnostics = getWorkspaceDiagnostics(folder);
	for (const [fileUri, diagnostics] of folderDiagnostics) {
		if (!fileUri.path.endsWith(".ipynb")) {
			folderDiagnostics.delete(fileUri);
		}
	}
	if (result.success && result.stdout) {
		const fileDiagnostics = parseMypyOutput(result.stdout, folder);
		folderDiagnostics.set(Array.from(fileDiagnostics.entries()));
	}
}

function getMypyArgs(folder: vscode.Uri, targets: string[], mypyConfig: vscode.WorkspaceConfiguration, currentCheck: number) {
	// Use absolute target paths so targets are relative to workspace root
	// rather than current working directory.
	const absTargets = targets.map(target => !path.isAbsolute(target) ? path.join(folder.fsPath, target) : target);
	const mypyArgs = [...absTargets, ...mypyFormatArgs];
	let configFile = mypyConfig.get<string>("configFile");
	if (configFile) {
		// Use absolute config path so configFile is relative to workspace root
		// rather than current working directory.
		if (!path.isAbsolute(configFile)) {
			configFile = path.join(folder.fsPath, configFile);
		}
		output(`Using config file: ${configFile}`, currentCheck);
		mypyArgs.push('--config-file', configFile);
	}

	const extraArguments = mypyConfig.get<string[]>("extraArguments");
	if (extraArguments !== undefined && extraArguments.length > 0) {
		output(`Using extra arguments: ${extraArguments}`, currentCheck);
		mypyArgs.push(...extraArguments);
	}
	return mypyArgs;
}

function startCheck(folder: vscode.Uri, notebook: boolean = false) {
	if (!activated) {
		// This can happen if a check was queued right before the extension was deactivated.
		// We don't want to check in that case since it would cause a zombie daemon.
		output(`Extension is not activated, not checking: ${folder.fsPath}`);
		return undefined;
	}

	const mypyConfig = vscode.workspace.getConfiguration("mypy", folder);
	if (!mypyConfig.get<boolean>("enabled", true)) {
		output(`Mypy disabled for folder: ${folder.fsPath}`);
		const folderDiagnostics = diagnostics.get(folder);
		if (folderDiagnostics) {
			folderDiagnostics.clear();
		}
		return undefined;
	}

	if (notebook && !mypyConfig.get<boolean>("checkNotebooks", false)) {
		output(`Not checking notebook, checkNotebooks is false.`);
		return undefined;
	}

	statusBarItem!.show();
	activeChecks++;
	const currentCheck = checkIndex;
	checkIndex++;
	return {currentCheck, mypyConfig};
}

function endCheck() {
	activeChecks--;
	if (activeChecks == 0) {
		statusBarItem!.hide();
	}
}

function parseMypyOutput(stdout: string, folder: vscode.Uri) {
	const outputLines: MypyOutputLine[] = [];
	stdout.split(/\r?\n/).forEach(line => {
		const match = mypyOutputPattern.exec(line);
		if (match !== null) {
			const line = match.groups as MypyOutputLine;
			const previousLine = outputLines[outputLines.length - 1];
			if (previousLine && line.type == "note" && previousLine.type == "note" && line.location == previousLine.location) {
				// This line continues the note on the previous line, merge them.
				previousLine.message += "\n" + line.message;
			} else {
				outputLines.push(line);
			}
		}
	});
	
	let fileDiagnostics = new Map<vscode.Uri, vscode.Diagnostic[]>();
	for (const line of outputLines) {
		const diagnostic = createDiagnostic(line);
		const fileUri = getFileUri(line.file, folder);
		if (!fileDiagnostics.has(fileUri)) {
			fileDiagnostics.set(fileUri, []);
		}
		const thisFileDiagnostics = fileDiagnostics.get(fileUri)!;
		thisFileDiagnostics.push(diagnostic);
	}
	return fileDiagnostics;
}

function getLinkUrl(line: MypyOutputLine) {
	if (line.type == "note") {
		const seeLines = line.message.split(/\r?\n/).filter(l => l.startsWith("See https://"));
		if (seeLines.length > 0) {
			return seeLines[0].slice(4);
		}
	} else {
		if (line.code) {
			return `https://mypy.readthedocs.io/en/stable/_refs.html#code-${line.code}`;
		}
	}
	return undefined;
}

function getFileUri(filePath: string, folder: vscode.Uri) {
	// By default mypy outputs paths relative to the checked folder. If the user specifies
	// `show_absolute_path = True` in the config file, mypy outputs absolute paths.	
	if (!path.isAbsolute(filePath)) {
		filePath = path.join(folder.fsPath, filePath);
	}
	const fileUri = vscode.Uri.file(filePath);
	return fileUri;
}

function createDiagnostic(line: MypyOutputLine) {
	// Mypy output is 1-based, VS Code is 0-based.
	const lineNo = parseInt(line.line) - 1;
	let column = 0;
	if (line.column !== undefined) {
		column = parseInt(line.column) - 1;
	}
	let endLineNo = lineNo;
	let endColumn = column;
	if (line.endLine !== undefined && line.endColumn !== undefined) {
		endLineNo = parseInt(line.endLine) - 1;
		// Mypy's endColumn is inclusive, VS Code's is exclusive.
		endColumn = parseInt(line.endColumn);
		if (lineNo == endLineNo && column == endColumn - 1) {
			// Mypy gave a zero-length range, give a zero-length range for VS Code as well, so that
			// the error squiggle marks the entire word at that position.
			endColumn = column;
		}
	}
	const range = new vscode.Range(lineNo, column, endLineNo, endColumn);
	
	const diagnostic = new vscode.Diagnostic(
		range,
		line.message,
		line.type === "error"
			? vscode.DiagnosticSeverity.Error
			: vscode.DiagnosticSeverity.Information
	);

	diagnostic.source = "mypy";
	const errorCode = line.code ?? "note";
	const url = getLinkUrl(line);
	if (url === undefined) {
		diagnostic.code = errorCode;
	} else {
		diagnostic.code = {
			value: errorCode,
			target: vscode.Uri.parse(url),
		};
	}
	return diagnostic;
}

function getWorkspaceDiagnostics(folder: vscode.Uri): vscode.DiagnosticCollection {
	let workspaceDiagnostics = diagnostics.get(folder);
	if (workspaceDiagnostics) {
		return workspaceDiagnostics;
	} else {
		const workspaceDiagnostics = vscode.languages.createDiagnosticCollection('mypy');
		diagnostics.set(folder, workspaceDiagnostics);
		_context!.subscriptions.push(workspaceDiagnostics);
		return workspaceDiagnostics;
	}
}

async function getActiveInterpreter(folder: vscode.Uri, currentCheck?: number) {
	const path = await getPythonPathFromPythonExtension(folder, currentCheck);
	if (path === undefined) {
		return undefined;
	}
	if (!fs.existsSync(path)) {
		warn(`The selected Python interpreter does not exist: ${path}`, false, currentCheck);
		return undefined;
	}
	return path;
}

// The VS Code Python extension manages its own internal Python interpreter configuration. This
// function was originally taken from pyright but modified to work with the new environments API:
// https://github.com/microsoft/vscode-python/wiki/Python-Environment-APIs
async function getPythonPathFromPythonExtension(
    scopeUri: vscode.Uri | undefined, currentCheck: number | undefined
): Promise<string | undefined> {
    try {
        const api = await getPythonExtensionAPI(currentCheck);
		if (api === undefined) {
			return;
		}

		const environmentPath = api.environments.getActiveEnvironmentPath(scopeUri);
		const environment = await api.environments.resolveEnvironment(environmentPath);
		if (environment === undefined) {
			output('Invalid Python environment returned by Python extension', currentCheck);
			return;
		}
		if (environment.executable.uri === undefined) {
			output('Invalid Python executable path returned by Python extension', currentCheck);
			return;
		}
		const result = environment.executable.uri.fsPath;
		output(`Received Python path from Python extension: ${result}`, currentCheck);
		return result;
    } catch (error) {
        output(
            `Exception when reading Python path from Python extension: ${errorToString(error)}`,
			currentCheck
        );
    }

    return undefined;
}

function activeInterpreterChanged(e: ActiveEnvironmentPathChangeEvent) {
	const resource = e.resource;
	if (resource === undefined) {
		output(`Active interpreter changed for resource: unknown`);
		vscode.workspace.workspaceFolders?.map(folder => checkWorkspace(folder.uri));
	} else {
		output(`Active interpreter changed for resource: ${resource.uri.fsPath}`);
		checkWorkspace(resource.uri);
	}
}

async function getPythonExtensionAPI(currentCheck: number | undefined) {
	const extension = vscode.extensions.getExtension('ms-python.python');
	if (!extension) {
		output('Python extension not found', currentCheck);
		return undefined;
	}

	if (!extension.isActive) {
		output('Waiting for Python extension to load', currentCheck);
		await extension.activate();
		output('Python extension loaded', currentCheck);
	}

	const environmentsAPI = extension.exports?.environments;
	if (!environmentsAPI) {
		output(
			'Python extension version is too old (it does not expose the environments API). ' +
			'Please upgrade the Python extension to the latest version.',
			currentCheck
		);
		return undefined;
	}
	return extension.exports as IExtensionApi;
}

async function warn(warning: string, show=false, currentCheck?: number, detailsButton=false, helpURL?: string) {
	output(warning, currentCheck);
	if (show) {
		const items = [];
		if (detailsButton) {
			items.push("Details");
		}
		if (helpURL) {
			items.push("Help");
		}
		const result = await vscode.window.showWarningMessage(warning, ...items);
		if (result === "Details") {
			outputChannel.show();
		} else if (result === "Help") {
			vscode.env.openExternal(vscode.Uri.parse(helpURL!));
		}
	}
}

async function filesDeleted(e: vscode.FileDeleteEvent) {
	await filesChanged(e.files);
}

async function filesRenamed(e: vscode.FileRenameEvent) {
	const changedUris = e.files.map(f => f.oldUri).concat(...e.files.map(f => f.newUri))
	await filesChanged(changedUris);
}

async function filesCreated(e: vscode.FileCreateEvent) {
	await filesChanged(e.files, true);
}

async function filesChanged(files: readonly vscode.Uri[], created = false) {
	const folders = new Set<vscode.Uri>()
	for (let file of files) {
		const folder = vscode.workspace.getWorkspaceFolder(file);
		if (folder === undefined)
			continue;
		
		const path = file.fsPath;
		if (path.endsWith(".py") || path.endsWith(".pyi") || path.endsWith(".ipynb")) {
			folders.add(folder.uri);
		} else if (isMaybeConfigFile(folder, path)) {
			// Don't trigger mypy run if config file has just been created and is empty, because
			// mypy would error. Give the user a chance to edit the file.
			const justCreatedAndEmpty = created && fs.statSync(path).size === 0;
			if (!justCreatedAndEmpty) {
				folders.add(folder.uri);
			}
		}
	}

	if (folders.size === 0) {
		return;
	}
	const foldersString = Array.from(folders).map(f => f.fsPath).join(", ");
	output(`Files changed in folders: ${foldersString}`);
	const folderArray = Array.from(folders);
	await forEachFolder(folderArray, folder => checkWorkspace(folder));
	await forEachFolder(folderArray, folder => checkFolderNotebooks(folder));
}

function output(line: string, currentCheck?: number) {
	if (currentCheck !== undefined) {
		line = `[${currentCheck}] ${line}`;
	}

	if (logFile) {
		try {
			var tzoffset = (new Date()).getTimezoneOffset() * 60000;
			var localISOTime = (new Date(Date.now() - tzoffset)).toISOString().slice(0, -1);
			fs.appendFileSync(logFile, `${localISOTime} [${process.pid}] ${line}\n`);
		} catch (e) {
			// Ignore
		}
	}

	try {
		outputChannel.appendLine(line);
	} catch (e) {
		// Ignore error. This can happen when VS Code is closing and it calls our deactivate
		// function, and the output channel is already closed.
	}
}

function sleep(ms: number) {
	return new Promise<void>(resolve => setTimeout(resolve, ms));
}

function normalizePath(p: string, workspaceFolder: vscode.Uri, makeAbsolute = true) {
	p = untildify(p);
	p = p.replace('${workspaceFolder}', workspaceFolder.fsPath);
	p = path.normalize(p);

	if (makeAbsolute && !path.isAbsolute(p)) {
		p = path.join(workspaceFolder.fsPath, p);
	}
	return p;
}