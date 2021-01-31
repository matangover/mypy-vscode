import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child-process-promise';
import * as fs from 'fs';
import {lookpath} from 'lookpath';
import untildify = require('untildify');
import * as semver from 'semver';

const runningDaemons = new Set<vscode.Uri>();
const diagnostics = new Map<vscode.Uri, vscode.DiagnosticCollection>();
const outputChannel = vscode.window.createOutputChannel('Mypy');
let _context: vscode.ExtensionContext | null;
let upgradedFromMypyls = false;

export const mypyOutputPattern = /^(?<file>[^:]+):(?<line>\d+)(:(?<column>\d+))?: (?<type>\w+): (?<message>.*)$/mg;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	_context = context;
	context.subscriptions.push(outputChannel);
	const previousVersion = context.globalState.get<string>('extensionVersion');
	if (previousVersion && semver.valid(previousVersion) && semver.lt(previousVersion, '0.2.0')) {
		upgradedFromMypyls = true;
	}
	const extension = vscode.extensions.getExtension('matangover.mypy');
	const currentVersion = extension?.packageJSON.version;
	outputChannel.appendLine(`Mypy extension activated, version ${currentVersion}`);
	context.globalState.update('extensionVersion', currentVersion);

	if (extension?.extensionKind === vscode.ExtensionKind.Workspace) {
		outputChannel.appendLine('Running remotely');
	}


	// TODO: log extension version and mypy version to output
	// TODO: add setting to use active Python interpreter to run mypy (mypy installed in project)
	// TODO: listen to modified settings (or Python interpreter) and restart server

	if (vscode.workspace.workspaceFolders) {
		await migrateDeprecatedSettings(vscode.workspace.workspaceFolders);
		await Promise.all(vscode.workspace.workspaceFolders.map(folder => startDaemonAndCheckWorkspace(folder.uri)));
	}
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(workspaceFoldersChanged));
	context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(documentSaved));
}

async function migrateDeprecatedSettings(folders: readonly vscode.WorkspaceFolder[]) {
	let migrationNeeded = false;
	let migrationSucceeded = false;
	for (let folder of folders) {
		const mypyConfig = vscode.workspace.getConfiguration('mypy', folder);
		// Try migrating the deprecated executable setting if it exists and is more specific than the new setting.
		const newExecutablePriority = getPriority(mypyConfig.inspect('dmypyExecutable'));
		const deprecatedExecutablePriority = getPriority(mypyConfig.inspect('executable'));
		if (deprecatedExecutablePriority > newExecutablePriority) {
			migrationNeeded = true;
			const migrationTarget = getConfigurationTarget(mypyConfig.inspect('executable'));
			const deprecatedExecutable = mypyConfig.get<string>('executable');
			if (deprecatedExecutable) {
				const dmypyPathGuess = path.join(path.dirname(deprecatedExecutable), 'dmypy');
				if (fs.existsSync(dmypyPathGuess)) {
					await mypyConfig.update('dmypyExecutable', dmypyPathGuess, migrationTarget);
					await mypyConfig.update('executable', undefined, migrationTarget);
					migrationSucceeded = true;
				}
			}
		}
	}
	if (migrationNeeded) {
		if (migrationSucceeded) {
			vscode.window.showInformationMessage(
				'The Mypy extension now uses dmypy instead of mypyls. ' +
				'Your mypy.executable setting has been migrated to the new mypy.dmypyExecutable.'
			);
		} else {
			vscode.window.showInformationMessage(
				'The Mypy extension now uses dmypy instead of mypyls. ' +
				'Please use the new mypy.dmypyExecutable setting instead of mypy.executable.'
			);
		}
	}

	const globalSetting = vscode.workspace.getConfiguration('mypy').inspect('dmypyExecutable')?.globalValue;
	if (upgradedFromMypyls && globalSetting === undefined) {
		// This is the first time the extension is activated since the user has upgraded from
		// a previous version that used mypyls. Migrate the global setting.
		await migrateDefaultMypylsToDmypy();
		upgradedFromMypyls = false;
	}
}

async function migrateDefaultMypylsToDmypy() {
	const dmypyInPath = lookpath('dmypy') !== undefined;
	if (dmypyInPath) {
		vscode.window.showInformationMessage(
			'The Mypy extension has been updated. It will now use the mypy daemon (found in your ' + 
			'PATH) instead of the mypy language server.'
		);
		return;
	}

	const mypyls = getDefaultMypylsExecutable();
	if (fs.existsSync(mypyls)) {
		// mypyls is installed in the default location, try using dmypy from the mypyls
		// installation.
		const dmypyPathGuess = path.join(path.dirname(mypyls), 'dmypy');
		if (fs.existsSync(dmypyPathGuess)) {
			await vscode.workspace.getConfiguration('mypy').update(
				'dmypyExecutable',
				dmypyPathGuess,
				vscode.ConfigurationTarget.Global
			);
		}
	}
}

function getDefaultMypylsExecutable() {
	let executable = (process.platform === 'win32') ?
		'~\\.mypyls\\Scripts\\mypyls.exe' :
		'~/.mypyls/bin/mypyls';
	return untildify(executable);
}

function getPriority(config: ReturnType<vscode.WorkspaceConfiguration['inspect']>): number {
	return getConfigurationTarget(config) ?? 0;
}

function getConfigurationTarget(config: ReturnType<vscode.WorkspaceConfiguration['inspect']>): vscode.ConfigurationTarget | undefined {
	if (config === undefined) {
		// Configuration does not exist.
		return undefined;
	} else if (config.globalValue !== undefined) {
		return vscode.ConfigurationTarget.Global;
	} else if (config.workspaceValue !== undefined) {
		return vscode.ConfigurationTarget.Workspace;
	} else if (config.workspaceFolderValue !== undefined) {
		return vscode.ConfigurationTarget.WorkspaceFolder;
	} else {
		// Configuration is not defined.
		return undefined;
	}
}

export async function deactivate(): Promise<void> {
	outputChannel.appendLine(`Mypy extension deactivating, shutting down daemons...`);
	let daemonStopPromises = Array.from(runningDaemons).map(folder => stopDaemon(folder));
	await Promise.all(daemonStopPromises);
	outputChannel.appendLine(`Mypy daemons stopped, extension deactivated`);
}

async function workspaceFoldersChanged(e: vscode.WorkspaceFoldersChangeEvent): Promise<void> {
	await Promise.all(e.removed.map(folder => stopDaemon(folder.uri)));
	await migrateDeprecatedSettings(e.added);
	await Promise.all(e.added.map(folder => startDaemonAndCheckWorkspace(folder.uri)));
}

async function startDaemon(folder: vscode.Uri): Promise<boolean> {
	outputChannel.appendLine(`Start daemon: ${folder.fsPath}`);
	// TODO: use mypy.configFile setting
	const result = await runDmypy(folder, ['restart', '--', '--show-column-numbers']);
	if (result.success) {
		runningDaemons.add(folder);
	}
	// TODO: Show error if daemon didn't start.
	return result.success;
}

async function startDaemonAndCheckWorkspace(folder: vscode.Uri): Promise<void> {
	const daemonStarted = await startDaemon(folder);
	if (daemonStarted) {
		checkWorkspace(folder);
	}
}

async function stopDaemon(folder: vscode.Uri): Promise<void> {
	outputChannel.appendLine(`Stop daemon: ${folder.fsPath}`);
	if (!runningDaemons.has(folder)) {
		outputChannel.appendLine(`Daemon not running.`);
		return;
	}
	
	const result = await runDmypy(folder, ['stop']);
	if (result.success) {
		runningDaemons.delete(folder);
	}
}

async function runDmypy(folder: vscode.Uri, args: string[], successfulExitCodes?: number[]):
		Promise<{success: boolean, stdout: string | null}> {
	const mypyExecutable = getDmypyExecutable(folder);
	if (mypyExecutable === undefined) {
		return {success: false, stdout: null};
	}
	// TODO: get interpreter path using new API
	// const config = vscode.workspace.getConfiguration('python', folder);
	// const pythonPath = config.pythonPath || 'python';
	// TODO: if python executable does not exist, write error.
	// TODO: allow using global mypy installation using mypy.dmypyExecutable settings
	try {
		// TODO: specify Python executable if running from global mypy.
		const result = await spawn(
			// pythonPath,
			// ['-m', 'mypy.dmypy'].concat(args),
			mypyExecutable,
			args,
			{
				cwd: folder.fsPath,
				capture: ['stdout', 'stderr'],
				successfulExitCodes
			}
		);
		return {success: true, stdout: result.stdout};
	} catch (ex) {
		outputChannel.appendLine('Error running dmypy:');
		outputChannel.appendLine(ex.toString());
		if (ex.name === 'ChildProcessError') {
			if (ex.stdout) {
				outputChannel.appendLine(`stdout:\n${ex.stdout}`);
			}
			if (ex.stderr) {
				outputChannel.appendLine(`stderr:\n${ex.stderr}`);
				// TODO: if stderr contains `ModuleNotFoundError: No module named 'mypy'` then show error - mypy not installed
			}
		}
		return {success: false, stdout: null};
	}
}

function getDmypyExecutable(folder: vscode.Uri): string | undefined {
	const mypyConfig = vscode.workspace.getConfiguration('mypy', folder);
	let dmypyExecutable = mypyConfig.get<string>('dmypyExecutable') ?? 'dmypy';
	const isCommand = path.parse(dmypyExecutable).dir === '';
	if (isCommand) {
		const foundInPath = lookpath(dmypyExecutable) !== undefined;
		if (!foundInPath) {
			vscode.window.showWarningMessage(
				`The mypy daemon executable ('${dmypyExecutable}') was not found on your PATH. ` +
				`Please install mypy or adjust the mypy.dmypyExecutable setting.`
			)
			return undefined;
		}
	} else {
		dmypyExecutable = untildify(dmypyExecutable).replace('${workspaceFolder}', folder.fsPath)
	}
	return dmypyExecutable;
}

function documentSaved(document: vscode.TextDocument): void {
	const folder = vscode.workspace.getWorkspaceFolder(document.uri);
	if (!folder) {
		return;
	}
	checkWorkspace(folder.uri);
}

async function checkWorkspace(folder: vscode.Uri) {
	// TODO: server can only process one request at a time.
	// TODO: progress status bar
	outputChannel.appendLine(`Check workspace: ${folder.fsPath}`);
	// TODO: 'check' can fail if server did not previously start (e.g. mypy was installed while VS Code was open)
	// 		 Better to use 'run', or start the daemon if needed before check.
	// TODO: use mypy.targets setting instead of '.'
	// TODO: use mypy.configFile setting
	const result = await runDmypy(folder, ['check', '--', '.'], [0, 1]);
	const diagnostics = getWorkspaceDiagnostics(folder);
	diagnostics.clear();
	if (result.success && result.stdout) {
		let fileDiagnostics = new Map<vscode.Uri, vscode.Diagnostic[]>();
		let match: RegExpExecArray | null;
		while ((match = mypyOutputPattern.exec(result.stdout)) !== null) {
			const groups = match.groups as {file: string, line: string, column?: string, type: string, message: string};
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
