import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child-process-promise';

const runningDaemons = new Set<vscode.Uri>();
const diagnostics = new Map<vscode.Uri, vscode.DiagnosticCollection>();
const outputChannel = vscode.window.createOutputChannel('Mypy');
let _context: vscode.ExtensionContext | null;

export const mypyOutputPattern = /^(?<file>[^:]+):(?<line>\d+)(:(?<column>\d+))?: (?<type>\w+): (?<message>.*)$/mg;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	_context = context;
	context.subscriptions.push(outputChannel);
	
	if (vscode.workspace.workspaceFolders) {
		await Promise.all(vscode.workspace.workspaceFolders.map(folder => startDaemonAndCheckWorkspace(folder.uri)));
	}
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(workspaceFoldersChanged));
	context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(documentSaved));
}

export async function deactivate(): Promise<void> {
	let daemonStopPromises = Array.from(runningDaemons).map(folder => stopDaemon(folder));
	await Promise.all(daemonStopPromises);
}

function workspaceFoldersChanged(e: vscode.WorkspaceFoldersChangeEvent): void {
	e.added.forEach(folder => startDaemonAndCheckWorkspace(folder.uri));
	e.removed.forEach(folder => stopDaemon(folder.uri));
}

async function startDaemon(folder: vscode.Uri): Promise<boolean> {
	outputChannel.appendLine(`Start daemon: ${folder.fsPath}`);
	const result = await runDmypy(folder, ['restart', '--', '--follow-imports=skip', '--show-column-numbers']);
	if (result.success) {
		runningDaemons.add(folder);
	}
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
	const config = vscode.workspace.getConfiguration('python', folder);
	const pythonPath = config.pythonPath || 'python';

	try {
		const result = await spawn(
			pythonPath,
			['-m', 'mypy.dmypy'].concat(args),
			{
				cwd: folder.fsPath,
				capture: ['stdout', 'stderr'],
				successfulExitCodes
			}
		);
		return {success: true, stdout: result.stdout};
	} catch (ex) {
		outputChannel.appendLine(ex.toString());
		if (ex.name === 'ChildProcessError') {
			if (ex.stdout) {
				outputChannel.appendLine(`stdout:\n${ex.stdout}`);
			}
			if (ex.stderr) {
				outputChannel.appendLine(`stderr:\n${ex.stderr}`);
			}
		}
		return {success: false, stdout: null};
	}
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
	outputChannel.appendLine(`Check workspace: ${folder.fsPath}`);
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