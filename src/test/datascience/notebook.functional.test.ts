// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { nbformat } from '@jupyterlab/coreutils';
import { assert } from 'chai';
import { ChildProcess } from 'child_process';
import * as fs from 'fs-extra';
import { injectable } from 'inversify';
import * as os from 'os';
import * as path from 'path';
import { Readable, Writable } from 'stream';
import * as uuid from 'uuid/v4';
import { Disposable, Uri } from 'vscode';
import { CancellationToken, CancellationTokenSource } from 'vscode-jsonrpc';

import { Cancellation, CancellationError } from '../../client/common/cancellation';
import { EXTENSION_ROOT_DIR } from '../../client/common/constants';
import { traceError, traceInfo } from '../../client/common/logger';
import { IFileSystem } from '../../client/common/platform/types';
import { IProcessServiceFactory, Output } from '../../client/common/process/types';
import { createDeferred, waitForPromise } from '../../client/common/utils/async';
import { noop } from '../../client/common/utils/misc';
import { concatMultilineString } from '../../client/datascience/common';
import { JupyterExecutionFactory } from '../../client/datascience/jupyter/jupyterExecutionFactory';
import { JupyterKernelPromiseFailedError } from '../../client/datascience/jupyter/jupyterKernelPromiseFailedError';
import {
    CellState,
    ICell,
    IConnection,
    IJupyterExecution,
    IJupyterKernelSpec,
    INotebookExecutionLogger,
    INotebookExporter,
    INotebookImporter,
    INotebookServer,
    InterruptResult
} from '../../client/datascience/types';
import {
    IInterpreterService,
    IKnownSearchPathsForInterpreters,
    PythonInterpreter
} from '../../client/interpreter/contracts';
import { ICellViewModel } from '../../datascience-ui/history-react/cell';
import { generateTestState } from '../../datascience-ui/history-react/mainPanelState';
import { asyncDump } from '../common/asyncDump';
import { sleep } from '../core';
import { DataScienceIocContainer } from './dataScienceIocContainer';
import { getConnectionInfo, getIPConnectionInfo, getNotebookCapableInterpreter } from './jupyterHelpers';

// tslint:disable:no-any no-multiline-string max-func-body-length no-console max-classes-per-file trailing-comma
suite('DataScience notebook tests', () => {
    const disposables: Disposable[] = [];
    let jupyterExecution: IJupyterExecution;
    let processFactory: IProcessServiceFactory;
    let ioc: DataScienceIocContainer;
    let modifiedConfig = false;

    setup(() => {
        ioc = new DataScienceIocContainer();
        ioc.registerDataScienceTypes();
        jupyterExecution = ioc.serviceManager.get<IJupyterExecution>(IJupyterExecution);
        processFactory = ioc.serviceManager.get<IProcessServiceFactory>(IProcessServiceFactory);
    });

    teardown(async () => {
        try {
            if (modifiedConfig) {
                traceInfo('Attempting to put jupyter default config back');
                const python = await getNotebookCapableInterpreter(ioc, processFactory);
                const procService = await processFactory.create();
                if (procService && python) {
                    await procService.exec(python.path, ['-m', 'jupyter', 'notebook', '--generate-config', '-y'], { env: process.env });
                }
            }
            traceInfo('Shutting down after test.');
            // tslint:disable-next-line:prefer-for-of
            for (let i = 0; i < disposables.length; i += 1) {
                const disposable = disposables[i];
                if (disposable) {
                    const promise = disposable.dispose() as Promise<any>;
                    if (promise) {
                        await promise;
                    }
                }
            }
            await ioc.dispose();
            traceInfo('Shutdown after test complete.');
        } catch (e) {
            traceError(e);
        }
    });

    suiteTeardown(() => {
        asyncDump();
    });

    function escapePath(p: string) {
        return p.replace(/\\/g, '\\\\');
    }

    function srcDirectory() {
        return path.join(EXTENSION_ROOT_DIR, 'src', 'test', 'datascience');
    }

    function extractDataOutput(cell: ICell): any {
        assert.equal(cell.data.cell_type, 'code', `Wrong type of cell returned`);
        const codeCell = cell.data as nbformat.ICodeCell;
        if (codeCell.outputs.length > 0) {
            assert.equal(codeCell.outputs.length, 1, 'Cell length not correct');
            const data = codeCell.outputs[0].data;
            const error = codeCell.outputs[0].evalue;
            if (error) {
                assert.fail(`Unexpected error: ${error}`);
            }
            assert.ok(data, `No data object on the cell`);
            if (data) { // For linter
                assert.ok(data.hasOwnProperty('text/plain'), `Cell mime type not correct`);
                assert.ok((data as any)['text/plain'], `Cell mime type not correct`);
                return (data as any)['text/plain'];
            }
        }
    }

    async function verifySimple(jupyterServer: INotebookServer | undefined, code: string, expectedValue: any): Promise<void> {
        const cells = await jupyterServer!.execute(code, path.join(srcDirectory(), 'foo.py'), 2, uuid());
        assert.equal(cells.length, 1, `Wrong number of cells returned`);
        const data = extractDataOutput(cells[0]);
        assert.equal(data, expectedValue, 'Cell value does not match');
    }

    async function verifyError(jupyterServer: INotebookServer | undefined, code: string, errorString: string): Promise<void> {
        const cells = await jupyterServer!.execute(code, path.join(srcDirectory(), 'foo.py'), 2, uuid());
        assert.equal(cells.length, 1, `Wrong number of cells returned`);
        assert.equal(cells[0].data.cell_type, 'code', `Wrong type of cell returned`);
        const cell = cells[0].data as nbformat.ICodeCell;
        assert.equal(cell.outputs.length, 1, `Cell length not correct`);
        const error = cell.outputs[0].evalue;
        if (error) {
            assert.ok(error, 'Error not found when expected');
            assert.equal(error, errorString, 'Unexpected error found');
        }
    }

    async function verifyCell(jupyterServer: INotebookServer | undefined, index: number, code: string, mimeType: string, cellType: string, verifyValue: (data: any) => void): Promise<void> {
        // Verify results of an execute
        const cells = await jupyterServer!.execute(code, path.join(srcDirectory(), 'foo.py'), 2, uuid());
        assert.equal(cells.length, 1, `${index}: Wrong number of cells returned`);
        if (cellType === 'code') {
            assert.equal(cells[0].data.cell_type, cellType, `${index}: Wrong type of cell returned`);
            const cell = cells[0].data as nbformat.ICodeCell;
            assert.equal(cell.outputs.length, 1, `${index}: Cell length not correct`);
            const error = cell.outputs[0].evalue;
            if (error) {
                assert.ok(false, `${index}: Unexpected error: ${error}`);
            }
            const data = cell.outputs[0].data;
            const text = cell.outputs[0].text;
            assert.ok(data || text, `${index}: No data object on the cell for ${code}`);
            if (data) { // For linter
                assert.ok(data.hasOwnProperty(mimeType), `${index}: Cell mime type not correct for ${JSON.stringify(data)}`);
                assert.ok((data as any)[mimeType], `${index}: Cell mime type not correct`);
                verifyValue((data as any)[mimeType]);
            }
            if (text) {
                verifyValue(text);
            }
        } else if (cellType === 'markdown') {
            assert.equal(cells[0].data.cell_type, cellType, `${index}: Wrong type of cell returned`);
            const cell = cells[0].data as nbformat.IMarkdownCell;
            const outputSource = concatMultilineString(cell.source);
            verifyValue(outputSource);
        } else if (cellType === 'error') {
            const cell = cells[0].data as nbformat.ICodeCell;
            assert.equal(cell.outputs.length, 1, `${index}: Cell length not correct`);
            const error = cell.outputs[0].evalue;
            assert.ok(error, 'Error not found when expected');
            verifyValue(error);
        }
    }

    function testMimeTypes(types: { markdownRegEx: string | undefined; code: string; mimeType: string; result: any; cellType: string; verifyValue(data: any): void }[]) {
        runTest('MimeTypes', async () => {
            // Prefill with the output (This is only necessary for mocking)
            types.forEach(t => {
                addMockData(t.code, t.result, t.mimeType, t.cellType);
            });

            // Test all mime types together so we don't have to startup and shutdown between
            // each
            const server = await createNotebookServer(true);
            if (server) {
                for (let i = 0; i < types.length; i += 1) {
                    const markdownRegex = types[i].markdownRegEx ? types[i].markdownRegEx : '';
                    ioc.getSettings().datascience.markdownRegularExpression = markdownRegex!;
                    await verifyCell(server, i, types[i].code, types[i].mimeType, types[i].cellType, types[i].verifyValue);
                }
            }
        });
    }

    function runTest(name: string, func: () => Promise<void>, _notebookProc?: ChildProcess) {
        test(name, async () => {
            console.log(`Starting test ${name} ...`);
            if (await jupyterExecution.isNotebookSupported()) {
                return func();
            } else {
                // tslint:disable-next-line:no-console
                console.log(`Skipping test ${name}, no jupyter installed.`);
            }
        });
    }

    async function createNotebookServer(useDefaultConfig: boolean, expectFailure?: boolean, usingDarkTheme?: boolean, purpose?: string): Promise<INotebookServer | undefined> {
        // Catch exceptions. Throw a specific assertion if the promise fails
        try {
            const testDir = path.join(EXTENSION_ROOT_DIR, 'src', 'test', 'datascience');
            const server = await jupyterExecution.connectToNotebookServer({ usingDarkTheme, useDefaultConfig, workingDir: testDir, purpose: purpose ? purpose : '1' });
            if (expectFailure) {
                assert.ok(false, `Expected server to not be created`);
            }
            return server;
        } catch (exc) {
            if (!expectFailure) {
                assert.ok(false, `Expected server to be created, but got ${exc}`);
            }
        }
    }

    function addMockData(code: string, result: string | number, mimeType?: string, cellType?: string) {
        if (ioc.mockJupyter) {
            if (cellType && cellType === 'error') {
                ioc.mockJupyter.addError(code, result.toString());
            } else {
                ioc.mockJupyter.addCell(code, result, mimeType);
            }
        }
    }

    function addInterruptableMockData(code: string, resultGenerator: (c: CancellationToken) => Promise<{ result: string; haveMore: boolean }>) {
        if (ioc.mockJupyter) {
            ioc.mockJupyter.addContinuousOutputCell(code, resultGenerator);
        }
    }

    runTest('Remote Self Certs', async () => {
        const python = await getNotebookCapableInterpreter(ioc, processFactory);
        const procService = await processFactory.create();

        // We will only connect if we allow for self signed cert connections
        ioc.getSettings().datascience.allowUnauthorizedRemoteConnection = true;

        if (procService && python) {
            const connectionFound = createDeferred();
            const configFile = path.join(EXTENSION_ROOT_DIR, 'src', 'test', 'datascience', 'serverConfigFiles', 'selfCert.py');
            const pemFile = path.join(EXTENSION_ROOT_DIR, 'src', 'test', 'datascience', 'serverConfigFiles', 'jcert.pem');
            const keyFile = path.join(EXTENSION_ROOT_DIR, 'src', 'test', 'datascience', 'serverConfigFiles', 'jkey.key');

            const exeResult = procService.execObservable(python.path, ['-m', 'jupyter', 'notebook', `--config=${configFile}`, `--certfile=${pemFile}`, `--keyfile=${keyFile}`], { env: process.env, throwOnStdErr: false });
            disposables.push(exeResult);

            exeResult.out.subscribe((output: Output<string>) => {
                const connectionURL = getIPConnectionInfo(output.out);
                if (connectionURL) {
                    connectionFound.resolve(connectionURL);
                }
            });

            const connString = await connectionFound.promise;
            const uri = connString as string;

            // We have a connection string here, so try to connect jupyterExecution to the notebook server
            const server = await jupyterExecution.connectToNotebookServer({ uri, useDefaultConfig: true, purpose: '' });
            if (!server) {
                assert.fail('Failed to connect to remote self cert server');
            } else {
                await verifySimple(server, `a=1${os.EOL}a`, 1);
            }
            // Have to dispose here otherwise the process may exit before hand and mess up cleanup.
            await server!.dispose();
        }
    });

    runTest('Remote Password', async () => {
        const python = await getNotebookCapableInterpreter(ioc, processFactory);
        const procService = await processFactory.create();

        if (procService && python) {
            const connectionFound = createDeferred();
            const configFile = path.join(EXTENSION_ROOT_DIR, 'src', 'test', 'datascience', 'serverConfigFiles', 'remotePassword.py');
            const exeResult = procService.execObservable(python.path, ['-m', 'jupyter', 'notebook', `--config=${configFile}`], { env: process.env, throwOnStdErr: false });
            disposables.push(exeResult);

            exeResult.out.subscribe((output: Output<string>) => {
                const connectionURL = getIPConnectionInfo(output.out);
                if (connectionURL) {
                    connectionFound.resolve(connectionURL);
                }
            });

            const connString = await connectionFound.promise;
            const uri = connString as string;

            // We have a connection string here, so try to connect jupyterExecution to the notebook server
            const server = await jupyterExecution.connectToNotebookServer({ uri, useDefaultConfig: true, purpose: '' });
            if (!server) {
                assert.fail('Failed to connect to remote password server');
            } else {
                await verifySimple(server, `a=1${os.EOL}a`, 1);
            }
            // Have to dispose here otherwise the process may exit before hand and mess up cleanup.
            await server!.dispose();
        }
    });

    runTest('Remote', async () => {
        const python = await getNotebookCapableInterpreter(ioc, processFactory);
        const procService = await processFactory.create();

        if (procService && python) {
            const connectionFound = createDeferred();
            const configFile = path.join(EXTENSION_ROOT_DIR, 'src', 'test', 'datascience', 'serverConfigFiles', 'remoteToken.py');
            const exeResult = procService.execObservable(python.path, ['-m', 'jupyter', 'notebook', `--config=${configFile}`], { env: process.env, throwOnStdErr: false });
            disposables.push(exeResult);

            exeResult.out.subscribe((output: Output<string>) => {
                const connectionURL = getConnectionInfo(output.out);
                if (connectionURL) {
                    connectionFound.resolve(connectionURL);
                }
            });

            const connString = await connectionFound.promise;
            const uri = connString as string;

            // We have a connection string here, so try to connect jupyterExecution to the notebook server
            const server = await jupyterExecution.connectToNotebookServer({ uri, useDefaultConfig: true, purpose: '' });
            if (!server) {
                assert.fail('Failed to connect to remote server');
            } else {
                await verifySimple(server, `a=1${os.EOL}a`, 1);
            }

            // Have to dispose here otherwise the process may exit before hand and mess up cleanup.
            await server!.dispose();
        }
    });

    runTest('Creation', async () => {
        await createNotebookServer(true);
    });

    runTest('Failure', async () => {
        // Make a dummy class that will fail during launch
        class FailedProcess extends JupyterExecutionFactory {
            public isNotebookSupported = (): Promise<boolean> => {
                return Promise.resolve(false);
            }
        }
        ioc.serviceManager.rebind<IJupyterExecution>(IJupyterExecution, FailedProcess);
        jupyterExecution = ioc.serviceManager.get<IJupyterExecution>(IJupyterExecution);
        await createNotebookServer(true, true);
    });

    test('Not installed', async () => {
        // Rewire our data we use to search for processes
        class EmptyInterpreterService implements IInterpreterService {
            public get hasInterpreters(): Promise<boolean> {
                return Promise.resolve(true);
            }
            public onDidChangeInterpreter(_listener: (e: void) => any, _thisArgs?: any, _disposables?: Disposable[]): Disposable {
                return { dispose: noop };
            }
            public onDidChangeInterpreterInformation(_listener: (e: PythonInterpreter) => any, _thisArgs?: any, _disposables?: Disposable[]): Disposable {
                return { dispose: noop };
            }
            public getInterpreters(_resource?: Uri): Promise<PythonInterpreter[]> {
                return Promise.resolve([]);
            }
            public autoSetInterpreter(): Promise<void> {
                throw new Error('Method not implemented');
            }
            public getActiveInterpreter(_resource?: Uri): Promise<PythonInterpreter | undefined> {
                return Promise.resolve(undefined);
            }
            public getInterpreterDetails(_pythonPath: string, _resoure?: Uri): Promise<PythonInterpreter> {
                throw new Error('Method not implemented');
            }
            public refresh(_resource: Uri): Promise<void> {
                throw new Error('Method not implemented');
            }
            public initialize(): void {
                throw new Error('Method not implemented');
            }
            public getDisplayName(_interpreter: Partial<PythonInterpreter>): Promise<string> {
                throw new Error('Method not implemented');
            }
            public shouldAutoSetInterpreter(): Promise<boolean> {
                throw new Error('Method not implemented');
            }
        }
        class EmptyPathService implements IKnownSearchPathsForInterpreters {
            public getSearchPaths(): string[] {
                return [];
            }
        }
        ioc.serviceManager.rebind<IInterpreterService>(IInterpreterService, EmptyInterpreterService);
        ioc.serviceManager.rebind<IKnownSearchPathsForInterpreters>(IKnownSearchPathsForInterpreters, EmptyPathService);
        jupyterExecution = ioc.serviceManager.get<IJupyterExecution>(IJupyterExecution);
        await createNotebookServer(true, true);
    });

    runTest('Export/Import', async () => {
        // Get a bunch of test cells (use our test cells from the react controls)
        const testFolderPath = path.join(EXTENSION_ROOT_DIR, 'src', 'test', 'datascience');
        const testState = generateTestState(_id => { return; }, testFolderPath);
        const cells = testState.cellVMs.map((cellVM: ICellViewModel, _index: number) => { return cellVM.cell; });

        // Translate this into a notebook
        const exporter = ioc.serviceManager.get<INotebookExporter>(INotebookExporter);
        const newFolderPath = path.join(EXTENSION_ROOT_DIR, 'src', 'test', 'datascience', 'WorkspaceDir', 'WorkspaceSubDir', 'foo.ipynb');
        const notebook = await exporter.translateToNotebook(cells, newFolderPath);
        assert.ok(notebook, 'Translate to notebook is failing');

        // Make sure we added in our chdir
        if (notebook) {
            // tslint:disable-next-line:no-string-literal
            const nbcells = notebook['cells'];
            if (nbcells) {
                // tslint:disable-next-line:no-string-literal
                const firstCellText: string = (nbcells as any)[0]['source'] as string;
                assert.ok(firstCellText.includes('os.chdir'));
            }
        }

        // Save to a temp file
        const fileSystem = ioc.serviceManager.get<IFileSystem>(IFileSystem);
        const importer = ioc.serviceManager.get<INotebookImporter>(INotebookImporter);
        const temp = await fileSystem.createTemporaryFile('.ipynb');

        try {
            await fs.writeFile(temp.filePath, JSON.stringify(notebook), 'utf8');
            // Try importing this. This should verify export works and that importing is possible
            const results = await importer.importFromFile(temp.filePath);

            // Make sure we have a single chdir in our results
            const first = results.indexOf('os.chdir');
            assert.ok(first >= 0, 'No os.chdir in import');
            const second = results.indexOf('os.chdir', first + 1);
            assert.equal(second, -1, 'More than one chdir in the import. It should be skipped');

            // Make sure we have a cell in our results
            assert.ok(/#\s*%%/.test(results), 'No cells in returned import');
        } finally {
            importer.dispose();
            temp.dispose();
        }
    });

    runTest('Restart kernel', async () => {
        addMockData(`a=1${os.EOL}a`, 1);
        addMockData(`a+=1${os.EOL}a`, 2);
        addMockData(`a+=4${os.EOL}a`, 6);
        addMockData('a', `name 'a' is not defined`, 'error');

        const server = await createNotebookServer(true);

        // Setup some state and verify output is correct
        await verifySimple(server, `a=1${os.EOL}a`, 1);
        await verifySimple(server, `a+=1${os.EOL}a`, 2);
        await verifySimple(server, `a+=4${os.EOL}a`, 6);

        console.log('Waiting for idle');

        // In unit tests we have to wait for status idle before restarting. Unit tests
        // seem to be timing out if the restart throws any exceptions (even if they're caught)
        await server!.waitForIdle(10000);

        console.log('Restarting kernel');
        try {
            await server!.restartKernel(10000);

            console.log('Waiting for idle');
            await server!.waitForIdle(10000);

            console.log('Verifying restart');
            await verifyError(server, 'a', `name 'a' is not defined`);

        } catch (exc) {
            assert.ok(exc instanceof JupyterKernelPromiseFailedError, 'Restarting did not timeout correctly');
        }

    });

    class TaggedCancellationTokenSource extends CancellationTokenSource {
        public tag: string;
        constructor(tag: string) {
            super();
            this.tag = tag;
        }
    }

    async function testCancelableCall<T>(method: (t: CancellationToken) => Promise<T>, messageFormat: string, timeout: number): Promise<boolean> {
        const tokenSource = new TaggedCancellationTokenSource(messageFormat.format(timeout.toString()));
        let canceled = false;
        const disp = setTimeout((_s) => {
            canceled = true;
            tokenSource.cancel();
        }, timeout, tokenSource.tag);

        try {
            // tslint:disable-next-line:no-string-literal
            (tokenSource.token as any)['tag'] = messageFormat.format(timeout.toString());
            await method(tokenSource.token);
            // We might get here before the cancel finishes
            assert.ok(!canceled, messageFormat.format(timeout.toString()));
        } catch (exc) {
            // This should happen. This means it was canceled.
            assert.ok(exc instanceof CancellationError, `Non cancellation error found : ${exc.stack}`);
        } finally {
            clearTimeout(disp);
            tokenSource.dispose();
        }

        return true;
    }

    async function testCancelableMethod<T>(method: (t: CancellationToken) => Promise<T>, messageFormat: string, short?: boolean): Promise<boolean> {
        const timeouts = short ? [10, 20, 30, 100] : [100, 200, 300, 1000];
        // tslint:disable-next-line:prefer-for-of
        for (let i = 0; i < timeouts.length; i += 1) {
            await testCancelableCall(method, messageFormat, timeouts[i]);
        }

        return true;
    }

    runTest('Cancel execution', async () => {
        if (ioc.mockJupyter) {
            ioc.mockJupyter.setProcessDelay(2000);
            addMockData(`a=1${os.EOL}a`, 1);
        }

        // Try different timeouts, canceling after the timeout on each
        assert.ok(await testCancelableMethod((t: CancellationToken) => jupyterExecution.connectToNotebookServer(undefined, t), 'Cancel did not cancel start after {0}ms'));

        if (ioc.mockJupyter) {
            ioc.mockJupyter.setProcessDelay(undefined);
        }

        // Make sure doing normal start still works
        const nonCancelSource = new CancellationTokenSource();
        const server = await jupyterExecution.connectToNotebookServer(undefined, nonCancelSource.token);
        assert.ok(server, 'Server not found with a cancel token that does not cancel');

        // Make sure can run some code too
        await verifySimple(server, `a=1${os.EOL}a`, 1);

        if (ioc.mockJupyter) {
            ioc.mockJupyter.setProcessDelay(200);
        }

        // Force a settings changed so that all of the cached data is cleared
        ioc.forceSettingsChanged('/usr/bin/test3/python');

        assert.ok(await testCancelableMethod((t: CancellationToken) => jupyterExecution.getUsableJupyterPython(t), 'Cancel did not cancel getusable after {0}ms', true));
        assert.ok(await testCancelableMethod((t: CancellationToken) => jupyterExecution.isNotebookSupported(t), 'Cancel did not cancel isNotebook after {0}ms', true));
        assert.ok(await testCancelableMethod((t: CancellationToken) => jupyterExecution.isKernelCreateSupported(t), 'Cancel did not cancel isKernel after {0}ms', true));
        assert.ok(await testCancelableMethod((t: CancellationToken) => jupyterExecution.isImportSupported(t), 'Cancel did not cancel isImport after {0}ms', true));
    });

    async function interruptExecute(server: INotebookServer | undefined, code: string, interruptMs: number, sleepMs: number): Promise<InterruptResult> {
        let interrupted = false;
        let finishedBefore = false;
        const finishedPromise = createDeferred();
        let error;
        const observable = server!.executeObservable(code, 'foo.py', 0, uuid(), false);
        observable.subscribe(c => {
            if (c.length > 0 && c[0].state === CellState.error) {
                finishedBefore = !interrupted;
                finishedPromise.resolve();
            }
            if (c.length > 0 && c[0].state === CellState.finished) {
                finishedBefore = !interrupted;
                finishedPromise.resolve();
            }
        }, (err) => { error = err; finishedPromise.resolve(); }, () => finishedPromise.resolve());

        // Then interrupt
        interrupted = true;
        const result = await server!.interruptKernel(interruptMs);

        // Then we should get our finish unless there was a restart
        await waitForPromise(finishedPromise.promise, sleepMs);
        assert.equal(finishedBefore, false, 'Finished before the interruption');
        assert.equal(error, undefined, 'Error thrown during interrupt');
        assert.ok(finishedPromise.completed ||
            result === InterruptResult.TimedOut ||
            result === InterruptResult.Restarted,
            `Timed out before interrupt for result: ${result}: ${code}`);

        return result;
    }

    runTest('Interrupt kernel', async () => {
        const returnable =
            `import signal
import _thread
import time

keep_going = True
def handler(signum, frame):
  global keep_going
  print('signal')
  keep_going = False

signal.signal(signal.SIGINT, handler)

while keep_going:
  print(".")
  time.sleep(.1)`;
        const fourSecondSleep = `import time${os.EOL}time.sleep(4)${os.EOL}print("foo")`;
        const kill =
            `import signal
import time
import os

keep_going = True
def handler(signum, frame):
  global keep_going
  print('signal')
  os._exit(-2)

signal.signal(signal.SIGINT, handler)

while keep_going:
  print(".")
  time.sleep(.1)`;

        // Add to our mock each of these, with each one doing something specific.
        addInterruptableMockData(returnable, async (cancelToken: CancellationToken) => {
            // This one goes forever until a cancellation happens
            let haveMore = true;
            try {
                await Cancellation.race((_t) => sleep(100), cancelToken);
            } catch {
                haveMore = false;
            }
            return { result: '.', haveMore: haveMore };
        });
        addInterruptableMockData(fourSecondSleep, async (_cancelToken: CancellationToken) => {
            // This one sleeps for four seconds and then it's done.
            await sleep(4000);
            return { result: 'foo', haveMore: false };
        });
        addInterruptableMockData(kill, async (cancelToken: CancellationToken) => {
            // This one goes forever until a cancellation happens
            let haveMore = true;
            try {
                await Cancellation.race((_t) => sleep(100), cancelToken);
            } catch {
                haveMore = false;
            }
            return { result: '.', haveMore: haveMore };
        });

        const server = await createNotebookServer(true);

        // Give some time for the server to finish. Otherwise our first interrupt will
        // happen so fast, we'll interrupt startup.
        await sleep(100);

        // Try with something we can interrupt
        await interruptExecute(server, returnable, 1000, 1000);

        // Try again with something that doesn't return. However it should finish before
        // we get to our own sleep. Note: We need the print so that the test knows something happened.
        await interruptExecute(server, fourSecondSleep, 7000, 7000);

        // Try again with something that doesn't return. Make sure it times out
        await interruptExecute(server, fourSecondSleep, 100, 7000);

        // The tough one, somethign that causes a kernel reset.
        await interruptExecute(server, kill, 1000, 1000);
    });

    testMimeTypes(
        [
            {
                markdownRegEx: undefined,
                code:
                    `a=1
a`,
                mimeType: 'text/plain',
                cellType: 'code',
                result: 1,
                verifyValue: (d) => assert.equal(d, 1, 'Plain text invalid')
            },
            {
                markdownRegEx: undefined,
                code:
                    `import pandas as pd
df = pd.read("${escapePath(path.join(srcDirectory(), 'DefaultSalesReport.csv'))}")
df.head()`,
                mimeType: 'text/html',
                result: `pd has no attribute 'read'`,
                cellType: 'error',
                // tslint:disable-next-line:quotemark
                verifyValue: (d) => assert.ok((d as string).includes("has no attribute 'read'"), 'Unexpected error result')
            },
            {
                markdownRegEx: undefined,
                code:
                    `import pandas as pd
df = pd.read_csv("${escapePath(path.join(srcDirectory(), 'DefaultSalesReport.csv'))}")
df.head()`,
                mimeType: 'text/html',
                result: `<td>A table</td>`,
                cellType: 'code',
                verifyValue: (d) => assert.ok(d.toString().includes('</td>'), 'Table not found')
            },
            {
                markdownRegEx: undefined,
                code:
                    `#%% [markdown]#
# #HEADER`,
                mimeType: 'text/plain',
                cellType: 'markdown',
                result: '#HEADER',
                verifyValue: (d) => assert.equal(d, '#HEADER', 'Markdown incorrect')
            },
            {
                markdownRegEx: '\\s*#\\s*<markdowncell>',
                code:
                    `# <markdowncell>
# #HEADER`,
                mimeType: 'text/plain',
                cellType: 'markdown',
                result: '#HEADER',
                verifyValue: (d) => assert.equal(d, '#HEADER', 'Markdown incorrect')
            },
            {
                // Test relative directories too.
                markdownRegEx: undefined,
                code:
                    `import pandas as pd
df = pd.read_csv("./DefaultSalesReport.csv")
df.head()`,
                mimeType: 'text/html',
                cellType: 'code',
                result: `<td>A table</td>`,
                verifyValue: (d) => assert.ok(d.toString().includes('</td>'), 'Table not found')
            },
            {
                // Important to test as multiline cell magics only work if they are the first item in the cell
                markdownRegEx: undefined,
                code:
                    `#%%
%%bash
echo 'hello'`,
                mimeType: 'text/plain',
                cellType: 'code',
                result: 'hello',
                verifyValue: (d) => assert.ok(d.includes('hello') || d.includes('bash'), `Multiline cell magic incorrect - ${d}`)
            },
            {
                // Test shell command should work on PC / Mac / Linux
                markdownRegEx: undefined,
                code:
                    `!echo world`,
                mimeType: 'text/plain',
                cellType: 'code',
                result: 'world',
                verifyValue: (d) => assert.ok(d.includes('world'), 'Cell command incorrect')
            },
            {
                // Plotly
                markdownRegEx: undefined,
                code:
                    `import matplotlib.pyplot as plt
import matplotlib as mpl
import numpy as np
import pandas as pd
x = np.linspace(0, 20, 100)
plt.plot(x, np.sin(x))
plt.show()`,
                result: `00000`,
                mimeType: 'image/svg+xml',
                cellType: 'code',
                verifyValue: (_d) => { return; }
            }
        ]
    );

    async function generateNonDefaultConfig() {
        const usable = await getNotebookCapableInterpreter(ioc, processFactory);
        assert.ok(usable, 'Cant find jupyter enabled python');

        // Manually generate an invalid jupyter config
        const procService = await processFactory.create();
        assert.ok(procService, 'Can not get a process service');
        const results = await procService!.exec(usable!.path, ['-m', 'jupyter', 'notebook', '--generate-config', '-y'], { env: process.env });

        // Results should have our path to the config.
        const match = /^.*\s+(.*jupyter_notebook_config.py)\s+.*$/m.exec(results.stdout);
        assert.ok(match && match !== null && match.length > 0, 'Jupyter is not outputting the path to the config');
        const configPath = match !== null ? match[1] : '';
        const filesystem = ioc.serviceContainer.get<IFileSystem>(IFileSystem);
        await filesystem.writeFile(configPath, 'c.NotebookApp.password_required = True'); // This should make jupyter fail
        modifiedConfig = true;
    }

    runTest('Non default config fails', async () => {
        if (!ioc.mockJupyter) {
            await generateNonDefaultConfig();
            try {
                await createNotebookServer(false);
                assert.fail('Should not be able to connect to notebook server with bad config');
            } catch {
                noop();
            }
        } else {
            // In the mock case, just make sure not using a config works
            await createNotebookServer(false);
        }
    });

    runTest('Non default config does not mess up default config', async () => {
        if (!ioc.mockJupyter) {
            await generateNonDefaultConfig();
            const server = await createNotebookServer(true);
            assert.ok(server, 'Never connected to a default server with a bad default config');

            await verifySimple(server, `a=1${os.EOL}a`, 1);
        }
    });

    runTest('Invalid kernel spec works', async () => {
        if (ioc.mockJupyter) {
            // Make a dummy class that will fail during launch
            class FailedKernelSpec extends JupyterExecutionFactory {
                protected async getMatchingKernelSpec(_connection?: IConnection, _cancelToken?: CancellationToken): Promise<IJupyterKernelSpec | undefined> {
                    return Promise.resolve(undefined);
                }
            }
            ioc.serviceManager.rebind<IJupyterExecution>(IJupyterExecution, FailedKernelSpec);
            jupyterExecution = ioc.serviceManager.get<IJupyterExecution>(IJupyterExecution);
            addMockData(`a=1${os.EOL}a`, 1);

            const server = await createNotebookServer(true);
            assert.ok(server, 'Empty kernel spec messes up creating a server');

            await verifySimple(server, `a=1${os.EOL}a`, 1);
        }
    });

    runTest('Server cache working', async () => {
        console.log('Staring server cache test');
        const s1 = await createNotebookServer(true, false, false, 'same');
        console.log('Creating s2');
        const s2 = await createNotebookServer(true, false, false, 'same');
        console.log('Testing s1 and s2, creating s3');
        assert.ok(s1 === s2, 'Two servers not the same when they should be');
        const s3 = await createNotebookServer(false, false, false, 'same');
        console.log('Testing s1 and s3, creating s4');
        assert.ok(s1 !== s3, 'Different config should create different server');
        const s4 = await createNotebookServer(true, false, false, 'different');
        console.log('Testing s1 and s4, creating s5');
        assert.ok(s1 !== s4, 'Different purpose should create different server');
        const s5 = await createNotebookServer(true, false, true, 'different');
        assert.ok(s4 === s5, 'Dark theme should be same server');
        console.log('Disposing of all');
        await s1!.dispose();
        await s3!.dispose();
        await s4!.dispose();
    });

    class DyingProcess implements ChildProcess {
        public stdin: Writable;
        public stdout: Readable;
        public stderr: Readable;
        public stdio: [Writable, Readable, Readable];
        public killed: boolean = false;
        public pid: number = 1;
        public connected: boolean = true;
        constructor(private timeout: number) {
            noop();
            this.stderr = this.stdout = new Readable();
            this.stdin = new Writable();
            this.stdio = [this.stdin, this.stdout, this.stderr];
        }
        public kill(_signal?: string): void {
            throw new Error('Method not implemented.');
        }
        public send(_message: any, _sendHandle?: any, _options?: any, _callback?: any): any {
            throw new Error('Method not implemented.');
        }
        public disconnect(): void {
            throw new Error('Method not implemented.');
        }
        public unref(): void {
            throw new Error('Method not implemented.');
        }
        public ref(): void {
            throw new Error('Method not implemented.');
        }
        public addListener(_event: any, _listener: any): this {
            throw new Error('Method not implemented.');
        }
        public emit(_event: any, _message?: any, _sendHandle?: any, ..._rest: any[]): any {
            throw new Error('Method not implemented.');
        }
        public on(event: any, listener: any): this {
            if (event === 'exit') {
                setTimeout(() => listener(2), this.timeout);
            }
            return this;
        }
        public once(_event: any, _listener: any): this {
            throw new Error('Method not implemented.');
        }
        public prependListener(_event: any, _listener: any): this {
            throw new Error('Method not implemented.');
        }
        public prependOnceListener(_event: any, _listener: any): this {
            throw new Error('Method not implemented.');
        }
        public removeListener(_event: string | symbol, _listener: (...args: any[]) => void): this {
            return this;
        }
        public removeAllListeners(_event?: string | symbol): this {
            throw new Error('Method not implemented.');
        }
        public setMaxListeners(_n: number): this {
            throw new Error('Method not implemented.');
        }
        public getMaxListeners(): number {
            throw new Error('Method not implemented.');
        }
        public listeners(_event: string | symbol): Function[] {
            throw new Error('Method not implemented.');
        }
        public rawListeners(_event: string | symbol): Function[] {
            throw new Error('Method not implemented.');
        }
        public eventNames(): (string | symbol)[] {
            throw new Error('Method not implemented.');
        }
        public listenerCount(_type: string | symbol): number {
            throw new Error('Method not implemented.');
        }
    }

    runTest('Server death', async () => {
        if (ioc.mockJupyter) {
            // Only run this test for mocks. We need to mock the server dying.
            addMockData(`a=1${os.EOL}a`, 1);
            const server = await createNotebookServer(true);
            assert.ok(server, 'Server died before running');

            // Sleep for 100 ms so it crashes
            await sleep(100);

            try {
                await verifySimple(server, `a=1${os.EOL}a`, 1);
                assert.ok(false, 'Exception should have been thrown');
            } catch {
                noop();
            }

        }
    }, new DyingProcess(100));

    runTest('Execution logging', async () => {
        const cellInputs: string[] = [];
        const outputs: string[] = [];
        @injectable()
        class Logger implements INotebookExecutionLogger {
            public async preExecute(cell: ICell, _silent: boolean): Promise<void> {
                cellInputs.push(concatMultilineString(cell.data.source));
            }
            public async postExecute(cell: ICell, _silent: boolean): Promise<void> {
                outputs.push(extractDataOutput(cell));
            }
        }
        ioc.serviceManager.add<INotebookExecutionLogger>(INotebookExecutionLogger, Logger);
        addMockData(`a=1${os.EOL}a`, 1);
        const server = await createNotebookServer(true);
        assert.ok(server, 'Server not created in logging case');
        await server!.execute(`a=1${os.EOL}a`, path.join(srcDirectory(), 'foo.py'), 2, uuid());
        assert.equal(cellInputs.length, 3, 'Not enough cell inputs');
        assert.ok(outputs.length >= 1, 'Not enough cell outputs');
        assert.equal(cellInputs[2], 'a=1\na', 'Cell inputs not captured');
        assert.equal(outputs[outputs.length - 1], '1', 'Cell outputs not captured');
    });

});
