import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child-process-promise';
import * as fs from 'fs';
import { lookpath } from 'lookpath';
import untildify = require('untildify');
import * as semver from 'semver';
import { quote } from 'shlex';

const diagnostics = new Map<vscode.Uri, vscode.DiagnosticCollection>();
const outputChannel = vscode.window.createOutputChannel('Mypy');
let _context: vscode.ExtensionContext | null;

export const mypyOutputPattern = /^(?<file>[^:]+):(?<line>\d+)(:(?<column>\d+))?: (?<type>\w+): (?<message>.*)$/mg;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
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

	outputChannel.appendLine(`Mypy extension activated, version ${currentVersion}`);
	if (extension?.extensionKind === vscode.ExtensionKind.Workspace) {
		outputChannel.appendLine('Running remotely');
	}

	// TODO: add setting to use active Python interpreter to run mypy (mypy installed in project)
	// TODO: listen to modified settings (or Python interpreter) and restart server
	// TODO: add 'Mypy: recheck workspace' command.

	await migrateDeprecatedSettings(vscode.workspace.workspaceFolders);
	if (upgradedFromMypyls) {
		await migrateDefaultMypylsToDmypy();
	}

	if (vscode.workspace.workspaceFolders) {
		await Promise.all(vscode.workspace.workspaceFolders.map(folder => checkWorkspace(folder.uri)));
	}
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(workspaceFoldersChanged));
	context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(documentSaved));
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(configurationChanged));
	outputChannel.appendLine('Registering listener for interpreter changed event')
	const pythonExtension = await getPythonExtension();
	if (pythonExtension !== undefined) {
		if (pythonExtension.exports.settings.onDidChangeExecutionDetails) {
			const handler = pythonExtension.exports.settings.onDidChangeExecutionDetails(activeInterpreterChanged);
			_context?.subscriptions.push(handler);
		}
	}
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
				'Your mypy.executable settings have been migrated to the new mypy.dmypyExecutable.'
			);
		} else {
			vscode.window.showInformationMessage(
				'The Mypy extension now uses the mypy daemon (dmypy) instead of mypyls. ' +
				'Please use the new mypy.dmypyExecutable setting instead of mypy.executable. ' +
				'The deprecated mypy.executable settings was found in: ' +
				migration.failed.join(", ") + '.'
			);
		}
	}
}

async function migrate(scope: vscode.WorkspaceFolder | null, target: vscode.ConfigurationTarget, migration: { needed: boolean; failed: string[]; }, targetLabel: string) {
	const config = vscode.workspace.getConfiguration('mypy', scope);
	const mypylsSetting = config.inspect<string>('executable');
	const mypylsExecutable = getValue(mypylsSetting, target);
	if (mypylsExecutable === undefined) {
		return;
	}

	migration.needed = true;
	const dmypyExecutable = path.join(path.dirname(mypylsExecutable), 'dmypy');
	if (fs.existsSync(dmypyExecutable)) {
		await config.update('dmypyExecutable', dmypyExecutable, target);
		await config.update('executable', undefined, target);
	} else {
		migration.failed.push(targetLabel);
	}
}

async function migrateDefaultMypylsToDmypy() {
	const dmypyUserSetting = vscode.workspace.getConfiguration("mypy").inspect<string>("dmypyExecutable")?.globalValue;
	if (dmypyUserSetting !== undefined) {
		return;
	}

	const dmypyInPath = (await lookpath('dmypy')) !== undefined;
	if (dmypyInPath) {
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
		const dmypyExecutable = path.join(path.dirname(mypyls), 'dmypy');
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
	outputChannel.appendLine(`Mypy extension deactivating, shutting down daemons...`);
	const folders = vscode.workspace.workspaceFolders;
	if (folders) {
		await Promise.all(folders.map(folder => stopDaemon(folder.uri)));
	}
	outputChannel.appendLine(`Mypy daemons stopped, extension deactivated`);
}

async function workspaceFoldersChanged(e: vscode.WorkspaceFoldersChangeEvent): Promise<void> {
	await Promise.all(e.removed.map(folder => stopDaemon(folder.uri)));
	await migrateDeprecatedSettings(e.added);
	await Promise.all(e.added.map(folder => checkWorkspace(folder.uri)));
}


async function stopDaemon(folder: vscode.Uri): Promise<void> {
	outputChannel.appendLine(`Stop daemon: ${folder.fsPath}`);

	await runDmypy(folder, ['stop']);
}

async function runDmypy(folder: vscode.Uri, args: string[], warnIfFailed=false, successfulExitCodes?: number[], addPythonExecutableArgument=false):
	Promise<{ success: boolean, stdout: string | null }> {

	const activeInterpreter = await getActiveInterpreter(folder);
	const mypyConfig = vscode.workspace.getConfiguration('mypy', folder);
	let executable: string | undefined;
	if (mypyConfig.get<boolean>('runUsingActiveInterpreter')) {
		executable = activeInterpreter;
		args = ["-m", "mypy.dmypy", ...args];
		if (executable === undefined) {
			warn(
				"Could not run mypy: no active interpreter. Please activate an interpreter or " +
				"switch off the mypy.runUsingActiveInterpreter setting.",
				warnIfFailed
			);
		}
	} else {
		executable = await getDmypyExecutable(folder, warnIfFailed);
	}
	if (executable === undefined) {
		return { success: false, stdout: null };
	}

	if (addPythonExecutableArgument && activeInterpreter) {
		args = [...args, '--python-executable', activeInterpreter];
	}

	const command = [executable, ...args].map(quote).join(" ");
	outputChannel.appendLine(`Running dmypy in folder ${folder.fsPath}\n${command}`);
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
		return { success: true, stdout: result.stdout };
	} catch (ex) {
		warn(`Error running mypy daemon: ${ex}`, warnIfFailed);
		if (ex.name === 'ChildProcessError') {
			if (ex.stdout) {
				outputChannel.appendLine(`stdout:\n${ex.stdout}`);
			}
			if (ex.stderr) {
				outputChannel.appendLine(`stderr:\n${ex.stderr}`);
				// TODO: if stderr contains `ModuleNotFoundError: No module named 'mypy'` then show error - mypy not installed
			}
		}
		return { success: false, stdout: null };
	}
}

async function getDmypyExecutable(folder: vscode.Uri, warnIfFailed: boolean): Promise<string | undefined> {
	const mypyConfig = vscode.workspace.getConfiguration('mypy', folder);
	let dmypyExecutable = mypyConfig.get<string>('dmypyExecutable') ?? 'dmypy';
	const isCommand = path.parse(dmypyExecutable).dir === '';
	if (isCommand) {
		const executable = await lookpath(dmypyExecutable);
		if (executable === undefined) {
			warn(
				`The mypy daemon executable ('${dmypyExecutable}') was not found on your PATH. ` +
				`Please install mypy or adjust the mypy.dmypyExecutable setting.`,
				warnIfFailed
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
				warnIfFailed
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
		checkWorkspace(folder.uri);
	}
}

function isMaybeConfigFile(folder: vscode.WorkspaceFolder, file: string) {
	const name = path.basename(file);
	if (name == "mypy.ini" || name == ".mypy.ini" || name == "setup.cfg" || name == "config") {
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

function configurationChanged(event: vscode.ConfigurationChangeEvent): void {
	if (event.affectsConfiguration("mypy") || event.affectsConfiguration("python.pythonPath")) {
		vscode.workspace.workspaceFolders?.map(folder => checkWorkspace(folder.uri));
	}
}

async function checkWorkspace(folder: vscode.Uri) {
	outputChannel.appendLine(`Check workspace: ${folder.fsPath}`);
	const mypyConfig = vscode.workspace.getConfiguration("mypy", folder);
	let targets = mypyConfig.get<string[]>("targets");
	if (!targets) {
		// No targets, check the entire workspace folder. Use an empty string rather than "." to
		// allow overriding using the `files` option in the the mypy config file.
		targets = [""];
	}
	const args = ['run', '--', ...targets, '--show-column-numbers', '--no-error-summary', '--no-pretty', '--no-color-output']
	const configFile = mypyConfig.get<string>("configFile");
	if (configFile) {
		outputChannel.appendLine(`Using config file: ${configFile}`);
		args.push('--config-file', configFile);
	}
	// TODO: progress status bar
	const result = await runDmypy(folder, args, true, [0, 1], true);
	if (result.stdout !== null) {
		outputChannel.appendLine('Mypy output:');
		outputChannel.appendLine(result.stdout ?? "\n");
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

async function getActiveInterpreter(folder: vscode.Uri) {
	let path = await getPythonPathFromPythonExtension(folder);
	if (path === undefined) {
		path = vscode.workspace.getConfiguration('python', folder).get<string>('pythonPath');
		outputChannel.appendLine(`Using python.pythonPath: ${path}`);
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
    scopeUri: vscode.Uri | undefined,
): Promise<string | undefined> {
    try {
        const extension = await getPythonExtension();
		if (extension === undefined) {
			return;
		}

		const execDetails = await extension.exports.settings.getExecutionDetails(scopeUri);
		let result: string | undefined;
		if (execDetails.execCommand && execDetails.execCommand.length > 0) {
			result = execDetails.execCommand[0];
		}

		outputChannel.appendLine(`Received python path from Python extension: ${result}`);
		return result;
    } catch (error) {
        outputChannel.appendLine(
            `Exception when reading python path from Python extension: ${JSON.stringify(error)}`
        );
    }

    return undefined;
}

function activeInterpreterChanged(resource: vscode.Uri | undefined) {
	if (resource === undefined) {
		vscode.workspace.workspaceFolders?.map(folder => checkWorkspace(folder.uri));
	} else {
		const folder = vscode.workspace.getWorkspaceFolder(resource);
		if (folder) {
			checkWorkspace(folder.uri);
		}
	}
}

async function getPythonExtension() {
	const extension = vscode.extensions.getExtension('ms-python.python');
	if (!extension) {
		outputChannel.appendLine('Python extension not found');
		return undefined;
	}

	if (!extension.packageJSON?.featureFlags?.usingNewInterpreterStorage) {
		return undefined
	}

	if (!extension.isActive) {
		outputChannel.appendLine('Waiting for Python extension to load');
		await extension.activate();
		outputChannel.appendLine('Python extension loaded');
	}
	return extension;
}

function warn(warning: string, show=false) {
	outputChannel.appendLine(warning);
	if (show) {
		vscode.window.showWarningMessage(warning);
	}
}