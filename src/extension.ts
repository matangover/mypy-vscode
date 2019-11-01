/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';


import { workspace, ExtensionContext, StatusBarItem, window } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient';
import * as fs from 'fs';
import untildify = require('untildify');

let statusBarItem: StatusBarItem;

export function activate(context: ExtensionContext) {
	let executableSetting = workspace.getConfiguration("mypy").get<string>("executable");
	if (executableSetting === '') {
		executableSetting = (process.platform === "win32") ?
			'~/.mypyls/Scripts/mypyls.exe' :
			'~/.mypyls/bin/mypyls';
	}
	const executable = untildify(executableSetting);
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

