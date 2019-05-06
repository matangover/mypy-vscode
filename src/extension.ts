/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';


import { workspace, ExtensionContext, StatusBarItem, window } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient';

let statusBarItem: StatusBarItem;

export function activate(context: ExtensionContext) {
    const executable = workspace.getConfiguration("pyls").get<string>("executable");
	const serverOptions: ServerOptions = {
        command: executable || 'pyls',
        args: ['-v'],
	};
	const clientOptions: LanguageClientOptions = {
		documentSelector: ['python'],
        synchronize: {
            configurationSection: 'pyls'
        }
	}
	const client = new LanguageClient('pyls', serverOptions, clientOptions);

	context.subscriptions.push(client.start());

	statusBarItem = window.createStatusBarItem();
	context.subscriptions.push(statusBarItem);
	
	client.onReady().then(() => {
		client.onNotification('pyls/reportProgress', (message: string | null) => {
			if (message) {
				statusBarItem.text = message;
				statusBarItem.show();
			} else {
				statusBarItem.hide();
			}
		});
	})
}

