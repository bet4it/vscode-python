// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import '../../common/extensions';

import { inject, injectable } from 'inversify';
import * as uuid from 'uuid/v4';
import { Position, Range, TextDocument, Uri, ViewColumn } from 'vscode';
import { CancellationToken, CancellationTokenSource } from 'vscode-jsonrpc';

import { IApplicationShell, ICommandManager, IDocumentManager } from '../../common/application/types';
import { CancellationError } from '../../common/cancellation';
import { PYTHON_LANGUAGE } from '../../common/constants';
import { traceError } from '../../common/logger';
import { IFileSystem } from '../../common/platform/types';
import { IConfigurationService, IDisposableRegistry, ILogger } from '../../common/types';
import * as localize from '../../common/utils/localize';
import { captureTelemetry } from '../../telemetry';
import { CommandSource } from '../../testing/common/constants';
import { generateCellRanges, generateCellsFromDocument } from '../cellFactory';
import { Commands, Telemetry } from '../constants';
import { JupyterInstallError } from '../jupyter/jupyterInstallError';
import {
    IDataScienceCommandListener,
    IDataScienceErrorHandler,
    IInteractiveWindowProvider,
    IJupyterExecution,
    INotebookExporter,
    INotebookImporter,
    INotebookServer,
    IStatusProvider
} from '../types';

@injectable()
export class InteractiveWindowCommandListener implements IDataScienceCommandListener {
    constructor(
        @inject(IDisposableRegistry) private disposableRegistry: IDisposableRegistry,
        @inject(IInteractiveWindowProvider) private interactiveWindowProvider: IInteractiveWindowProvider,
        @inject(INotebookExporter) private jupyterExporter: INotebookExporter,
        @inject(IJupyterExecution) private jupyterExecution: IJupyterExecution,
        @inject(IDocumentManager) private documentManager: IDocumentManager,
        @inject(IApplicationShell) private applicationShell: IApplicationShell,
        @inject(IFileSystem) private fileSystem: IFileSystem,
        @inject(ILogger) private logger: ILogger,
        @inject(IConfigurationService) private configuration: IConfigurationService,
        @inject(IStatusProvider) private statusProvider: IStatusProvider,
        @inject(INotebookImporter) private jupyterImporter: INotebookImporter,
        @inject(IDataScienceErrorHandler) private dataScienceErrorHandler: IDataScienceErrorHandler
    ) {
        // Listen to document open commands. We want to ask the user if they want to import.
        const disposable = this.documentManager.onDidOpenTextDocument(this.onOpenedDocument);
        this.disposableRegistry.push(disposable);
    }

    public register(commandManager: ICommandManager): void {
        let disposable = commandManager.registerCommand(Commands.ShowHistoryPane, () => this.showInteractiveWindow());
        this.disposableRegistry.push(disposable);
        disposable = commandManager.registerCommand(Commands.ImportNotebook, (file?: Uri, _cmdSource: CommandSource = CommandSource.commandPalette) => {
            return this.listenForErrors(() => {
                if (file && file.fsPath) {
                    return this.importNotebookOnFile(file.fsPath, true);
                } else {
                    return this.importNotebook();
                }
            });
        });
        this.disposableRegistry.push(disposable);
        disposable = commandManager.registerCommand(Commands.ExportFileAsNotebook, (file?: Uri, _cmdSource: CommandSource = CommandSource.commandPalette) => {
            return this.listenForErrors(() => {
                if (file && file.fsPath) {
                    return this.exportFile(file.fsPath);
                } else {
                    const activeEditor = this.documentManager.activeTextEditor;
                    if (activeEditor && activeEditor.document.languageId === PYTHON_LANGUAGE) {
                        return this.exportFile(activeEditor.document.fileName);
                    }
                }

                return Promise.resolve();
            });
        });
        this.disposableRegistry.push(disposable);
        disposable = commandManager.registerCommand(Commands.ExportFileAndOutputAsNotebook, (file: Uri, _cmdSource: CommandSource = CommandSource.commandPalette) => {
            return this.listenForErrors(() => {
                if (file && file.fsPath) {
                    return this.exportFileAndOutput(file.fsPath);
                } else {
                    const activeEditor = this.documentManager.activeTextEditor;
                    if (activeEditor && activeEditor.document.languageId === PYTHON_LANGUAGE) {
                        return this.exportFileAndOutput(activeEditor.document.fileName);
                    }
                }
                return Promise.resolve();
            });
        });
        this.disposableRegistry.push(disposable);
        this.disposableRegistry.push(commandManager.registerCommand(Commands.UndoCells, () => this.undoCells()));
        this.disposableRegistry.push(commandManager.registerCommand(Commands.RedoCells, () => this.redoCells()));
        this.disposableRegistry.push(commandManager.registerCommand(Commands.RemoveAllCells, () => this.removeAllCells()));
        this.disposableRegistry.push(commandManager.registerCommand(Commands.InterruptKernel, () => this.interruptKernel()));
        this.disposableRegistry.push(commandManager.registerCommand(Commands.RestartKernel, () => this.restartKernel()));
        this.disposableRegistry.push(commandManager.registerCommand(Commands.ExpandAllCells, () => this.expandAllCells()));
        this.disposableRegistry.push(commandManager.registerCommand(Commands.CollapseAllCells, () => this.collapseAllCells()));
        this.disposableRegistry.push(commandManager.registerCommand(Commands.ExportOutputAsNotebook, () => this.exportCells()));
    }

    // tslint:disable:no-any
    private async listenForErrors(promise: () => Promise<any>): Promise<any> {
        let result: any;
        try {
            result = await promise();
            return result;
        } catch (err) {
            if (!(err instanceof CancellationError)) {
                if (err.message) {
                    this.logger.logError(err.message);
                    this.applicationShell.showErrorMessage(err.message);
                } else {
                    this.logger.logError(err.toString());
                    this.applicationShell.showErrorMessage(err.toString());
                }
            } else {
                this.logger.logInformation('Canceled');
            }
        }
        return result;
    }

    private showInformationMessage(message: string, question?: string): Thenable<string | undefined> {
        if (question) {
            return this.applicationShell.showInformationMessage(message, question);
        } else {
            return this.applicationShell.showInformationMessage(message);
        }
    }

    @captureTelemetry(Telemetry.ExportPythonFile, undefined, false)
    private async exportFile(file: string): Promise<void> {
        if (file && file.length > 0) {
            // If the current file is the active editor, then generate cells from the document.
            const activeEditor = this.documentManager.activeTextEditor;
            if (activeEditor && this.fileSystem.arePathsSame(activeEditor.document.fileName, file)) {
                const cells = generateCellsFromDocument(activeEditor.document, this.configuration.getSettings().datascience);
                if (cells) {
                    const filtersKey = localize.DataScience.exportDialogFilter();
                    const filtersObject: { [name: string]: string[] } = {};
                    filtersObject[filtersKey] = ['ipynb'];

                    // Bring up the save file dialog box
                    const uri = await this.applicationShell.showSaveDialog({
                        saveLabel: localize.DataScience.exportDialogTitle(),
                        filters: filtersObject
                    });

                    await this.waitForStatus(async () => {
                        if (uri) {
                            let directoryChange;
                            const settings = this.configuration.getSettings();
                            if (settings.datascience.changeDirOnImportExport) {
                                directoryChange = uri.fsPath;
                            }

                            const notebook = await this.jupyterExporter.translateToNotebook(cells, directoryChange);
                            await this.fileSystem.writeFile(uri.fsPath, JSON.stringify(notebook));
                        }
                    }, localize.DataScience.exportingFormat(), file);

                    // When all done, show a notice that it completed.
                    const openQuestion = (await this.jupyterExecution.isSpawnSupported()) ? localize.DataScience.exportOpenQuestion() : undefined;
                    if (uri && uri.fsPath) {
                        this.showInformationMessage(localize.DataScience.exportDialogComplete().format(uri.fsPath), openQuestion).then((str: string | undefined) => {
                            if (str === openQuestion) {
                                // If the user wants to, open the notebook they just generated.
                                this.jupyterExecution.spawnNotebook(uri.fsPath).ignoreErrors();
                            }
                        });
                    }
                }
            }
        }
    }

    @captureTelemetry(Telemetry.ExportPythonFileAndOutput, undefined, false)
    private async exportFileAndOutput(file: string): Promise<Uri | undefined> {
        if (file && file.length > 0 && this.jupyterExecution.isNotebookSupported()) {
            // If the current file is the active editor, then generate cells from the document.
            const activeEditor = this.documentManager.activeTextEditor;
            if (activeEditor && activeEditor.document && this.fileSystem.arePathsSame(activeEditor.document.fileName, file)) {
                const ranges = generateCellRanges(activeEditor.document);
                if (ranges.length > 0) {
                    // Ask user for path
                    const output = await this.showExportDialog();

                    // If that worked, we need to start a jupyter server to get our output values.
                    // In the future we could potentially only update changed cells.
                    if (output) {
                        // Create a cancellation source so we can cancel starting the jupyter server if necessary
                        const cancelSource = new CancellationTokenSource();

                        // Then wait with status that lets the user cancel
                        await this.waitForStatus(() => {
                            try {
                                return this.exportCellsWithOutput(ranges, activeEditor.document, output, cancelSource.token);
                            } catch (err) {
                                if (!(err instanceof CancellationError)) {
                                    this.showInformationMessage(localize.DataScience.exportDialogFailed().format(err));
                                }
                            }
                            return Promise.resolve();
                        }, localize.DataScience.exportingFormat(), file, () => {
                            cancelSource.cancel();
                        }, true);

                        // When all done, show a notice that it completed.
                        const openQuestion = (await this.jupyterExecution.isSpawnSupported()) ? localize.DataScience.exportOpenQuestion() : undefined;
                        this.showInformationMessage(localize.DataScience.exportDialogComplete().format(output), openQuestion).then((str: string | undefined) => {
                            if (str === openQuestion && output) {
                                // If the user wants to, open the notebook they just generated.
                                this.jupyterExecution.spawnNotebook(output).ignoreErrors();
                            }
                        });

                        return Uri.file(output);
                    }
                }
            }
        } else {
            this.dataScienceErrorHandler.handleError(
                new JupyterInstallError(localize.DataScience.jupyterNotSupported(), localize.DataScience.pythonInteractiveHelpLink()));
        }
    }

    private async exportCellsWithOutput(ranges: { range: Range; title: string }[], document: TextDocument, file: string, cancelToken: CancellationToken): Promise<void> {
        let server: INotebookServer | undefined;
        try {
            const settings = this.configuration.getSettings();
            const useDefaultConfig: boolean | undefined = settings.datascience.useDefaultConfigForJupyter;

            // Try starting a server. Purpose should be unique so we
            // create a brand new one.
            server = await this.jupyterExecution.connectToNotebookServer({ useDefaultConfig, purpose: uuid() }, cancelToken);

            // If that works, then execute all of the cells.
            const cells = Array.prototype.concat(... await Promise.all(ranges.map(r => {
                const code = document.getText(r.range);
                return server ? server.execute(code, document.fileName, r.range.start.line, uuid(), cancelToken) : [];
            })));

            // Then save them to the file
            let directoryChange;
            if (settings.datascience.changeDirOnImportExport) {
                directoryChange = file;
            }

            const notebook = await this.jupyterExporter.translateToNotebook(cells, directoryChange);
            await this.fileSystem.writeFile(file, JSON.stringify(notebook));

        } finally {
            if (server) {
                await server.dispose();
            }
        }
    }

    private async showExportDialog(): Promise<string | undefined> {
        const filtersKey = localize.DataScience.exportDialogFilter();
        const filtersObject: { [name: string]: string[] } = {};
        filtersObject[filtersKey] = ['ipynb'];

        // Bring up the save file dialog box
        const uri = await this.applicationShell.showSaveDialog({
            saveLabel: localize.DataScience.exportDialogTitle(),
            filters: filtersObject
        });

        return uri ? uri.fsPath : undefined;
    }

    private undoCells() {
        const interactiveWindow = this.interactiveWindowProvider.getActive();
        if (interactiveWindow) {
            interactiveWindow.undoCells();
        }
    }

    private redoCells() {
        const interactiveWindow = this.interactiveWindowProvider.getActive();
        if (interactiveWindow) {
            interactiveWindow.redoCells();
        }
    }

    private removeAllCells() {
        const interactiveWindow = this.interactiveWindowProvider.getActive();
        if (interactiveWindow) {
            interactiveWindow.removeAllCells();
        }
    }

    private interruptKernel() {
        const interactiveWindow = this.interactiveWindowProvider.getActive();
        if (interactiveWindow) {
            interactiveWindow.interruptKernel().ignoreErrors();
        }
    }

    private restartKernel() {
        const interactiveWindow = this.interactiveWindowProvider.getActive();
        if (interactiveWindow) {
            interactiveWindow.restartKernel().ignoreErrors();
        }
    }

    private expandAllCells() {
        const interactiveWindow = this.interactiveWindowProvider.getActive();
        if (interactiveWindow) {
            interactiveWindow.expandAllCells();
        }
    }

    private collapseAllCells() {
        const interactiveWindow = this.interactiveWindowProvider.getActive();
        if (interactiveWindow) {
            interactiveWindow.collapseAllCells();
        }
    }

    private exportCells() {
        const interactiveWindow = this.interactiveWindowProvider.getActive();
        if (interactiveWindow) {
            interactiveWindow.exportCells();
        }
    }

    private canImportFromOpenedFile = () => {
        const settings = this.configuration.getSettings();
        return settings && (!settings.datascience || settings.datascience.allowImportFromNotebook);
    }

    private autoPreviewNotebooks = () => {
        const settings = this.configuration.getSettings();
        return settings && (!settings.datascience || settings.datascience.autoPreviewNotebooksInInteractivePane);
    }

    private disableImportOnOpenedFile = () => {
        const settings = this.configuration.getSettings();
        if (settings && settings.datascience) {
            settings.datascience.allowImportFromNotebook = false;
        }
    }

    private onOpenedDocument = async (document: TextDocument) => {
        // Preview and import the document if necessary.
        const results = await Promise.all([this.previewNotebook(document.fileName), this.askForImportDocument(document)]);

        // When done, make sure the current document is still the active editor if we did
        // not do an import. Otherwise subsequent opens will cover up the interactive pane.
        if (!results[1] && results[0]) {
            this.documentManager.showTextDocument(document);
        }
    }

    private async previewNotebook(fileName: string): Promise<boolean> {
        if (fileName && fileName.endsWith('.ipynb') && this.autoPreviewNotebooks()) {
            // Get history before putting up status so that we show a busy message when we
            // start the preview.
            const interactiveWindow = await this.interactiveWindowProvider.getOrCreateActive();

            // Wait for the preview.
            await this.waitForStatus(async () => {
                await interactiveWindow.previewNotebook(fileName);
            }, localize.DataScience.previewStatusMessage(), fileName);

            return true;
        }

        return false;
    }

    private async askForImportDocument(document: TextDocument): Promise<boolean> {
        if (document.fileName.endsWith('.ipynb') && this.canImportFromOpenedFile()) {
            const yes = localize.DataScience.notebookCheckForImportYes();
            const no = localize.DataScience.notebookCheckForImportNo();
            const dontAskAgain = localize.DataScience.notebookCheckForImportDontAskAgain();

            const answer = await this.applicationShell.showInformationMessage(
                localize.DataScience.notebookCheckForImportTitle(),
                yes, no, dontAskAgain);

            try {
                if (answer === yes) {
                    await this.importNotebookOnFile(document.fileName, false);
                    return true;
                } else if (answer === dontAskAgain) {
                    this.disableImportOnOpenedFile();
                }
            } catch (err) {
                this.applicationShell.showErrorMessage(err);
            }
        }

        return false;
    }

    @captureTelemetry(Telemetry.ShowHistoryPane, undefined, false)
    private async showInteractiveWindow(): Promise<void> {
        const active = await this.interactiveWindowProvider.getOrCreateActive();
        return active.show();
    }

    private waitForStatus<T>(promise: () => Promise<T>, format: string, file?: string, canceled?: () => void, skipHistory?: boolean): Promise<T> {
        const message = file ? format.format(file) : format;
        return this.statusProvider.waitWithStatus(promise, message, undefined, canceled, skipHistory);
    }

    @captureTelemetry(Telemetry.ImportNotebook, { scope: 'command' }, false)
    private async importNotebook(): Promise<void> {
        const filtersKey = localize.DataScience.importDialogFilter();
        const filtersObject: { [name: string]: string[] } = {};
        filtersObject[filtersKey] = ['ipynb'];

        const uris = await this.applicationShell.showOpenDialog(
            {
                openLabel: localize.DataScience.importDialogTitle(),
                filters: filtersObject
            });

        if (uris && uris.length > 0) {
            // Preview a file whenever we import
            this.previewNotebook(uris[0].fsPath).catch(traceError);

            // Don't call the other overload as we'll end up with double telemetry.
            await this.waitForStatus(async () => {
                const contents = await this.jupyterImporter.importFromFile(uris[0].fsPath);
                await this.viewDocument(contents);
            }, localize.DataScience.importingFormat(), uris[0].fsPath);
        }
    }

    @captureTelemetry(Telemetry.ImportNotebook, { scope: 'file' }, false)
    private async importNotebookOnFile(file: string, preview: boolean): Promise<void> {
        if (file && file.length > 0) {
            // Preview a file whenever we import if not already previewed
            if (preview) {
                this.previewNotebook(file).catch(traceError);
            }

            await this.waitForStatus(async () => {
                const contents = await this.jupyterImporter.importFromFile(file);
                await this.viewDocument(contents);
            }, localize.DataScience.importingFormat(), file);
        }
    }

    private viewDocument = async (contents: string): Promise<void> => {
        const doc = await this.documentManager.openTextDocument({ language: 'python', content: contents });
        const editor = await this.documentManager.showTextDocument(doc, ViewColumn.One);

        // Edit the document so that it is dirty (add a space at the end)
        editor.edit((editBuilder) => {
            editBuilder.insert(new Position(editor.document.lineCount, 0), '\n');
        });

    }
}
