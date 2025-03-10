// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { inject, injectable } from 'inversify';
import { CodeLens, Position, Range, Selection, TextDocument, TextEditor, TextEditorRevealType } from 'vscode';

import { IDocumentManager } from '../../common/application/types';
import { IFileSystem } from '../../common/platform/types';
import { IConfigurationService, IDataScienceSettings } from '../../common/types';
// import * as localize from '../../common/utils/localize';
import { StopWatch } from '../../common/utils/stopWatch';
import { IServiceContainer } from '../../ioc/types';
import { captureTelemetry } from '../../telemetry';
import { ICodeExecutionHelper } from '../../terminals/types';
import { Commands, Telemetry } from '../constants';
// import { JupyterInstallError } from '../jupyter/jupyterInstallError';
// import { JupyterSelfCertsError } from '../jupyter/jupyterSelfCertsError';
import { ICodeLensFactory, ICodeWatcher, IDataScienceErrorHandler, IInteractiveWindowProvider } from '../types';

@injectable()
export class CodeWatcher implements ICodeWatcher {
    private document?: TextDocument;
    private version: number = -1;
    private fileName: string = '';
    private codeLenses: CodeLens[] = [];
    private cachedSettings: IDataScienceSettings | undefined;

    constructor(@inject(IInteractiveWindowProvider) private interactiveWindowProvider: IInteractiveWindowProvider,
        @inject(IFileSystem) private fileSystem: IFileSystem,
        @inject(IConfigurationService) private configService: IConfigurationService,
        @inject(IDocumentManager) private documentManager: IDocumentManager,
        @inject(ICodeExecutionHelper) private executionHelper: ICodeExecutionHelper,
        @inject(IDataScienceErrorHandler) protected dataScienceErrorHandler: IDataScienceErrorHandler,
        @inject(ICodeLensFactory) private codeLensFactory: ICodeLensFactory,
        @inject(IServiceContainer) protected serviceContainer: IServiceContainer
    ) {
    }

    public setDocument(document: TextDocument) {
        this.document = document;

        // Cache these, we don't want to pull an old version if the document is updated
        this.fileName = document.fileName;
        this.version = document.version;

        // Get document cells here. Make a copy of our settings.
        this.cachedSettings = JSON.parse(JSON.stringify(this.configService.getSettings().datascience));

        // Use the factory to generate our new code lenses.
        this.codeLenses = this.codeLensFactory.createCodeLenses(document);
    }

    public getFileName() {
        return this.fileName;
    }

    public getVersion() {
        return this.version;
    }

    public getCachedSettings(): IDataScienceSettings | undefined {
        return this.cachedSettings;
    }

    public getCodeLenses() {
        return this.codeLenses;
    }

    @captureTelemetry(Telemetry.DebugCurrentCell)
    public async debugCurrentCell() {
        if (!this.documentManager.activeTextEditor || !this.documentManager.activeTextEditor.document) {
            return Promise.resolve();
        }

        // Run the cell that matches the current cursor position.
        return this.runMatchingCell(this.documentManager.activeTextEditor.selection, false, true);
    }

    @captureTelemetry(Telemetry.RunAllCells)
    public async runAllCells() {
        // Run all of our code lenses, they should always be ordered in the file so we can just
        // run them one by one
        for (const lens of this.codeLenses) {
            // Make sure that we have the correct command (RunCell) lenses
            if (lens.command && lens.command.command === Commands.RunCell && lens.command.arguments && lens.command.arguments.length >= 5) {
                const range: Range = new Range(lens.command.arguments[1], lens.command.arguments[2], lens.command.arguments[3], lens.command.arguments[4]);
                if (this.document && range) {
                    const code = this.document.getText(range);

                    // Note: We do a get or create active before all addCode commands to make sure that we either have a history up already
                    // or if we do not we need to start it up as these commands are all expected to start a new history if needed
                    await this.addCode(code, this.getFileName(), range.start.line);
                }
            }
        }

        // If there are no codelenses, just run all of the code as a single cell
        if (this.codeLenses.length === 0) {
            return this.runFileInteractiveInternal();
        }
    }

    @captureTelemetry(Telemetry.RunFileInteractive)
    public async runFileInteractive() {
        return this.runFileInteractiveInternal();
    }

    // Run all cells up to the cell containing this start line and character
    @captureTelemetry(Telemetry.RunAllCellsAbove)
    public async runAllCellsAbove(stopLine: number, stopCharacter: number) {
        // Run our code lenses up to this point, lenses are created in order on document load
        // so we can rely on them being in linear order for this
        for (const lens of this.codeLenses) {
            const pastStop = (lens.range.start.line >= stopLine && lens.range.start.character >= stopCharacter);
            // Make sure we are dealing with run cell based code lenses in case more types are added later
            if (lens.command && lens.command.command === Commands.RunCell) {
                if (!pastStop && this.document) {
                    // We have a cell and we are not past or at the stop point
                    const code = this.document.getText(lens.range);
                    await this.addCode(code, this.getFileName(), lens.range.start.line);
                } else {
                    // If we get a cell past or at the stop point stop
                    break;
                }
            }
        }
    }

    @captureTelemetry(Telemetry.RunAllCellsAbove)
    public async runCellAndAllBelow(startLine: number, startCharacter: number) {
        // Run our code lenses from this point to the end, lenses are created in order on document load
        // so we can rely on them being in linear order for this
        for (const lens of this.codeLenses) {
            const pastStart = (lens.range.start.line >= startLine && lens.range.start.character >= startCharacter);
            // Make sure we are dealing with run cell based code lenses in case more types are added later
            if (lens.command && lens.command.command === Commands.RunCell) {
                if (pastStart && this.document) {
                    // We have a cell and we are not past or at the stop point
                    const code = this.document.getText(lens.range);
                    await this.addCode(code, this.getFileName(), lens.range.start.line);
                }
            }
        }
    }

    @captureTelemetry(Telemetry.RunSelectionOrLine)
    public async runSelectionOrLine(activeEditor: TextEditor | undefined) {
        if (this.document && activeEditor &&
            this.fileSystem.arePathsSame(activeEditor.document.fileName, this.document.fileName)) {
            // Get just the text of the selection or the current line if none
            const codeToExecute = await this.executionHelper.getSelectedTextToExecute(activeEditor);
            if (!codeToExecute) {
                return;
            }
            const normalizedCode = await this.executionHelper.normalizeLines(codeToExecute!);
            if (!normalizedCode || normalizedCode.trim().length === 0) {
                return;
            }
            await this.addCode(normalizedCode, this.getFileName(), activeEditor.selection.start.line, activeEditor);
        }
    }

    @captureTelemetry(Telemetry.RunToLine)
    public async runToLine(targetLine: number) {
        if (this.document && targetLine > 0) {
            const previousLine = this.document.lineAt(targetLine - 1);
            const code = this.document.getText(new Range(0, 0, previousLine.range.end.line, previousLine.range.end.character));

            if (code && code.trim().length) {
                await this.addCode(code, this.getFileName(), 0);
            }
        }
    }

    @captureTelemetry(Telemetry.RunFromLine)
    public async runFromLine(targetLine: number) {
        if (this.document && targetLine < this.document.lineCount) {
            const lastLine = this.document.lineAt(this.document.lineCount - 1);
            const code = this.document.getText(new Range(targetLine, 0, lastLine.range.end.line, lastLine.range.end.character));

            if (code && code.trim().length) {
                await this.addCode(code, this.getFileName(), targetLine);
            }
        }
    }

    @captureTelemetry(Telemetry.RunCell)
    public runCell(range: Range): Promise<void> {
        if (!this.documentManager.activeTextEditor || !this.documentManager.activeTextEditor.document) {
            return Promise.resolve();
        }

        // Run the cell clicked. Advance if the cursor is inside this cell and we're allowed to
        const advance = range.contains(this.documentManager.activeTextEditor.selection.start) && this.configService.getSettings().datascience.enableAutoMoveToNextCell;
        return this.runMatchingCell(range, advance);
    }

    @captureTelemetry(Telemetry.DebugCurrentCell)
    public debugCell(range: Range): Promise<void> {
        if (!this.documentManager.activeTextEditor || !this.documentManager.activeTextEditor.document) {
            return Promise.resolve();
        }

        // Debug the cell clicked.
        return this.runMatchingCell(range, false, true);
    }

    @captureTelemetry(Telemetry.RunCurrentCell)
    public runCurrentCell(): Promise<void> {
        if (!this.documentManager.activeTextEditor || !this.documentManager.activeTextEditor.document) {
            return Promise.resolve();
        }

        // Run the cell that matches the current cursor position.
        return this.runMatchingCell(this.documentManager.activeTextEditor.selection, false);
    }

    @captureTelemetry(Telemetry.RunCurrentCellAndAdvance)
    public async runCurrentCellAndAdvance() {
        if (!this.documentManager.activeTextEditor || !this.documentManager.activeTextEditor.document) {
            return;
        }

        // Run the cell that matches the current cursor position. Always advance
        return this.runMatchingCell(this.documentManager.activeTextEditor.selection, true);
    }

    public async addEmptyCellToBottom(): Promise<void> {
        const editor = this.documentManager.activeTextEditor;
        if (editor) {
            editor.edit((editBuilder) => {
                editBuilder.insert(new Position(editor.document.lineCount, 0), '\n\n#%%\n');
            });

            const newPosition = new Position(editor.document.lineCount + 3, 0); // +3 to account for the added spaces and to position after the new mark
            return this.advanceToRange(new Range(newPosition, newPosition));
        }
    }

    private async addCode(code: string, file: string, line: number, editor?: TextEditor, debug?: boolean): Promise<void> {
        try {
            const stopWatch = new StopWatch();
            const activeInteractiveWindow = await this.interactiveWindowProvider.getOrCreateActive();
            if (debug) {
                await activeInteractiveWindow.debugCode(code, file, line, editor, stopWatch);
            } else {
                await activeInteractiveWindow.addCode(code, file, line, editor, stopWatch);
            }
        } catch (err) {
            this.dataScienceErrorHandler.handleError(err);
        }
    }

    private async runMatchingCell(range: Range, advance?: boolean, debug?: boolean) {
        const currentRunCellLens = this.getCurrentCellLens(range.start);
        const nextRunCellLens = this.getNextCellLens(range.start);

        if (currentRunCellLens) {
            // Move the next cell if allowed.
            if (advance) {
                // Either use the next cell that we found, or add a new one into the document
                let nextRange: Range;
                if (!nextRunCellLens) {
                    nextRange = this.createNewCell(currentRunCellLens.range);
                } else {
                    nextRange = nextRunCellLens.range;
                }

                if (nextRange) {
                    this.advanceToRange(nextRange);
                }
            }

            // Run the cell after moving the selection
            if (this.document) {
                // Use that to get our code.
                const code = this.document.getText(currentRunCellLens.range);
                await this.addCode(code, this.getFileName(), range.start.line, this.documentManager.activeTextEditor, debug);
            }
        }
    }

    private getCurrentCellLens(pos: Position): CodeLens | undefined {
        return this.codeLenses.find(l => l.range.contains(pos) && l.command !== undefined && l.command.command === Commands.RunCell);
    }

    private getNextCellLens(pos: Position): CodeLens | undefined {
        const currentIndex = this.codeLenses.findIndex(l => l.range.contains(pos) && l.command !== undefined && l.command.command === Commands.RunCell);
        if (currentIndex >= 0) {
            return this.codeLenses.find((l: CodeLens, i: number) => l.command !== undefined && l.command.command === Commands.RunCell && i > currentIndex);
        }
        return undefined;
    }

    private async runFileInteractiveInternal() {
        if (this.document) {
            const code = this.document.getText();
            await this.addCode(code, this.getFileName(), 0);
        }
    }

    // User has picked run and advance on the last cell of a document
    // Create a new cell at the bottom and put their selection there, ready to type
    private createNewCell(currentRange: Range): Range {
        const editor = this.documentManager.activeTextEditor;
        const newPosition = new Position(currentRange.end.line + 3, 0); // +3 to account for the added spaces and to position after the new mark

        if (editor) {
            editor.edit((editBuilder) => {
                editBuilder.insert(new Position(currentRange.end.line + 1, 0), '\n\n#%%\n');
            });
        }

        return new Range(newPosition, newPosition);
    }

    // Advance the cursor to the selected range
    private advanceToRange(targetRange: Range) {
        const editor = this.documentManager.activeTextEditor;
        const newSelection = new Selection(targetRange.start, targetRange.start);
        if (editor) {
            editor.selection = newSelection;
            editor.revealRange(targetRange, TextEditorRevealType.Default);
        }
    }
}
