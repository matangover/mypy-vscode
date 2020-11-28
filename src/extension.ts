/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';


import { workspace, ExtensionContext, StatusBarItem, window, extensions } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient';
import * as fs from 'fs';
import untildify = require('untildify');

let statusBarItem: StatusBarItem;

export function activate(context: ExtensionContext) {
	// Save current extension version, in order to detect upgrades in the future.
	const extension = extensions.getExtension('matangover.mypy');
	if (extension) {
		const currentVersion = extension.packageJSON.version;
		context.globalState.update('extensionVersion', currentVersion);
	}

	let executableSetting = workspace.getConfiguration('mypy').get<string>('executable');
	if (executableSetting === '' || executableSetting === undefined) {
		executableSetting = (process.platform === 'win32') ?
			'~\\.mypyls\\Scripts\\mypyls.exe' :
			'~/.mypyls/bin/mypyls';
	}

	let executable = untildify(executableSetting);
	if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
		// We only support a single workspace folder for now.
		const workspaceFolder = workspace.workspaceFolders[0].uri.fsPath;
		executable = executable.replace('${workspaceFolder}', workspaceFolder);
	} else {
		// No workspace is open.
		if (executable.indexOf('${workspaceFolder}') != -1) {
			window.showWarningMessage(
				'Cannot start mypyls: mypy.executable contains ${workspaceFolder} but no workspace is open.'
			);
			return;
		}
	}
	if (!fs.existsSync(executable)) {
		window.showWarningMessage(
			'mypyls not found. Please install mypyls and reload. See extension installation instructions. ' +
			`Looked for mypyls at: ${executable}`);
		return;
	}
	const serverOptions: ServerOptions = {
        command: executable,
        args: ['-v'],
	};
	const clientOptions: LanguageClientOptions = {
		documentSelector: [{
			language: 'python',
			scheme: 'file'
		}],
        synchronize: {
            configurationSection: 'mypy'
        }
	}
	const client = new LanguageClient('mypy', serverOptions, clientOptions);

	context.subscriptions.push(client.start());

	statusBarItem = window.createStatusBarItem();
	context.subscriptions.push(statusBarItem);
	
	client.onReady().then(() => {
		client.onNotification('mypyls/reportProgress', (message: string | null) => {
			if (message) {
				statusBarItem.text = message;
				statusBarItem.show();
			} else {
				statusBarItem.hide();
			}
		});
	}).catch(reason => {
		window.showErrorMessage(
			`Couldn't launch mypy language server executable: ${reason}`);
	});
}

