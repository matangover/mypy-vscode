import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child-process-promise';
import * as fs from 'fs';
import { lookpath } from 'lookpath';
import untildify = require('untildify');
import * as semver from 'semver';
import { quote } from 'shlex';
import * as AsyncLock from 'async-lock';
import * as allSettled from 'promise.allsettled';
import {PromiseRejection} from 'promise.allsettled';

const diagnostics = new Map<vscode.Uri, vscode.DiagnosticCollection>();
const outputChannel = vscode.window.createOutputChannel('Mypy');
let _context: vscode.ExtensionContext | null;
let lock = new AsyncLock();
let statusBarItem: vscode.StatusBarItem;
let activeChecks = 0;
let checkIndex = 1;
const pythonExtensionInitialized = new Set<vscode.Uri | undefined>();
let activated = false;
const DEBUG = false;

export const mypyOutputPattern = /^(?<file>[^:\n]+):((?<line>\d+):)?((?<column>\d+):)? (?<type>\w+): (?<message>.*)$/mg;
type ChildProcessError = {code: number | undefined, stdout: string | undefined, stderr: string | undefined};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	activated = true;
	_context = context;
	context.subscriptions.push(outputChannel);
	const previousVersion = context.globalState.get<string>('extensionVersion');
	let upgradedFromMypyls = false;
	if (previousVersion && semver.valid(previousVersion) && semver.lt(previousVersion, '0.2.0')) {
		upgradedFromMypyls = true;
	}
	const extension = vscode.extensions.getExtension('matangover.mypy');
	const currentVersion = extension?.packageJSON.version;
	context.globalState.update('extensionVersion', currentVersion);

	output(`Mypy extension activated, version ${currentVersion}`);
	if (extension?.extensionKind === vscode.ExtensionKind.Workspace) {
		output('Running remotely');
	}

	statusBarItem = vscode.window.createStatusBarItem();
	context.subscriptions.push(statusBarItem);
	statusBarItem.text = "$(gear~spin) mypy";

	output('Registering listener for interpreter changed event');
	const pythonExtension = await getPythonExtension(undefined);
	if (pythonExtension !== undefined) {
		if (pythonExtension.exports.settings.onDidChangeExecutionDetails) {
			const handler = pythonExtension.exports.settings.onDidChangeExecutionDetails(activeInterpreterChanged);
			context.subscriptions.push(handler);
			output('Listener registered');
		}
	}
	// TODO: add 'Mypy: recheck workspace' command.

	await migrateDeprecatedSettings(vscode.workspace.workspaceFolders);
	if (upgradedFromMypyls) {
		output('Extension upgraded, migrating settings');
		await migrateDefaultMypylsToDmypy();
	}

	await forEachFolder(vscode.workspace.workspaceFolders, folder => checkWorkspace(folder.uri));
	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(workspaceFoldersChanged),
		vscode.workspace.onDidSaveTextDocument(documentSaved),
		vscode.workspace.onDidDeleteFiles(filesDeleted),
		vscode.workspace.onDidRenameFiles(filesRenamed),
		vscode.workspace.onDidCreateFiles(filesCreated),
		vscode.workspace.onDidChangeConfiguration(configurationChanged)
	);
}

async function migrateDeprecatedSettings(folders?: readonly vscode.WorkspaceFolder[]) {
	const migration = { needed: false, failed: [] }
	// Migrate workspace folder settings.
	if (folders !== undefined) {
		for (let folder of folders) {
			await migrate(folder, vscode.ConfigurationTarget.WorkspaceFolder, migration, `settings for workspace folder '${folder.name}'`);
		}
	}
	// Migrate workspace settings.
	await migrate(null, vscode.ConfigurationTarget.Workspace, migration, 'workspace settings');
	// Migrate user settings.
	await migrate(null, vscode.ConfigurationTarget.Global, migration, 'user settings');

	if (migration.needed) {
		if (migration.failed.length == 0) {
			vscode.window.showInformationMessage(
				'The Mypy extension now uses the mypy daemon (dmypy) instead of mypyls. ' +
				'Your mypy.executable settings have been migrated to the new setting: ' +
				'mypy.dmypyExecutable.'
			);
		} else {
			vscode.window.showInformationMessage(
				'The Mypy extension now uses the mypy daemon (dmypy) instead of mypyls. ' +
				'Please use the new mypy.dmypyExecutable setting instead of mypy.executable. ' +
				'The deprecated mypy.executable setting was found in: ' +
				migration.failed.join(", ") + '.'
			);
		}
	}
}

async function migrate(scope: vscode.WorkspaceFolder | null, target: vscode.ConfigurationTarget, migration: { needed: boolean; failed: string[]; }, targetLabel: string) {
	const config = vscode.workspace.getConfiguration('mypy', scope);
	const dmypySetting = config.inspect<string>('dmypyExecutable');
	const existingDmypy = getValue(dmypySetting, target);
	if (existingDmypy !== undefined) {
		return;
	}

	const mypylsSetting = config.inspect<string>('executable');
	const mypylsExecutable = getValue(mypylsSetting, target);
	if (mypylsExecutable === undefined) {
		return;
	}

	migration.needed = true;
	const dmypyExecutable = getDmypyExecutableFromMypyls(mypylsExecutable);
	let dmypyExecutableExpanded = untildify(dmypyExecutable);
	if (scope !== null) {
		dmypyExecutableExpanded = dmypyExecutableExpanded.replace('${workspaceFolder}', scope.uri.fsPath);
	}
	if (fs.existsSync(dmypyExecutableExpanded)) {
		await config.update('dmypyExecutable', dmypyExecutable, target);
		await config.update('executable', undefined, target);
	} else {
		migration.failed.push(targetLabel);
	}
}

async function migrateDefaultMypylsToDmypy() {
	const dmypyUserSetting = vscode.workspace.getConfiguration("mypy").inspect<string>("dmypyExecutable")?.globalValue;
	if (dmypyUserSetting !== undefined) {
		// dmypyExecutable is already defined in User settings. Do nothing.
		return;
	}

	const dmypyInPath = (await lookpath('dmypy')) !== undefined;
	if (dmypyInPath) {
		// dmypy is available on PATH. Notify user and do nothing.
		vscode.window.showInformationMessage(
			'The Mypy extension has been updated. It will now use the mypy daemon (found on your ' +
			'PATH) instead of the mypy language server.'
		);
		return;
	}

	const mypyls = getDefaultMypylsExecutable();
	let dmypyFound = false;
	if (fs.existsSync(mypyls)) {
		// mypyls is installed in the default location, try using dmypy from the mypyls
		// installation.
		const dmypyExecutable = getDmypyExecutableFromMypyls(mypyls);
		output(`Dmypy guess: ${dmypyExecutable}`);
		if (fs.existsSync(dmypyExecutable)) {
			await vscode.workspace.getConfiguration('mypy').update(
				'dmypyExecutable',
				dmypyExecutable,
				vscode.ConfigurationTarget.Global
			);
			dmypyFound = true;
		}
	}
	if (!dmypyFound) {
		vscode.window.showInformationMessage(
			'The Mypy extension has been updated. It now uses the mypy daemon (dmypy), however dmypy ' +
			'was not found on your system. Please install mypy on your PATH or change the ' +
			'mypy.dmypyExecutable setting.'
		);
	}
}

function getDefaultMypylsExecutable() {
	let executable = (process.platform === 'win32') ?
		'~\\.mypyls\\Scripts\\mypyls.exe' :
		'~/.mypyls/bin/mypyls';
	return untildify(executable);
}

function getValue<T>(
	config: { globalValue?: T, workspaceValue?: T, workspaceFolderValue?: T } | undefined,
	target: vscode.ConfigurationTarget) {
	if (config === undefined) {
		// Configuration does not exist.
		return undefined;
	} else if (target == vscode.ConfigurationTarget.Global) {
		return config.globalValue;
	} else if (target == vscode.ConfigurationTarget.Workspace) {
		return config.workspaceValue;
	} else if (target == vscode.ConfigurationTarget.WorkspaceFolder) {
		return config.workspaceFolderValue;
	}
}

export async function deactivate(): Promise<void> {
	activated = false;
	output(`Mypy extension deactivating, shutting down daemons...`);
	await forEachFolder(vscode.workspace.workspaceFolders, folder => stopDaemon(folder.uri));
	output(`Mypy daemons stopped, extension deactivated`);
}

async function workspaceFoldersChanged(e: vscode.WorkspaceFoldersChangeEvent): Promise<void> {
	const format = (folders: readonly vscode.WorkspaceFolder[]) => folders.map(f => f.name).join(", ") || "none";
	output(`Workspace folders changed. Added: ${format(e.added)}. Removed: ${format(e.removed)}.`);

	await forEachFolder(e.removed, async folder => {
		await stopDaemon(folder.uri);
		diagnostics.get(folder.uri)?.dispose();
		diagnostics.delete(folder.uri);
		pythonExtensionInitialized.delete(folder.uri);
	});
	await migrateDeprecatedSettings(e.added);
	await forEachFolder(e.added, folder => checkWorkspace(folder.uri));
}

async function forEachFolder<T>(folders: readonly T[] | undefined, func: (folder: T) => Promise<any>, ignoreErrors = true) {
	if (folders === undefined) {
		return;
	}

	// Run the function for each callback, and catch errors if any.
	// Use allSettled instead of Promise.all to always await all Promises, even if one rejects.
	const promises = folders.map(func);
	const results = await allSettled(promises);
	if (ignoreErrors) {
		return;
	}
	
	const rejections = results.filter(r => r.status === "rejected");
	const errors = rejections.map(r => (r as PromiseRejection<any>).reason);
	if (errors.length > 0) {
		throw errors;
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

type DmypyCommand = 'start' | 'restart' | 'status' | 'stop' | 'kill' | 'check' | 'run' | 'recheck' | 'suggest' | 'hang' | 'daemon' | 'help';

async function runDmypy(
	folder: vscode.Uri,
	dmypyCommand: DmypyCommand,
	mypyArgs: string[] = [],
	warnIfFailed = false,
	successfulExitCodes?: number[],
	addPythonExecutableArgument = false,
	currentCheck?: number,
): Promise<{ success: boolean, stdout: string | null }> {

	let dmypyGlobalArgs: string[] = [];
	let dmypyCommandArgs: string[] = [];
	// Store the dmypy status file in the extension's workspace storage folder, instead of the
	// default location which is .dmypy.json in the cwd.
	if (_context?.storageUri !== undefined) {
		fs.mkdirSync(_context.storageUri.fsPath, {recursive: true});
		const folderHash = crypto.createHash('sha1').update(folder.toString()).digest('hex');
		const statusFileName = `dmypy-${folderHash}.json`;
		const statusFilePath = path.join(_context.storageUri.fsPath, statusFileName);
		dmypyGlobalArgs = ["--status-file", statusFilePath];
		const commandsSupportingLog: DmypyCommand[] = ["start", "restart", "run"];
		if (commandsSupportingLog.includes(dmypyCommand)) {
			const logFileName = `dmypy-${folderHash}.log`;
			const logFilePath = path.join(_context.storageUri.fsPath, logFileName);
			dmypyCommandArgs = ['--log-file', logFilePath];
		}
	}

	const activeInterpreter = await getActiveInterpreter(folder, currentCheck);
	const mypyConfig = vscode.workspace.getConfiguration('mypy', folder);
	let executable: string | undefined;
	const runUsingActiveInterpreter = mypyConfig.get<boolean>('runUsingActiveInterpreter');
	let executionArgs: string[] = [];
	if (runUsingActiveInterpreter) {
		executable = activeInterpreter;
		executionArgs = ["-m", "mypy.dmypy"];
		if (executable === undefined) {
			warn(
				"Could not run mypy: no active interpreter. Please activate an interpreter or " +
				"switch off the mypy.runUsingActiveInterpreter setting.",
				warnIfFailed, currentCheck
			);
		}
	} else {
		executable = await getDmypyExecutable(folder, warnIfFailed, currentCheck);
	}
	if (executable === undefined) {
		return { success: false, stdout: null };
	}

	if (addPythonExecutableArgument && activeInterpreter) {
		mypyArgs = [...mypyArgs, '--python-executable', activeInterpreter];
	}

	const args = [...executionArgs, ...dmypyGlobalArgs, dmypyCommand, ...dmypyCommandArgs];
	if (mypyArgs.length > 0) {
		args.push("--", ...mypyArgs);
	}
	const command = [executable, ...args].map(quote).join(" ");
	output(`Running dmypy in folder ${folder.fsPath}\n${command}`, currentCheck);
	try {
		const result = await spawn(
			executable,
			args,
			{
				cwd: folder.fsPath,
				capture: ['stdout', 'stderr'],
				successfulExitCodes
			}
		);
		if (result.code == 1 && result.stderr) {
			// This might happen when running using `python -m mypy.dmypy` and some error in the
			// interpreter occurs, such as import error when mypy is not installed.
			let error = '';
			if (runUsingActiveInterpreter) {
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
	} catch (exception) {
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
				if ((ex.stderr as string).indexOf('Daemon crashed!') != -1) {
					error = 'the mypy daemon crashed. This is probably a bug in mypy itself, ' + 
					'see Output panel for details. The daemon will be restarted automatically.'
					showDetailsButton = true;
				} else if ((ex.stderr as string).indexOf('There are no .py[i] files in directory') != -1) {
					// Swallow this error. This may happen if one workspace folder contains
					// Python files and another folder doesn't, or if a workspace contains Python
					// files that are not reachable from the target directory.
					return { success: true, stdout: '' };
				}
			}
		}
		warn(`Error running mypy in ${folder.fsPath}: ${error}`, warnIfFailed, currentCheck, showDetailsButton);
		return { success: false, stdout: null };
	}
}

async function getDmypyExecutable(folder: vscode.Uri, warnIfFailed: boolean, currentCheck?: number): Promise<string | undefined> {
	const mypyConfig = vscode.workspace.getConfiguration('mypy', folder);
	let dmypyExecutable = mypyConfig.get<string>('dmypyExecutable') ?? 'dmypy';
	const isCommand = path.parse(dmypyExecutable).dir === '';
	if (isCommand) {
		const executable = await lookpath(dmypyExecutable);
		if (executable === undefined) {
			warn(
				`The mypy daemon executable ('${dmypyExecutable}') was not found on your PATH. ` +
				`Please install mypy or adjust the mypy.dmypyExecutable setting.`,
				warnIfFailed, currentCheck
			)
			return undefined;
		}
		dmypyExecutable = executable;
	} else {
		dmypyExecutable = untildify(dmypyExecutable).replace('${workspaceFolder}', folder.fsPath)
		if (!fs.existsSync(dmypyExecutable)) {
			warn(
				`The mypy daemon executable ('${dmypyExecutable}') was not found. ` +
				`Please install mypy or adjust the mypy.dmypyExecutable setting.`,
				warnIfFailed, currentCheck
			)
			return undefined;
		}
	}
	return dmypyExecutable;
}

function documentSaved(document: vscode.TextDocument): void {
	const folder = vscode.workspace.getWorkspaceFolder(document.uri);
	if (!folder) {
		return;
	}

	if (document.languageId == "python" || isMaybeConfigFile(folder, document.fileName)) {
		output(`Document saved: ${document.uri.fsPath}`);
		checkWorkspace(folder.uri);
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

function configurationChanged(event: vscode.ConfigurationChangeEvent): void {
	const folders = vscode.workspace.workspaceFolders ?? [];
	const affectedFolders = folders.filter(folder => (
		event.affectsConfiguration("mypy", folder) ||
		event.affectsConfiguration("python.pythonPath", folder)
	));
	const affectedFoldersString = affectedFolders.map(f => f.uri.fsPath).join(", ");
	output(`Mypy settings changed: ${affectedFoldersString}`);
	forEachFolder(affectedFolders, folder => checkWorkspace(folder.uri));
}

async function checkWorkspace(folder: vscode.Uri) {
	// Don't check the same workspace folder more than once at the same time.
	await lock.acquire(folder.fsPath, () => checkWorkspaceInternal(folder));
}

async function checkWorkspaceInternal(folder: vscode.Uri) {
	if (!activated) {
		// This can happen if a check was queued right before the extension was deactivated.
		// We don't want to check in that case since it would cause a zombie daemon.
		output(`Extension is not activated, not checking: ${folder.fsPath}`);
		return;
	}

	statusBarItem.show();
	activeChecks++;
	const currentCheck = checkIndex;
	checkIndex++;

	output(`Check workspace: ${folder.fsPath}`, currentCheck);
	const mypyConfig = vscode.workspace.getConfiguration("mypy", folder);
	let targets = mypyConfig.get<string[]>("targets", []);
	const mypyArgs = [...targets, '--show-column-numbers', '--no-error-summary', '--no-pretty', '--no-color-output'];
	const configFile = mypyConfig.get<string>("configFile");
	if (configFile) {
		output(`Using config file: ${configFile}`, currentCheck);
		mypyArgs.push('--config-file', configFile);
	}
	const result = await runDmypy(
		folder,
		'run',
		mypyArgs,
		true,
		[0, 1],
		true,
		currentCheck
	);

	activeChecks--;
	if (activeChecks == 0) {
		statusBarItem.hide();
	}

	if (result.stdout !== null) {
		output(`Mypy output:\n${result.stdout ?? "\n"}`, currentCheck);
	}
	const diagnostics = getWorkspaceDiagnostics(folder);
	diagnostics.clear();
	if (result.success && result.stdout) {
		let fileDiagnostics = new Map<vscode.Uri, vscode.Diagnostic[]>();
		let match: RegExpExecArray | null;
		while ((match = mypyOutputPattern.exec(result.stdout)) !== null) {
			const groups = match.groups as { file: string, line: string, column?: string, type: string, message: string };
			const fileUri = vscode.Uri.file(path.join(folder.fsPath, groups.file));
			if (!fileDiagnostics.has(fileUri)) {
				fileDiagnostics.set(fileUri, []);
			}
			const thisFileDiagnostics = fileDiagnostics.get(fileUri)!;
			const line = parseInt(groups.line) - 1;
			const column = parseInt(groups.column || '1') - 1;
			const diagnostic = new vscode.Diagnostic(
				new vscode.Range(line, column, line, column),
				groups.message,
				groups.type === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Information
			);
			diagnostic.source = 'mypy';
			thisFileDiagnostics.push(diagnostic);
		}
		diagnostics.set(Array.from(fileDiagnostics.entries()));
	}
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
	let path = await getPythonPathFromPythonExtension(folder, currentCheck);
	if (path === undefined) {
		path = vscode.workspace.getConfiguration('python', folder).get<string>('pythonPath');
		output(`Using python.pythonPath: ${path}`, currentCheck);
		if (!path) {
			path = undefined;
		}
	}
	return path;
}
// The VS Code Python extension manages its own internal store of configuration settings.
// The setting that was traditionally named "python.pythonPath" has been moved to the
// Python extension's internal store. This function is mostly taken from pyright.
async function getPythonPathFromPythonExtension(
    scopeUri: vscode.Uri | undefined, currentCheck: number | undefined
): Promise<string | undefined> {
    try {
        const extension = await getPythonExtension(currentCheck);
		if (extension === undefined) {
			return;
		}

		const execDetails = await extension.exports.settings.getExecutionDetails(scopeUri);
		let result: string | undefined;
		if (execDetails.execCommand && execDetails.execCommand.length > 0) {
			result = execDetails.execCommand[0];
		}

		if (result === "python" && !pythonExtensionInitialized.has(scopeUri)) {
			// There is a bug in the Python extension which returns sometimes 'python'
			// while the extension is initializing. This can cause ugly errors when the mypy
			// extension runs before the interpreter is initialized.
			// See https://github.com/microsoft/vscode-python/issues/15467
			// Give the Python extension 5 more seconds to properly load (hopefully).
			output(`Got 'python' as Python path, giving the Python extension 5 more seconds to load`, currentCheck);
			await sleep(5000);
			pythonExtensionInitialized.add(scopeUri);
			return getPythonPathFromPythonExtension(scopeUri, currentCheck)
		} else {
			pythonExtensionInitialized.add(scopeUri);
		}

		output(`Received python path from Python extension: ${result}`, currentCheck);
		return result;
    } catch (error) {
        output(
            `Exception when reading python path from Python extension: ${JSON.stringify(error)}`,
			currentCheck
        );
    }

    return undefined;
}

function activeInterpreterChanged(resource: vscode.Uri | undefined) {
	output(`Active interpreter changed for resource: ${resource?.fsPath}`);
	if (resource === undefined) {
		vscode.workspace.workspaceFolders?.map(folder => checkWorkspace(folder.uri));
	} else {
		const folder = vscode.workspace.getWorkspaceFolder(resource);
		if (folder) {
			checkWorkspace(folder.uri);
		}
	}
}

async function getPythonExtension(currentCheck: number | undefined) {
	const extension = vscode.extensions.getExtension('ms-python.python');
	if (!extension) {
		output('Python extension not found', currentCheck);
		return undefined;
	}

	if (!extension.packageJSON?.featureFlags?.usingNewInterpreterStorage) {
		return undefined
	}

	if (!extension.isActive) {
		output('Waiting for Python extension to load', currentCheck);
		await extension.activate();
		output('Python extension loaded', currentCheck);
	}
	return extension;
}

async function warn(warning: string, show=false, currentCheck?: number, detailsButton=false) {
	output(warning, currentCheck);
	if (show) {
		const items = detailsButton ? ["Details"] : [];
		const result = await vscode.window.showWarningMessage(warning, ...items);
		if (result === "Details") {
			outputChannel.show();
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
		if (path.endsWith(".py") || path.endsWith(".pyi")) {
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
	await forEachFolder(Array.from(folders), folder => checkWorkspace(folder));
}

function output(line: string, currentCheck?: number) {
	if (currentCheck !== undefined) {
		line = `[${currentCheck}] ${line}`;
	}
	if (DEBUG) {
		var tzoffset = (new Date()).getTimezoneOffset() * 60000;
		var localISOTime = (new Date(Date.now() - tzoffset)).toISOString().slice(0, -1);
		fs.appendFileSync("/tmp/log.txt", `${localISOTime} [${process.pid}] ${line}\n`);
	}
	outputChannel.appendLine(line);
}

function getDmypyExecutableFromMypyls(mypylsExecutable: string): string {
	const name = (process.platform === 'win32') ? 'dmypy.exe' : 'dmypy';
	return path.join(path.dirname(mypylsExecutable), name);
}

function sleep(ms: number) {
	return new Promise<void>(resolve => setTimeout(resolve, ms));
}