// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { nbformat } from '@jupyterlab/coreutils/lib/nbformat';
import { assert } from 'chai';
import { anything, instance, mock, when } from 'ts-mockito';
import { Matcher } from 'ts-mockito/lib/matcher/type/Matcher';
import * as TypeMoq from 'typemoq';
import * as uuid from 'uuid/v4';
import { Disposable, EventEmitter, Uri } from 'vscode';

import { ApplicationShell } from '../../client/common/application/applicationShell';
import { PythonSettings } from '../../client/common/configSettings';
import { ConfigurationService } from '../../client/common/configuration/service';
import { Logger } from '../../client/common/logger';
import { FileSystem } from '../../client/common/platform/fileSystem';
import { IFileSystem } from '../../client/common/platform/types';
import { IConfigurationService, IDisposable, ILogger } from '../../client/common/types';
import { generateCells } from '../../client/datascience/cellFactory';
import { Commands } from '../../client/datascience/constants';
import { DataScienceErrorHandler } from '../../client/datascience/errorHandler/errorHandler';
import { InteractiveWindowCommandListener } from '../../client/datascience/interactive-window/interactiveWindowCommandListener';
import { InteractiveWindowProvider } from '../../client/datascience/interactive-window/interactiveWindowProvider';
import { JupyterExecutionFactory } from '../../client/datascience/jupyter/jupyterExecutionFactory';
import { JupyterExporter } from '../../client/datascience/jupyter/jupyterExporter';
import { JupyterImporter } from '../../client/datascience/jupyter/jupyterImporter';
import { IInteractiveWindow, INotebookServer, IStatusProvider } from '../../client/datascience/types';
import { InterpreterService } from '../../client/interpreter/interpreterService';
import { KnownSearchPathsForInterpreters } from '../../client/interpreter/locators/services/KnownPathsService';
import { ServiceContainer } from '../../client/ioc/container';
import { noop } from '../core';
import { MockAutoSelectionService } from '../mocks/autoSelector';
import * as vscodeMocks from '../vscode-mock';
import { MockCommandManager } from './mockCommandManager';
import { MockDocumentManager } from './mockDocumentManager';

// tslint:disable:no-any no-http-string no-multiline-string max-func-body-length

function createTypeMoq<T>(tag: string): TypeMoq.IMock<T> {
    // Use typemoqs for those things that are resolved as promises. mockito doesn't allow nesting of mocks. ES6 Proxy class
    // is the problem. We still need to make it thenable though. See this issue: https://github.com/florinn/typemoq/issues/67
    const result = TypeMoq.Mock.ofType<T>();
    (result as any).tag = tag;
    result.setup((x: any) => x.then).returns(() => undefined);
    return result;
}

class MockStatusProvider implements IStatusProvider {
    public set(_message: string, _timeout?: number): Disposable {
        return {
            dispose: noop
        };
    }

    public waitWithStatus<T>(promise: () => Promise<T>, _message: string, _timeout?: number, _canceled?: () => void): Promise<T> {
        return promise();
    }

}

// tslint:disable:no-any no-http-string no-multiline-string max-func-body-length
suite('Interactive window command listener', async () => {
    const interpreterService = mock(InterpreterService);
    const configService = mock(ConfigurationService);
    const knownSearchPaths = mock(KnownSearchPathsForInterpreters);
    const logger = mock(Logger);
    const fileSystem = mock(FileSystem);
    const serviceContainer = mock(ServiceContainer);
    const dummyEvent = new EventEmitter<void>();
    const pythonSettings = new PythonSettings(undefined, new MockAutoSelectionService());
    const disposableRegistry: IDisposable[] = [];
    const interactiveWindowProvider = mock(InteractiveWindowProvider);
    const dataScienceErrorHandler = mock(DataScienceErrorHandler);
    const notebookImporter = mock(JupyterImporter);
    const notebookExporter = mock(JupyterExporter);
    const applicationShell = mock(ApplicationShell);
    const jupyterExecution = mock(JupyterExecutionFactory);
    const interactiveWindow = createTypeMoq<IInteractiveWindow>('Interactive Window');
    const documentManager = new MockDocumentManager();
    const statusProvider = new MockStatusProvider();
    const commandManager = new MockCommandManager();
    const server = createTypeMoq<INotebookServer>('jupyter server');
    let lastFileContents: any;

    suiteSetup(() => {
        vscodeMocks.initialize();
    });
    suiteTeardown(() => {
        noop();
    });

    setup(() => {
        noop();
    });

    teardown(() => {
        documentManager.activeTextEditor = undefined;
        lastFileContents = undefined;
    });

    class FunctionMatcher extends Matcher {
        private func: (obj: any) => boolean;
        constructor(func: (obj: any) => boolean) {
            super();
            this.func = func;
        }
        public match(value: Object): boolean {
            return this.func(value);
        }
        public toString(): string {
            return 'FunctionMatcher';
        }
    }

    function argThat(func: (obj: any) => boolean): any {
        return new FunctionMatcher(func);
    }

    function createCommandListener(): InteractiveWindowCommandListener {
        // Setup defaults
        when(interpreterService.onDidChangeInterpreter).thenReturn(dummyEvent.event);
        when(interpreterService.getInterpreterDetails(argThat(o => !o.includes || !o.includes('python')))).thenReject('Unknown interpreter');

        // Service container needs logger, file system, and config service
        when(serviceContainer.get<IConfigurationService>(IConfigurationService)).thenReturn(instance(configService));
        when(serviceContainer.get<IFileSystem>(IFileSystem)).thenReturn(instance(fileSystem));
        when(serviceContainer.get<ILogger>(ILogger)).thenReturn(instance(logger));
        when(configService.getSettings()).thenReturn(pythonSettings);

        // Setup default settings
        pythonSettings.datascience = {
            allowImportFromNotebook: true,
            jupyterLaunchTimeout: 10,
            jupyterLaunchRetries: 3,
            enabled: true,
            jupyterServerURI: '',
            changeDirOnImportExport: true,
            notebookFileRoot: 'WORKSPACE',
            useDefaultConfigForJupyter: true,
            jupyterInterruptTimeout: 10000,
            searchForJupyter: true,
            showCellInputCode: true,
            collapseCellInputCodeByDefault: true,
            allowInput: true,
            maxOutputSize: 400,
            errorBackgroundColor: '#FFFFFF',
            sendSelectionToInteractiveWindow: false,
            showJupyterVariableExplorer: true,
            variableExplorerExclude: 'module;function;builtin_function_or_method',
            codeRegularExpression: '^(#\\s*%%|#\\s*\\<codecell\\>|#\\s*In\\[\\d*?\\]|#\\s*In\\[ \\])',
            markdownRegularExpression: '^(#\\s*%%\\s*\\[markdown\\]|#\\s*\\<markdowncell\\>)',
            autoPreviewNotebooksInInteractivePane: true,
            enablePlotViewer: true
        };

        when(knownSearchPaths.getSearchPaths()).thenReturn(['/foo/bar']);

        // We also need a file system
        const tempFile = {
            dispose: () => {
                return undefined;
            },
            filePath: '/foo/bar/baz.py'
        };
        when(fileSystem.createTemporaryFile(anything())).thenResolve(tempFile);
        when(fileSystem.deleteDirectory(anything())).thenResolve();
        when(fileSystem.writeFile(anything(), argThat(o => { lastFileContents = o; return true; }))).thenResolve();
        when(fileSystem.arePathsSame(anything(), anything())).thenReturn(true);

        // mocks doesn't work with resolving things that also have promises, so use typemoq instead.
        interactiveWindow.setup(s => s.previewNotebook(TypeMoq.It.isAny())).returns(() => Promise.resolve());

        when(interactiveWindowProvider.getActive()).thenReturn(interactiveWindow.object);
        when(interactiveWindowProvider.getOrCreateActive()).thenResolve(interactiveWindow.object);
        when(notebookImporter.importFromFile(anything())).thenResolve('imported');
        const metadata: nbformat.INotebookMetadata = {
            language_info: {
                name: 'python',
                codemirror_mode: {
                    name: 'ipython',
                    version: 3
                }
            },
            orig_nbformat: 2,
            file_extension: '.py',
            mimetype: 'text/x-python',
            name: 'python',
            npconvert_exporter: 'python',
            pygments_lexer: `ipython${3}`,
            version: 3
        };
        when(notebookExporter.translateToNotebook(anything())).thenResolve(
            {
                cells: [],
                nbformat: 4,
                nbformat_minor: 2,
                metadata: metadata
            }
        );

        if (jupyterExecution.isNotebookSupported) {
            when(jupyterExecution.isNotebookSupported()).thenResolve(true);
        }

        documentManager.addDocument('#%%\r\nprint("code")', 'bar.ipynb');

        when(applicationShell.showInformationMessage(anything(), anything())).thenReturn(Promise.resolve('moo'));
        when(applicationShell.showInformationMessage(anything())).thenReturn(Promise.resolve('moo'));

        const result = new InteractiveWindowCommandListener(
            disposableRegistry,
            instance(interactiveWindowProvider),
            instance(notebookExporter),
            instance(jupyterExecution),
            documentManager,
            instance(applicationShell),
            instance(fileSystem),
            instance(logger),
            instance(configService),
            statusProvider,
            instance(notebookImporter),
            instance(dataScienceErrorHandler));
        result.register(commandManager);

        return result;
    }

    test('Import', async () => {
        createCommandListener();
        when(applicationShell.showOpenDialog(argThat(o => o.openLabel && o.openLabel.includes('Import')))).thenReturn(Promise.resolve([Uri.file('foo')]));
        await commandManager.executeCommand(Commands.ImportNotebook, undefined, undefined);
        assert.ok(documentManager.activeTextEditor, 'Imported file was not opened');
    });
    test('Import File', async () => {
        createCommandListener();
        await commandManager.executeCommand(Commands.ImportNotebook, Uri.file('bar.ipynb'), undefined);
        assert.ok(documentManager.activeTextEditor, 'Imported file was not opened');
    });
    test('Export File', async () => {
        createCommandListener();
        const doc = await documentManager.openTextDocument('bar.ipynb');
        await documentManager.showTextDocument(doc);
        when(applicationShell.showSaveDialog(argThat(o => o.saveLabel && o.saveLabel.includes('Export')))).thenReturn(Promise.resolve(Uri.file('foo')));

        await commandManager.executeCommand(Commands.ExportFileAsNotebook, Uri.file('bar.ipynb'), undefined);
        assert.ok(lastFileContents, 'Export file was not written to');
    });
    test('Export File and output', async () => {
        createCommandListener();
        const doc = await documentManager.openTextDocument('bar.ipynb');
        await documentManager.showTextDocument(doc);
        when(jupyterExecution.connectToNotebookServer(anything(), anything())).thenResolve(server.object);
        server.setup(s => s.execute(TypeMoq.It.isAny(), TypeMoq.It.isAny(), TypeMoq.It.isAnyNumber(), TypeMoq.It.isAny(), TypeMoq.It.isAny())).returns(() => {
            return Promise.resolve(generateCells(undefined, 'a=1', 'bar.py', 0, false, uuid()));
        });

        when(applicationShell.showSaveDialog(argThat(o => o.saveLabel && o.saveLabel.includes('Export')))).thenReturn(Promise.resolve(Uri.file('foo')));
        when(applicationShell.showInformationMessage(anything(), anything())).thenReturn(Promise.resolve('moo'));

        await commandManager.executeCommand(Commands.ExportFileAndOutputAsNotebook, Uri.file('bar.ipynb'));
        assert.ok(lastFileContents, 'Export file was not written to');
    });
    test('Export skipped on no file', async () => {
        createCommandListener();
        when(applicationShell.showSaveDialog(argThat(o => o.saveLabel && o.saveLabel.includes('Export')))).thenReturn(Promise.resolve(Uri.file('foo')));
        await commandManager.executeCommand(Commands.ExportFileAndOutputAsNotebook, Uri.file('bar.ipynb'));
        assert.notExists(lastFileContents, 'Export file was written to');
    });
    test('Export happens on no file', async () => {
        createCommandListener();
        const doc = await documentManager.openTextDocument('bar.ipynb');
        await documentManager.showTextDocument(doc);
        when(applicationShell.showSaveDialog(argThat(o => o.saveLabel && o.saveLabel.includes('Export')))).thenReturn(Promise.resolve(Uri.file('foo')));
        await commandManager.executeCommand(Commands.ExportFileAsNotebook, undefined, undefined);
        assert.ok(lastFileContents, 'Export file was not written to');
    });

});
